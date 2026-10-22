import {
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Scene,
  Vector3,
  WebGLRenderer,
  type Matrix4,
} from 'three';
import { CarAudio } from './audio';
import { ChaseCamera, wrapAngle } from './camera';
import { CarModel } from './car/carModel';
import { TyreEffects, type WheelSample } from './car/effects';
import { CarPhysics, type CarInput } from './car/physics';
import { CAMERA, DRIVETRAIN, PHYSICS, SCORING } from './config';
import { DebugTools } from './debug/tools';
import { InputManager } from './input';
import { DriftScore } from './scoring';
import type { Hud } from './ui';
import { Collider } from './world/collider';
import { PracticeWorld } from './world/practiceWorld';
import { TilesWorld } from './world/tilesWorld';
import type { World } from './world/types';

type Phase = 'idle' | 'locating' | 'driving' | 'paused';

interface Crumb {
  pos: Vector3;
  heading: number;
  t: number;
}

const DOWN = new Vector3(0, -1, 0);
const LOCATE_START_DISTANCE = 2600;
const LOCATE_TIMEOUT = 30;
/** Camera pitch while high in the fly-in. */
const LOCATE_PITCH = 84 * (Math.PI / 180);
/** Camera target height until real ground is found: above all but the highest peaks. */
const LOCATE_START_HEIGHT = 6000;
/** Spawn this long after arriving even if tiles are still streaming (dense cities never go quiet). */
const LOCATE_MAX_SETTLE = 3;
/** Tiles coarser than this (metres of geometric error) can be far off the real surface. */
const FINE_TILE_ERROR = 1000;

/** Exact spawn for deep links and repro links. */
export interface SpawnOptions {
  /** Spawn on the walkable surface closest to this world height (ellipsoidal, m). */
  height?: number;
  /** Initial forward speed. */
  kmh?: number;
}

export interface GameCallbacks {
  onFatal(message: string): void;
  onPause(): void;
  /** Resume requested from inside the game (gamepad Start); the menu should close. */
  onResume(): void;
  /** Menu requested while not driving (e.g. during the fly-in). */
  onMenu(): void;
}

export class Game {
  readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly chase: ChaseCamera;
  private readonly car = new CarModel();
  private readonly effects = new TyreEffects();
  private readonly physics: CarPhysics;
  readonly debug: DebugTools;
  private readonly score = new DriftScore();
  private readonly audio = new CarAudio();
  private readonly input: InputManager;
  private world: World | null = null;
  private collider: Collider | null = null;
  private phase: Phase = 'idle';
  private acc = 0;
  private time = 0;
  private last = performance.now();
  private crumbs: Crumb[] = [];
  private crumbTimer = 0;
  private stuckTime = 0;
  private readonly stuckRef = { pos: new Vector3(), t: 0 };
  private airTime = 0;
  private takeoff: { y: number; t: number } | null = null;
  /** Set after a big fall: no crumbs below this height until it expires, so R goes back up. */
  private fallGuard: { y: number; until: number } | null = null;
  private spawnPos = new Vector3();
  private spawnHeading = 0;
  private locate = {
    t: 0,
    groundY: null as number | null,
    /** Finest surface hit under the origin so far, however coarse its tile. */
    surfaceY: null as number | null,
    camY: LOCATE_START_HEIGHT,
    settle: 0,
    arrivedT: 0,
    name: '',
    top: false,
    opts: {} as SpawnOptions,
  };
  private fps = 60;
  private steerShown = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly hud: Hud,
    private readonly cb: GameCallbacks,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    this.chase = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.scene.background = new Color(0x0b0e13);
    this.scene.add(new HemisphereLight(0xdfe9ff, 0x3a3328, 1.6));
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(0.4, 1, 0.25);
    this.scene.add(sun, this.car.root, this.effects.root);
    this.car.root.visible = false;

    this.physics = new CarPhysics({
      onImpact: (v) => {
        this.chase.addShake(v / 12);
        this.audio.impact(v);
        this.input.rumble(v / 15);
        this.debug.event('impact', { v });
      },
      onLand: (v) => {
        if (v > 3) this.chase.addShake(v / 20);
        this.debug.event('land', { v });
      },
      onOverpass: (d) => this.debug.onOverpass(d),
    });
    this.debug = new DebugTools(
      {
        physics: this.physics,
        renderer: this.renderer,
        world: () => this.world,
        collider: () => this.collider,
        phase: () => this.phase,
        statsText: () => this.debugText(),
      },
      this.scene,
    );
    this.score.onBank = (pts) => this.hud.toast(`+${pts.toLocaleString('en-US')}`, 'good');
    this.score.onFail = (lost) => this.hud.toast(`Crashed! −${lost.toLocaleString('en-US')}`, 'bad');

    this.input = new InputManager(document.getElementById('touch')!);
    this.hud.bindGearbox((kind) => (this.input.shiftQueue[kind] = true));
    // Browsers only allow audio after a gesture; the default spot auto-starts without one.
    const unlock = () => {
      if (this.phase === 'driving') this.audio.start();
    };
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('resize', () => this.onResize());
    // Rendering stops in background tabs but audio would keep droning.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      this.pause();
      this.audio.suspend();
    });
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.chase.camera.aspect = w / h;
    this.chase.camera.updateProjectionMatrix();
  }

  /** Starts driving at a real-world location (degrees). */
  startTiles(apiKey: string, lat: number, lon: number, bearing: number, name: string, top = false, opts: SpawnOptions = {}): void {
    const world = new TilesWorld({ apiKey, lat, lon, camera: this.chase.camera, renderer: this.renderer });
    this.setWorld(world);
    this.debug.event('start', { lat, lon, bearing, name, top, ...opts });
    this.spawnHeading = -bearing * MathUtils.DEG2RAD;
    this.locate = { t: 0, groundY: null, surfaceY: null, camY: LOCATE_START_HEIGHT, settle: 0, arrivedT: 0, name, top, opts };
    this.phase = 'locating';
    this.chase.snap(new Vector3(0, LOCATE_START_HEIGHT, 0), this.spawnHeading, LOCATE_START_DISTANCE, LOCATE_PITCH);
    this.hud.setGoogleBranding(true);
    this.hud.showLoading(`Flying to ${name}…`, 0);
    this.hud.show(false);
  }

  startPractice(): void {
    this.setWorld(new PracticeWorld());
    this.hud.setGoogleBranding(false);
    this.spawnHeading = 0;
    this.spawn(new Vector3(0, 0, 40), 0);
  }

  private setWorld(world: World): void {
    if (this.world) {
      this.scene.remove(this.world.root);
      this.world.dispose();
    }
    this.world = world;
    this.collider = new Collider(world);
    this.scene.add(world.root);
    this.debug.onWorld(world);
    this.car.root.visible = false;
    this.effects.clear();
    this.crumbs = [];
    this.physics.vel.set(0, 0, 0);
    this.score.newRun();
  }

  private spawn(pos: Vector3, heading: number, kmh = 0): void {
    this.spawnPos.copy(pos);
    this.spawnHeading = heading;
    this.physics.reset(pos, heading);
    if (kmh) this.physics.launch(kmh / 3.6);
    this.debug.event('spawn', { pos: pos.toArray(), heading, kmh, geo: this.world?.geo(pos) ?? null });
    this.chase.snap(pos, heading, CAMERA.distance);
    this.car.root.visible = true;
    this.effects.liftAll();
    this.crumbs = [];
    this.takeoff = this.fallGuard = null;
    this.stuckRef.pos.copy(pos);
    this.stuckRef.t = this.time;
    this.phase = 'driving';
    this.hud.showLoading(null);
    this.hud.show(true);
    this.audio.start();
  }

  pause(): void {
    if (this.phase !== 'driving') return;
    this.phase = 'paused';
    this.audio.update(0, 0, 0, false);
    this.debug.event('pause');
    this.cb.onPause();
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'driving';
    this.debug.event('resume');
    this.last = performance.now();
    this.input.flush();
    this.audio.start();
  }

  respawnHere(): void {
    if (this.phase === 'paused') this.resume();
    this.resetToCrumb(0);
  }

  get canResume(): boolean {
    return this.phase === 'paused';
  }

  // --- Frame ---------------------------------------------------------------

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;

    const { car: inp, actions } = this.input.poll();
    if (actions.debug) this.debug.toggle();
    if (actions.mark) this.debug.mark();
    if (actions.saveTrace) void this.debug.save();
    if (actions.mute) this.audio.toggleMute();

    const world = this.world;
    if (world) {
      const fatal = world.status().fatal;
      if (fatal && this.phase !== 'idle') this.stop(fatal);
    }

    if (this.phase === 'locating') {
      if (actions.pause) {
        // Abandon the fly-in and go back to the menu.
        this.stop(null);
        this.cb.onMenu();
      } else {
        this.updateLocating(dt);
      }
    } else if (this.phase === 'paused') {
      if (actions.pause) this.cb.onResume();
    } else if (this.phase === 'driving') {
      if (actions.pause) {
        this.pause();
      } else {
        if (actions.reset) this.resetToCrumb(3);
        if (actions.cameraCycle) this.chase.cyclePitch();
        const box = this.physics.drivetrain;
        if (actions.shiftUp) box.shiftUp();
        if (actions.shiftDown) box.shiftDown(this.physics.vForward);
        if (actions.gearMode) box.toggleMode();
        if (actions.zoom !== 1) this.chase.zoomBy(actions.zoom);
        this.updateDriving(dt, inp);
      }
    }
    const physMs = performance.now() - now;

    if (world && this.collider) {
      // Flying in, the detail region sits on the best surface found under the
      // spawn so far (not the camera, kilometres up): each refinement brings
      // the hit closer to the real ground, and the region follows it down.
      const L = this.locate;
      const focus =
        this.phase === 'driving' || this.phase === 'paused'
          ? this.physics.pos
          : this.phase === 'locating'
            ? new Vector3(0, L.groundY ?? L.surfaceY ?? this.chase.target.y, 0)
            : this.chase.target;
      world.update(this.chase.camera, focus, this.physics.vel);
      if (this.phase === 'driving') this.collider.warm(focus.x, focus.z, 60);
      this.hud.setAttribution(world.attribution());
    }
    this.debug.frame(dt, this.time);
    const r0 = performance.now();
    this.renderer.render(this.scene, this.chase.camera);
    this.debug.timing(dt * 1000, physMs, performance.now() - r0);
  }

  /** Leaves the current run (fatal error or cancelled fly-in). */
  private stop(fatal: string | null): void {
    this.debug.event('stop', { fatal });
    this.phase = 'idle';
    this.audio.update(0, 0, 0, false);
    this.hud.showLoading(null);
    this.hud.show(false);
    if (fatal) this.cb.onFatal(fatal);
  }

  private updateLocating(dt: number): void {
    const world = this.world!;
    const collider = this.collider!;
    const L = this.locate;
    L.t += dt;

    // Find the ground under the origin; repeat as finer tiles stream in. Coarse
    // root tiles can sit kilometres off the real surface, so trust the finest hit.
    collider.prepare(0, 0, 20);
    let best: { y: number; error: number } | null = null;
    for (const h of collider.castAll(new Vector3(0, 9000, 0), DOWN, 18000)) {
      if (h.normal.y < 0.3) continue;
      const error = (h.object.userData.tile as { geometricError?: number } | undefined)?.geometricError ?? 0;
      if (!best || error < best.error) best = { y: h.point.y, error };
    }
    // Coarse hits are ignored entirely: they can be kilometres above or below the
    // surface, and a camera parked underground never sees tiles refine.
    if (best && best.error < FINE_TILE_ERROR) L.groundY = best.y;
    if (best) L.surfaceY = best.y;

    // Hold the camera high until the ground is known, then glide down to it.
    if (L.groundY !== null) L.camY += (L.groundY - L.camY) * (1 - Math.exp(-dt * 2.5));
    let distance = this.chase.distance;
    if (L.groundY !== null) distance = Math.max(CAMERA.distance, distance * Math.exp(-dt * 1.1));
    // Look nearly straight down while high up: at a shallow preset the ground
    // under the spawn would be off-screen, and with everything in view already
    // detailed enough, the tiles there would never refine. Ease to the preset
    // over the last few hundred metres.
    const preset = CAMERA.pitchPresets[this.chase.pitchPreset];
    const high = L.groundY === null ? 1 : MathUtils.smoothstep(L.camY - L.groundY, 50, 600);
    this.chase.snap(new Vector3(0, L.camY, 0), this.spawnHeading, distance, MathUtils.lerp(preset, Math.max(preset, LOCATE_PITCH), high));

    const st = world.status();
    const arrived = L.groundY !== null && distance <= CAMERA.distance + 0.5 && Math.abs(L.camY - L.groundY) < 1;
    const progress =
      L.groundY === null
        ? 0.1
        : 0.15 + 0.7 * (1 - Math.log(distance / CAMERA.distance) / Math.log(LOCATE_START_DISTANCE / CAMERA.distance));
    this.hud.showLoading(`Flying to ${L.name}…`, Math.min(0.98, arrived ? 0.85 + st.progress * 0.15 : progress));

    if (arrived) {
      L.arrivedT += dt;
      L.settle = st.loading ? 0 : L.settle + dt;
      if (L.settle > 0.6 || L.arrivedT > LOCATE_MAX_SETTLE) {
        this.spawn(this.findSpawnPoint(L.groundY!, L.top, L.opts.height), this.spawnHeading, L.opts.kmh);
      }
    } else if (L.t > LOCATE_TIMEOUT && L.groundY === null) {
      this.stop('No 3D data loaded at this location. Try another spot.');
    }
  }

  /**
   * Prefers low, flat ground near the requested point so we start on a street,
   * not a roof. With `top`, stays on the surface found at the point itself
   * (a bridge deck), skipping holes and the river below it. With `height`, takes
   * the surface closest to that height (repro links).
   */
  private findSpawnPoint(approxY: number, top: boolean, height?: number): Vector3 {
    const collider = this.collider!;
    collider.prepare(0, 0, 40);
    if (height !== undefined) {
      let best: number | null = null;
      for (const h of collider.castAll(new Vector3(0, height + 300, 0), DOWN, 600)) {
        if (h.normal.y > 0.75 && (best === null || Math.abs(h.point.y - height) < Math.abs(best - height))) best = h.point.y;
      }
      if (best !== null && Math.abs(best - height) < 5) return new Vector3(0, best + 0.05, 0);
      return this.findTopSpawn(height);
    }
    if (top) return this.findTopSpawn(approxY);
    const sample = (x: number, z: number) => {
      const hits = collider.castAll(new Vector3(x, approxY + 300, z), DOWN, 600);
      const h = hits[0];
      return h && h.normal.y > 0.9 ? h.point.y : null;
    };
    const centre = sample(0, 0);
    let best: { x: number; z: number; y: number; cost: number } | null = null;
    for (let x = -30; x <= 30; x += 6) {
      for (let z = -30; z <= 30; z += 6) {
        const y = sample(x, z);
        if (y === null) continue;
        const cost = y + Math.hypot(x, z) * 0.04;
        if (!best || cost < best.cost) best = { x, z, y, cost };
      }
    }
    if (centre !== null && (!best || centre - best.y < 1.5)) return new Vector3(0, centre + 0.05, 0);
    if (best) return new Vector3(best.x, best.y + 0.05, best.z);
    return new Vector3(0, approxY + 1, 0);
  }

  private findTopSpawn(deckY: number): Vector3 {
    const collider = this.collider!;
    const sample = (x: number, z: number) => {
      const h = collider
        .castAll(new Vector3(x, deckY + 300, z), DOWN, 600)
        .find((h) => h.normal.y > 0.75 && Math.abs(h.point.y - deckY) < 3);
      return h ? h.point.y : null;
    };
    const centre = sample(0, 0);
    if (centre !== null) return new Vector3(0, centre + 0.05, 0);
    let best: { x: number; z: number; y: number; cost: number } | null = null;
    for (let x = -12; x <= 12; x += 3) {
      for (let z = -12; z <= 12; z += 3) {
        const y = sample(x, z);
        if (y === null) continue;
        const cost = Math.abs(y - deckY) + Math.hypot(x, z) * 0.04;
        if (!best || cost < best.cost) best = { x, z, y, cost };
      }
    }
    return best ? new Vector3(best.x, best.y + 0.05, best.z) : new Vector3(0, deckY + 0.3, 0);
  }

  private updateDriving(dt: number, inp: CarInput): void {
    const P = this.physics;
    const collider = this.collider!;
    const scale = this.debug.timeScale;
    this.acc += dt * scale;
    const forced = this.debug.takeSteps(PHYSICS.maxSubsteps);
    let steps = 0;
    while ((this.acc >= PHYSICS.dt || steps < forced) && steps < PHYSICS.maxSubsteps) {
      P.step(inp, PHYSICS.dt, collider);
      this.debug.onStep(P, inp, collider.candidateCount);
      // Scraping along a wall doesn't score, and a real hit throws the chain away.
      this.score.tick(PHYSICS.dt, P.drifting, P.speed, P.slip, P.contact);
      if (P.impact > SCORING.crashImpact) this.score.crash();
      if (steps >= forced) this.acc -= PHYSICS.dt;
      steps++;
    }
    if (steps === PHYSICS.maxSubsteps) this.acc = 0;
    const alpha = this.acc / PHYSICS.dt;

    // Rebase before building the render pose so the car, camera and world all
    // draw in the same frame.
    const rebase = this.world!.maybeRebase(P.pos);
    if (rebase) this.applyRebase(rebase.matrix, rebase.yaw);

    // Interpolated render pose.
    const x = MathUtils.lerp(P.prevPos.x, P.pos.x, alpha);
    const y = MathUtils.lerp(P.prevPos.y, P.pos.y, alpha);
    const z = MathUtils.lerp(P.prevPos.z, P.pos.z, alpha);
    const heading = P.prevHeading + wrapAngle(P.heading - P.prevHeading) * alpha;
    this.steerShown += (P.steer - this.steerShown) * (1 - Math.exp(-dt / 0.05));
    this.car.update(
      {
        x,
        y,
        z,
        heading,
        pitch: P.pitch,
        roll: P.roll,
        steer: this.steerShown,
        vForward: P.vForward,
        braking: (inp.brake > 0 && P.vForward > 0.5) || inp.handbrake,
        reversing: P.vForward < -0.3,
      },
      dt,
    );

    this.updateEffects(dt * scale, x, z, heading, inp.handbrake);
    const renderPos = new Vector3(x, y, z);
    this.chase.follow(dt, renderPos, heading, P.vel, P.drifting);
    const box = P.drivetrain;
    this.audio.update(box.rpm / DRIVETRAIN.redline, inp.throttle, P.airborne ? 0 : Math.min(1, P.tyre.slideR / 8), true, box.limiting);
    this.hud.setDrive({ rpm: box.rpm, gear: box.gear, mode: box.mode, limiting: box.limiting, refused: box.refused > 0 });

    // Frozen or slowed physics must not trip the airborne/stuck timers.
    this.trackCrumbs(dt * scale, inp.throttle);
    this.hud.update(P.speed * 3.6, this.score.state());
    this.hud.setStatus(this.statusText());
  }

  private updateEffects(dt: number, x: number, z: number, heading: number, handbrake: boolean): void {
    const P = this.physics;
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    // Smoke follows how fast the rear tyres slide over the road: drifts, burnouts and lock-ups.
    const slideAmount = P.airborne ? 0 : Math.max(0, P.tyre.slideR - 1.5) / 6 + (handbrake && P.speed > 3 ? 0.2 : 0);
    const wheels: WheelSample[] = CarModel.rearWheels.map(([cx, cz]) => ({
      point: new Vector3(x + cx * cosH + cz * sinH, P.groundY + 0.03, z - cx * sinH + cz * cosH),
      sliding: Math.min(1, slideAmount),
    }));
    const speed = P.speed;
    const dir = speed > 0.1 ? new Vector3(P.vel.x / speed, 0, P.vel.z / speed) : P.forward;
    const cam = this.chase.camera;
    const pixelScale = this.renderer.domElement.height / (2 * Math.tan(MathUtils.degToRad(cam.fov) / 2));
    this.effects.update(dt, wheels, dir, P.vel, pixelScale);
  }

  /**
   * Breadcrumbs for R / auto-reset. Gated on real progress (velocity lies when the
   * car is pinned against a wall with the throttle down), and suspended after a
   * big fall so a reset climbs back out instead of returning to the pit.
   */
  private trackCrumbs(dt: number, throttle: number): void {
    const P = this.physics;
    if (P.airborne && !this.takeoff) this.takeoff = { y: P.pos.y, t: this.time };
    if (!P.airborne && this.takeoff) {
      if (P.pos.y < this.takeoff.y - 4) this.fallGuard = { y: this.takeoff.y - 4, until: this.time + 60 };
      this.takeoff = null;
    }
    if (this.fallGuard && (this.time > this.fallGuard.until || P.pos.y >= this.fallGuard.y)) this.fallGuard = null;

    this.crumbTimer += dt;
    const last = this.crumbs[this.crumbs.length - 1];
    const moved = !last || Math.hypot(P.pos.x - last.pos.x, P.pos.z - last.pos.z) > 5;
    // Not inside a tunnel either: a reset there would lose the virtual road.
    if (this.crumbTimer > 1 && moved && !this.fallGuard && !P.airborne && !P.waiting && !P.tunnel && P.groundNormal.y > 0.9) {
      this.crumbTimer = 0;
      this.crumbs.push({ pos: P.pos.clone(), heading: P.heading, t: this.time });
      if (this.crumbs.length > 30) this.crumbs.shift();
    }

    // Stuck = throttle held without getting 3 m anywhere for a while.
    const ref = this.stuckRef;
    if (throttle === 0 || P.waiting || Math.hypot(P.pos.x - ref.pos.x, P.pos.z - ref.pos.z) > 3) {
      ref.pos.copy(P.pos);
      ref.t = this.time;
    }
    this.stuckTime = this.time - ref.t;

    this.airTime = P.airborne ? this.airTime + dt : 0;
    if (this.airTime > 4) this.resetToCrumb(3);
  }

  private resetToCrumb(secondsBack: number): void {
    const cutoff = this.time - secondsBack;
    let crumb: Crumb | undefined;
    for (let i = this.crumbs.length - 1; i >= 0; i--) {
      if (this.crumbs[i].t <= cutoff) {
        crumb = this.crumbs[i];
        this.crumbs.length = i + 1;
        break;
      }
    }
    const pos = crumb ? crumb.pos : this.spawnPos;
    const heading = crumb ? crumb.heading : this.spawnHeading;
    this.debug.event('reset', { secondsBack, from: this.physics.pos.toArray(), to: pos.toArray(), crumb: !!crumb });
    this.physics.reset(pos.clone().setY(pos.y + 0.3), heading);
    this.chase.snap(pos, heading, this.chase.distance);
    this.effects.liftAll();
    this.score.crash();
    this.airTime = 0;
    this.takeoff = this.fallGuard = null;
    this.stuckRef.pos.copy(pos);
    this.stuckRef.t = this.time;
  }

  private applyRebase(m: Matrix4, yaw: number): void {
    const oldY = this.physics.pos.y;
    this.physics.rebase(m, yaw);
    this.debug.onRebase(m, yaw);
    const dy = this.physics.pos.y - oldY;
    if (this.takeoff) this.takeoff.y += dy;
    if (this.fallGuard) this.fallGuard.y += dy;
    this.stuckRef.pos.applyMatrix4(m);
    this.chase.rebase(m, yaw);
    this.effects.applyMatrix(m);
    this.spawnPos.applyMatrix4(m);
    this.spawnHeading += yaw;
    for (const c of this.crumbs) {
      c.pos.applyMatrix4(m);
      c.heading += yaw;
    }
  }

  private statusText(): string {
    const P = this.physics;
    if (P.waiting) return 'Loading terrain…';
    if (this.stuckTime > 3) return matchMedia('(pointer: coarse)').matches ? 'Stuck? Tap ⟲ to reset' : 'Stuck? Press R to reset';
    return '';
  }

  private debugText(): string {
    const P = this.physics;
    const c = this.collider;
    return [
      `fps ${this.fps.toFixed(0)}  phase ${this.phase}`,
      `pos ${P.pos.x.toFixed(1)} ${P.pos.y.toFixed(1)} ${P.pos.z.toFixed(1)}  hdg ${(-P.heading * MathUtils.RAD2DEG).toFixed(0)}°`,
      `v ${(P.speed * 3.6).toFixed(0)} km/h  vF ${P.vForward.toFixed(1)} vL ${P.vLateral.toFixed(1)}  slip ${(P.slip * MathUtils.RAD2DEG).toFixed(0)}°`,
      `drift ${P.drifting} air ${P.airborne} wait ${P.waiting}  n.y ${P.groundNormal.y.toFixed(3)}${
        P.tunnel ? `  tunnel ${P.tunnel.d.toFixed(0)} m grade ${(P.tunnel.grade * 100).toFixed(1)}%${P.tunnel.exit ? ' exit seen' : ''}` : ''
      }`,
      `tyres  front ${(P.tyre.slipF * MathUtils.RAD2DEG).toFixed(0)}° ${(P.tyre.loadF / 1000).toFixed(1)} kN  rear ${(P.tyre.slipR * MathUtils.RAD2DEG).toFixed(0)}° ${(P.tyre.loadR / 1000).toFixed(1)} kN  wheel ${(P.wheelSpeed * 3.6).toFixed(0)} km/h  steer ${(P.steer * MathUtils.RAD2DEG).toFixed(0)}°`,
      (() => {
        const box = P.drivetrain;
        const out = box.output();
        return `${box.mode} gear ${box.gear < 0 ? 'R' : box.gear}  ${Math.round(box.rpm)} rpm  ${out.torque.toFixed(0)} N·m  ${out.hp.toFixed(0)} hp  drive ${(box.force / 1000).toFixed(1)} kN${box.limiting ? '  LIMITER' : ''}`;
      })(),
      `cam d ${this.chase.distance.toFixed(0)} m  pitch ${(this.chase.pitch * MathUtils.RAD2DEG).toFixed(0)}°  zoom ${this.chase.zoom.toFixed(2)}`,
      c ? `colliders ${c.candidateCount}  bvh built ${c.bvhBuilds} (last ${c.bvhMs.toFixed(1)} ms)` : '',
      this.world?.debugInfo() ?? '',
    ].join('\n');
  }
}
