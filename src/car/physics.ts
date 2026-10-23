import { MathUtils, Vector3, type Matrix4 } from 'three';
import { PHYSICS as P } from '../config';
import { CARS, DEFAULT_CAR, type CarSpec, type ChassisSpec } from './cars';
import { Drivetrain, type DriveOutput } from './drivetrain';
import { SURFACES, type SurfaceId } from './surfaces';
import type { Collider, RayHit } from '../world/collider';

export interface CarInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (reverse when stopped)
  steer: number; // −1 right … +1 left
  handbrake: boolean;
  /** The brake is an on/off key or touch button rather than an analog trigger. */
  brakeDigital?: boolean;
}

export interface CarEvents {
  onImpact?(speed: number): void;
  onLand?(speed: number): void;
  /** A fresh (uncached) overpass-vs-wall decision, for tracing. */
  onOverpass?(d: OverpassDecision): void;
}

/** One `isOverpass` evaluation. Heights are relative to `groundY`. */
export interface OverpassDecision {
  hit: [number, number, number];
  dir: [number, number];
  groundY: number;
  result: boolean;
  /** Which test decided it. `blob*` reasons come from the vehicle-blob test. */
  reason:
    | 'no-deck'
    | 'no-floor'
    | 'deck-runs-on'
    | 'far-side'
    | 'no-data'
    | 'blob'
    | 'blob-sloped'
    | 'blob-too-tall'
    | 'blob-too-long'
    | 'blob-too-wide'
    | 'blob-no-top'
    | 'portal-floored'
    | 'portal-floored-long'
    | 'portal-curtain'
    | 'portal-vertical'
    | 'portal-floor-ends'
    | 'portal-no-cover'
    | 'portal-high'
    | 'portal-low'
    | 'portal-building'
    | 'tunnel-exit'
    | 'tunnel-wall';
  /** Distance along `dir` where the deck starts (−1 if none) and its height. */
  start: number;
  deck: number;
  /**
   * Surface heights sampled: [distance, height or null, phase]. `skirt`, `far`
   * and `along` run along `dir` from `hit`; `side` runs across it (signed
   * distance) from the point `mid` metres along.
   */
  samples: Array<[number, number | null, 'skirt' | 'far' | 'along' | 'side' | 'lid']>;
  mid?: number;
  /** Portal test: level rays at 1.5, 3 and 4.5 m, [distance past the hit, normal y] or null. */
  lean?: Array<[number, number] | null>;
  /** Portal test: why the overpass test (run first) said no. */
  overpass?: OverpassDecision['reason'];
}

/** Virtual road the car runs on inside a tunnel, where the mesh has none. */
interface Tunnel {
  /** Road height now, and its grade (rise per metre travelled). */
  h: number;
  grade: number;
  /** Clearance under the cover (at the portal, then 10 m in), and the cover's height above the road last scanned. */
  clearance: number;
  remeasured: boolean;
  cover: number | null;
  /** Distance travelled since the portal, and at the last scan. */
  d: number;
  scannedAt: number;
  /** Exit road found ahead: `s` metres on from where it was seen (at `d`), at height `h`. */
  exit: { s: number; h: number; d: number } | null;
  /** Exit-test verdicts already traced. */
  traced: Set<string>;
  /** Consecutive steps on real ground, and on real ground with nothing overhead. */
  real: number;
  open: number;
  x: number;
  z: number;
}

interface GhostTunnelPoint {
  x: number;
  z: number;
  h: number;
}

interface GhostTunnelWallHit {
  point: Vector3;
  normal: Vector3;
  distance: number;
}

/** Footprint of a car-sized blob judged passable (baked or ghosted vehicle). */
interface Blob {
  x: number;
  z: number;
  r: number;
  /** The road under it: height at (x, z) and its slope (rise per metre along X and Z). */
  ground: number;
  gx: number;
  gz: number;
}

/** Height of the road a blob sits on, at (x, z). */
function blobRoad(b: Blob, x: number, z: number): number {
  return b.ground + b.gx * (x - b.x) + b.gz * (z - b.z);
}

/** Per-ray detail for the debug overlay, filled only when `CarPhysics.debugRays` is set. */
export interface WallRayDebug {
  origin: [number, number, number];
  dir: [number, number];
  /** Distance from the origin to the car outline along the ray. */
  reach: number;
  length: number;
  hit: { point: [number, number, number]; normal: [number, number, number]; distance: number } | null;
  verdict: 'clear' | 'steep-floor' | 'beyond' | 'overpass' | 'blob' | 'wall' | 'wall-minor';
}

export interface ProbeDebug {
  x: number;
  z: number;
  fromY: number;
  toY: number;
  state: Probe;
  hitY: number | null;
}

export interface TireState {
  /** Slip angles (rad, signed like `slip`) of the front road wheels and rear axle. */
  slipF: number;
  slipR: number;
  /** Sliding speed at each contact patch (m/s), 0 while the tire grips. */
  slideF: number;
  slideR: number;
  /** Normal loads (N). */
  loadF: number;
  loadR: number;
  /** Axle forces on the body (N; x forward, y left). */
  forceF: [number, number];
  forceR: [number, number];
}

/** What the driver aids did in the last substep (0 while idle), for the debug tools. */
export interface AidState {
  /** Share of the foot brake ABS held back (0 none … 1 all of it). */
  abs: number;
  /** Share of the engine's drive traction control cut (0 … 1). */
  tc: number;
  /** Yaw acceleration stability control added (rad/s², signed like `yawRate`). */
  stability: number;
  /** Seconds until stability control re-arms after a deliberate slide (0: armed). */
  rearm: number;
}

/** Driver aids switched on. Off ignores the preset's numbers for that aid without changing them. */
export interface Assists {
  /** Off: the foot brake isn't capped to the grip or let off as the wheels lock. */
  abs: boolean;
  /** Off: drive is never cut. */
  tc: boolean;
  /** Off: no yaw correction, whatever the rear does. */
  esc: boolean;
}
export type Assist = keyof Assists;

/** One axle's ground: its two wheels' surfaces (surfaces.ts), averaged and eased in. */
export interface AxleSurface {
  grip: number;
  peakSlip: number;
  slideLift: number;
  rolling: number;
  drag: number;
  /** Left wheel's rolling and drag less the right's: soft ground under one side pulls the car toward it. */
  rollingDiff: number;
  dragDiff: number;
}

const asphaltAxle = (): AxleSurface => ({ grip: 1, peakSlip: 1, slideLift: 0, rolling: 0, drag: 0, rollingDiff: 0, dragDiff: 0 });

/** What the wall solver pushed against during the last step (pen 0 if nothing). */
export interface WallContact {
  pen: number;
  ray: number;
  point: Vector3;
  normal: Vector3;
  geometricError: number;
}

const G = 9.81;
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);


export enum Probe {
  Ground,
  /** Surface found, but too far above the wheel to step onto. */
  Blocked,
  /** Nothing usable under the wheel (steep noise, mesh hole, tile not loaded). */
  Miss,
  /** Walkable ground exists, but more than `dropHeight` below the wheel: an edge. */
  Drop,
}

export enum Edge {
  None,
  Blocked,
  Drop,
}

const _o = new Vector3();
const _d = new Vector3();
// The blob test runs mid-way through the probe loops, so it has its own scratch.
const _bo = new Vector3();
const _bd = new Vector3();
const _hit: RayHit = { point: new Vector3(), normal: new Vector3(), distance: 0, object: null! };

/**
 * Kinematic arcade car. Heading ψ = 0 faces north (−Z); positive ψ turns left.
 * forward = (−sin ψ, 0, −cos ψ), left = (−cos ψ, 0, sin ψ).
 */
export class CarPhysics {
  readonly pos = new Vector3();
  readonly prevPos = new Vector3();
  /** Horizontal velocity (y unused). */
  readonly vel = new Vector3();
  vy = 0;
  /** The car being driven (setCar swaps it). */
  car: CarSpec = CARS[DEFAULT_CAR];
  /** Its chassis, tires, steering and brakes. */
  private c: ChassisSpec = this.car.chassis;
  /** Probe corners: front-left, front-right, rear-left, rear-right. Front is −Z in car space. */
  private corners: Array<[number, number]> = [];
  drivetrain = new Drivetrain(this.car.drivetrain);
  heading = 0;
  prevHeading = 0;
  yawRate = 0;

  /** Front road-wheel angle (rad, left +), self-alignment included. */
  steer = 0;
  /** The driver's part of `steer`. */
  steerCmd = 0;
  /** Road-wheel angle full steering input asks for at this speed (rad). */
  steerLock = 0;
  /** Driven wheels' surface speed (m/s): ahead of the car under wheelspin, 0 when locked. */
  wheelSpeed = 0;
  /**
   * Front-drive cars' free-rolling rear wheels' surface speed (m/s): it lags
   * the car under braking and drops to 0 on the handbrake. (A rear-drive car's
   * front wheels aren't integrated: their brakes are ABS-limited instead.)
   */
  private rollSpeed = 0;
  /** How much the driven wheels run ahead of the road under them (m/s, ≥ 0): wheelspin. */
  wheelSpin = 0;
  /** Longitudinal acceleration, smoothed (drives load transfer). */
  private accelF = 0;
  /** Seconds until stability control re-arms after a deliberate slide. */
  private intent = 0;
  /** How much traction control is limiting drive this step (0 off … 1). */
  private traction = 0;
  /** Tire state from the last substep, for effects and tracing. */
  readonly tire: TireState = { slipF: 0, slipR: 0, slideF: 0, slideR: 0, loadF: 0, loadR: 0, forceF: [0, 0], forceR: [0, 0] };
  /** Which driver aids are on (the debug gauges' lamps switch them). */
  readonly assists: Assists = { abs: true, tc: true, esc: true };
  /** What ABS, traction and stability control did in the last substep. */
  readonly aids: AidState = { abs: 0, tc: 0, stability: 0, rearm: 0 };
  /** The body's acceleration over the last substep (m/s²; forward +, left +), drag included: what a g-meter reads. */
  accelLong = 0;
  accelLat = 0;
  /** Foot brake force the spinAxle call just made actually applied (ABS releases it). */
  private footApplied = 0;

  /** The car is sliding (an observation of the slip angle, not a mode). */
  drifting = false;
  private lowSlipTime = 0;
  /** Throttle and handbrake smoothed over `pedalTau`, so tapping a digital key feathers. */
  throttleF = 0;
  handbrakeF = 0;
  /** Foot brake the driver is asking for (0…1), eased in from a digital brake. */
  brakeF = 0;

  /** Body pitch (nose up +) and roll (left side up +) from the ground plane. */
  pitch = 0;
  roll = 0;
  /** What rough ground adds to pitch and roll this step: quick, so the car model shows it uneased. */
  ridePitch = 0;
  rideRoll = 0;
  readonly groundNormal = new Vector3(0, 1, 0);
  groundY = 0;
  private groundVel = 0;
  airborne = false;
  /** Physics is paused because no collision geometry is loaded under the car. */
  waiting = false;
  private missTime = 0;
  private readonly cornerH = [0, 0, 0, 0];
  readonly probeState: Probe[] = [Probe.Miss, Probe.Miss, Probe.Miss, Probe.Miss];
  /** The surface under each wheel (by Probe corner), as of the last probe that found ground there. */
  readonly surface: SurfaceId[] = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];
  /** Front and rear axles' surface, blended from their wheels' over `surfaceTau`. */
  readonly axleSurface: [AxleSurface, AxleSurface] = [asphaltAxle(), asphaltAxle()];
  /** Set by reset() and setCar(): take the surface under the wheels at once, unblended. */
  private surfaceSnap = true;
  /** World x, z of each wheel's probe this step. */
  private readonly wheelX = [0, 0, 0, 0];
  private readonly wheelZ = [0, 0, 0, 0];

  // Diagnostics, overwritten every step.
  /** Edge (ledge/drop) that reverted the last step's motion. */
  edge = Edge.None;
  /** The single long ray stood in for the corner probes last step. */
  usedLongProbe = false;
  readonly wall: WallContact = { pen: 0, ray: -1, point: new Vector3(), normal: new Vector3(), geometricError: 0 };
  /** When true, `rays` and `probes` describe the last step for the debug overlay. */
  debugRays = false;
  readonly rays: WallRayDebug[] = [];
  readonly probes: ProbeDebug[] = [];

  // Derived each step, read by HUD/effects/scoring.
  vForward = 0;
  vLateral = 0;
  slip = 0;
  speed = 0;
  /** Largest wall impact speed during the last step (m/s), 0 if none. */
  impact = 0;
  /** True if the car touched a wall or edge during the last step. */
  contact = false;

  constructor(
    private readonly events: CarEvents = {},
    car: CarSpec = CARS[DEFAULT_CAR],
  ) {
    this.setCar(car);
  }

  /** Switches to another car (a fresh drivetrain); reset() it before driving on. */
  setCar(car: CarSpec): void {
    this.car = car;
    this.c = car.chassis;
    const { cornerX: x, cornerZ: z } = car.chassis;
    this.corners = [
      [-x, -z],
      [x, -z],
      [-x, z],
      [x, z],
    ];
    const mode = this.drivetrain.mode;
    this.drivetrain = new Drivetrain(car.drivetrain);
    this.drivetrain.mode = mode;
    this.surfaceSnap = true;
  }

  /** Brings the car to rest where it stands, keeping what it knows of the ground (a tunnel's virtual road, caches, airborne). */
  halt(): void {
    this.vel.set(0, 0, 0);
    this.vy = 0;
    // Derived from the velocity in step(), which doesn't run while paused.
    this.vForward = this.vLateral = this.slip = this.speed = 0;
    this.prevPos.copy(this.pos);
    this.prevHeading = this.heading;
    this.stopRotating();
    this.intent = 0;
    this.drifting = false;
    this.throttleF = this.handbrakeF = this.brakeF = 0;
  }

  get forward(): Vector3 {
    return new Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  /** Sets the car rolling straight ahead at `speed` (m/s), wheels and box to match. */
  launch(speed: number): void {
    this.vel.copy(this.forward).multiplyScalar(speed);
    this.wheelSpeed = this.rollSpeed = speed;
    this.drivetrain.matchSpeed(speed);
  }

  reset(pos: Vector3, heading: number): void {
    this.pos.copy(pos);
    this.prevPos.copy(pos);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.heading = this.prevHeading = heading;
    this.yawRate = 0;
    this.steer = this.steerCmd = 0;
    this.wheelSpeed = this.rollSpeed = this.wheelSpin = 0;
    this.accelF = 0;
    this.intent = this.traction = 0;
    this.drifting = false;
    this.lowSlipTime = 0;
    this.throttleF = this.handbrakeF = this.brakeF = 0;
    // So a scripted run repeats exactly, whatever the car did before it.
    const t = this.tire;
    t.slipF = t.slipR = t.slideF = t.slideR = t.loadF = t.loadR = 0;
    t.forceF[0] = t.forceF[1] = t.forceR[0] = t.forceR[1] = 0;
    this.accelLong = this.accelLat = 0;
    this.clearAids();
    this.drivetrain.reset();
    this.overpassCache.clear();
    this.blobCache.clear();
    this.blobs.length = 0;
    this.tunnel = null;
    this.ghostTunnel = null;
    this.roadTrail.length = 0;
    this.pitch = this.roll = this.ridePitch = this.rideRoll = 0;
    this.groundNormal.set(0, 1, 0);
    this.groundY = pos.y;
    this.groundVel = 0;
    this.cornerH.fill(pos.y);
    this.airborne = false;
    this.waiting = false;
    this.missTime = 0;
    this.surfaceSnap = true;
  }

  /** Applies a world rebase: positions by `m`, directions by `yaw`. */
  rebase(m: Matrix4, yaw: number): void {
    const oldY = this.pos.y;
    this.pos.applyMatrix4(m);
    this.prevPos.applyMatrix4(m);
    this.vel.applyAxisAngle(UP, yaw);
    this.heading += yaw;
    this.prevHeading += yaw;
    // The rotation is tiny, so ground heights shift with the body.
    const dy = this.pos.y - oldY;
    this.overpassCache.clear();
    this.blobCache.clear();
    this.blobs.length = 0;
    this.roadTrail.length = 0;
    this.groundY += dy;
    for (let i = 0; i < 4; i++) this.cornerH[i] += dy;
    const t = this.tunnel;
    if (t) {
      _o.set(t.x, 0, t.z).applyMatrix4(m);
      t.x = _o.x;
      t.z = _o.z;
      t.h += dy;
      if (t.exit) t.exit.h += dy;
    }
    if (this.ghostTunnel) {
      for (const point of this.ghostTunnel) {
        _o.set(point.x, 0, point.z).applyMatrix4(m);
        point.x = _o.x;
        point.z = _o.z;
        point.h += dy;
      }
    }
  }

  step(input: CarInput, dt: number, collider: Collider): void {
    this.prevPos.copy(this.pos);
    this.prevHeading = this.heading;
    this.impact = 0;
    this.contact = false;
    this.edge = Edge.None;
    this.usedLongProbe = false;
    this.wall.pen = 0;
    this.wall.ray = -1;
    this.rays.length = 0;

    collider.prepare(this.pos.x, this.pos.z, this.c.halfLength + 2 + this.speed * dt * 4);

    if (this.waiting) {
      this.solveGround(collider, dt);
      if (this.waiting) return;
    }
    this.blendSurfaces(collider, dt);

    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const vF = this.vel.x * -sinH + this.vel.z * -cosH;
    const vL = this.vel.x * -cosH + this.vel.z * sinH;

    // Pedals are smoothed so tapping a digital key feathers.
    const pedal = 1 - Math.exp(-dt / P.pedalTau);
    this.throttleF += (input.throttle - this.throttleF) * pedal;
    this.handbrakeF += ((input.handbrake ? 1 : 0) - this.handbrakeF) * pedal;

    // Steering command: speed-scaled lock, rate-limited.
    const absVF = Math.abs(vF);
    const ground = Math.hypot(vF, vL);
    const lock = this.c.steerMax / (1 + ground / this.c.steerSpeedFalloff);
    this.steerLock = lock;
    const target = MathUtils.clamp(input.steer, -1, 1) * lock;
    const rate = (Math.abs(target) > Math.abs(this.steerCmd) ? this.c.steerRate : this.c.steerReturn) / (1 + ground / 25);
    this.steerCmd += MathUtils.clamp(target - this.steerCmd, -rate * dt, rate * dt);
    // Self-alignment: the front wheels follow the car's direction of travel
    // (fading out at walking pace and in reverse, where it means nothing). Not
    // the front axle's own direction: that includes the yaw rate, and following
    // it would remove the front tires' resistance to rotating.
    const align = this.c.steerAlign * MathUtils.smoothstep(vF, 1.5, 5);
    const travel = Math.atan2(vL, Math.max(absVF, 0.1));
    this.steer = MathUtils.clamp(align * travel + this.steerCmd, -this.c.wheelLock, this.c.wheelLock);
    // Traction control while not steering, so a launch doesn't just spin the
    // rear; steer and it lets the wheels spin.
    this.traction = this.assists.tc ? this.c.tractionControl * (1 - MathUtils.smoothstep(Math.abs(input.steer), 0.1, 0.4)) : 0;

    // Pedals → drive force, brakes. The brake key brakes while moving and
    // selects reverse once nearly stopped; in reverse, the throttle brakes. A
    // car spun round and sliding backwards is still in a forward gear.
    const wasReverse = this.drivetrain.gear < 0;
    const backBrake = wasReverse && input.throttle > 0 && vF < -0.5;
    const reversing =
      backBrake ||
      (input.brake > 0 && input.throttle === 0 && vF < 0.5 && (wasReverse || ground < 1)) ||
      (wasReverse && vF < -0.3 && input.throttle === 0);
    // A rear-drive car declutches on the handbrake, as its driver would; a
    // front-drive one stays on the power, which drives the fronts on through
    // the slide the handbrake starts.
    const declutch = this.airborne || (this.car.drive === 'rwd' && this.handbrakeF > 0.3);
    // The auto box holds its gear through a slide, and on the handbrake (which
    // in a front-drive car stays in gear): a driver doesn't shift up mid-turn.
    const sliding = this.drifting || this.handbrakeF > 0.3;
    const engine = this.drivetrain.update(dt, this.wheelSpeed, ground, backBrake ? 0 : this.throttleF, reversing, declutch, sliding);
    let drive = engine.drive;
    // A key or touch button would stamp on the brake (and, without ABS, lock
    // the wheels) the moment it's pressed: it builds up instead, and lets go at once.
    const footWant = reversing ? 0 : input.brake;
    const ease = input.brakeDigital && footWant > this.brakeF;
    this.brakeF = ease ? Math.min(footWant, this.brakeF + dt / P.brakeRamp) : footWant;
    let brake = backBrake ? input.throttle : 0;
    if (input.brake > 0) {
      if (!reversing) brake = Math.max(brake, this.brakeF);
      else if (!declutch && vF > -this.c.topSpeedReverse) drive -= this.c.mass * this.c.reverseAccel * input.brake;
    }

    if (this.airborne) {
      this.yawRate *= Math.exp(-dt * 0.5);
      this.heading += this.yawRate * dt;
      const t = this.tire;
      t.slideF = t.slideR = 0;
      t.forceF[0] = t.forceF[1] = t.forceR[0] = t.forceR[1] = 0;
      this.clearAids();
      this.accelLong = this.accelLat = 0;
    } else {
      const n = P.substeps;
      for (let i = 0; i < n; i++) this.integrateChassis(dt / n, drive, brake, engine);
    }

    // Slope gravity (ignores photogrammetry noise on near-flat ground).
    const n = this.groundNormal;
    if (!this.airborne && Math.hypot(n.x, n.z) > P.slopeDeadzone) {
      this.vel.x += G * P.slopeGravity * n.x * dt;
      this.vel.z += G * P.slopeGravity * n.z * dt;
    }
    if (!this.airborne && Math.hypot(this.vel.x, this.vel.z) < 0.3 && input.throttle === 0 && input.brake === 0) {
      this.vel.x = this.vel.z = 0;
      this.wheelSpeed = this.rollSpeed = 0;
      this.yawRate *= Math.exp(-dt * 20);
    }

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    this.solveWalls(collider, dt);
    this.solveGround(collider, dt);

    const nfx = -Math.sin(this.heading);
    const nfz = -Math.cos(this.heading);
    this.vForward = this.vel.x * nfx + this.vel.z * nfz;
    this.vLateral = this.vel.x * nfz - this.vel.z * nfx; // left = (nfz, −nfx)
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.slip = Math.atan2(this.vLateral, Math.max(Math.abs(this.vForward), 1));

    this.updateTunnel(collider);
    this.recordRoad();

    // Drifting is only an observation of the slide (scoring, smoke, camera).
    const slip = Math.abs(this.slip);
    if (!this.drifting && !this.airborne && this.vForward > 2 && this.speed > P.driftEnterSpeed && slip > P.driftEnterSlip) {
      this.drifting = true;
      this.lowSlipTime = 0;
    }
    if (this.drifting) {
      this.lowSlipTime = slip < P.driftExitSlip ? this.lowSlipTime + dt : 0;
      if (this.lowSlipTime > P.driftExitTime || this.speed < P.driftExitSpeed) this.drifting = false;
    }
  }

  /**
   * One chassis substep: tire forces at each axle from their slip, the driven
   * wheels' spin from engine, brakes and road, then the body's motion and
   * rotation. Front-back load transfer follows the recent acceleration.
   */
  private integrateChassis(h: number, drive: number, brake: number, engine: DriveOutput): void {
    const m = this.c.mass;
    const a = this.c.cgToFront;
    const b = this.c.wheelbase - a;
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const fx = -sinH;
    const fz = -cosH;
    const lx = -cosH;
    const lz = sinH;
    const vF = this.vel.x * fx + this.vel.z * fz;
    const vL = this.vel.x * lx + this.vel.z * lz;
    const r = this.yawRate;

    const transfer = (m * this.accelF * this.c.cgHeight) / this.c.wheelbase;
    const loadF = Math.max(0.15 * m * G, (m * G * b) / this.c.wheelbase - transfer);
    const loadR = Math.max(0.15 * m * G, (m * G * a) / this.c.wheelbase + transfer);
    const t = this.tire;
    t.loadF = loadF;
    t.loadR = loadR;

    // Front axle, in the road wheels' frame.
    const cd = Math.cos(this.steer);
    const sd = Math.sin(this.steer);
    const vyF = vL + a * r;
    const wx = vF * cd + vyF * sd;
    const wy = -vF * sd + vyF * cd;
    const [gF, gR] = this.axleSurface;
    const gripF = this.c.muFront * gF.grip * loadF;
    const vyR = vL - b * r;
    const gripR = this.c.muRear * gR.grip * loadR;
    const J = engine.inertia;
    const footF = brake * this.c.brakeDecel * this.c.brakeFront * m;
    const abs = this.assists.abs;
    const footR = Math.min(brake * this.c.brakeDecel * (1 - this.c.brakeFront) * m, abs ? this.c.absLimit * gripR : Infinity);
    const hand = this.handbrakeF * this.c.handbrakeForce * m * G;
    const footAsked = brake * this.c.brakeDecel * m;
    let footGiven = 0;
    const driveAsked = drive;
    const vx0 = this.vel.x;
    const vz0 = this.vel.z;
    let fxw: number;
    let fyw: number;
    let rear: AxleForce;
    let rearWheel: number;
    if (this.car.drive === 'fwd') {
      // Front-drive. The fronts are driven, sharing one friction budget between
      // drive (or braking) and steering, in the road wheels' frame: wheelspin
      // washes the nose wide, and their pull goes where they point.
      //
      // Traction control holds the wheels near peak slip: it lets through what
      // the grip and spinning up the wheels and engine alongside the car take
      // (or a low gear would launch well short of the grip, and the front's is
      // all the car has), and cuts the drive as they spin past it.
      const sxF = (this.wheelSpeed - wx) / Math.max(Math.abs(wx), P.tireMinSpeed) / (this.c.peakSlipRatio * gF.peakSlip);
      const tcLimit = gripF * (1 + J / m) * (1 - MathUtils.smoothstep(sxF, 0.8, 1.3));
      if (this.traction > 0 && drive > tcLimit) drive -= (drive - tcLimit) * this.traction;
      if (drive < 0) drive = Math.max(drive, -0.85 * gripF * Math.sqrt(Math.max(0, 1 - (this.tire.forceF[1] / gripF) ** 2)));
      const absF = abs ? Math.min(footF, this.c.absLimit * gripF) : footF;
      const ws = this.spinAxle(true, this.wheelSpeed, drive, J, wx, wy, loadF, absF, 0, engine.engineBrake, h);
      footGiven += this.footApplied;
      this.wheelSpeed = ws;
      this.wheelSpin = Math.max(0, Math.abs(ws) - Math.abs(wx));
      const front = axleTire(this.c, true, gF, ws, wx, wy, loadF, _front);
      fxw = front.x;
      fyw = front.y;
      t.slideF = front.sliding ? Math.hypot(ws - wx, wy) : 0;
      // The rear rolls free on the wheels' own inertia; the handbrake locks it.
      const D = this.car.drivetrain;
      this.rollSpeed = this.spinAxle(false, this.rollSpeed, 0, D.wheelInertia / D.wheelRadius ** 2, vF, vyR, loadR, footR, hand, 0, h);
      footGiven += this.footApplied;
      rearWheel = this.rollSpeed;
      rear = axleTire(this.c, false, gR, rearWheel, vF, vyR, loadR, _rear);
      // Only the handbrake means the rear is meant to be out (front wheelspin
      // doesn't unsettle it), and then for as long as the slide it started
      // goes on. A slide that grows out of lifting off stays in stability
      // control's hands, to its stabilitySlip allowance.
      if (this.handbrakeF > 0.2 || (this.drifting && this.intent > 0)) this.intent = this.c.stabilityOff;
      else this.intent -= h;
    } else {
      // Rear-drive. The fronts only steer and brake.
      const sy = wy / (Math.max(Math.abs(wx), P.tireMinSpeed) * Math.tan(this.c.peakSlipAngle) * gF.peakSlip);
      fyw = -Math.sign(sy) * gripF * tireCurve(Math.abs(sy), slideOn(this.c.slideFront, gF));
      // ABS: braking only takes the grip cornering leaves (so a braked, steered
      // car still turns), and never reverses the wheel.
      const room = Math.sqrt(Math.max(0, gripF * gripF - fyw * fyw));
      const patch = Math.hypot(wx, wy);
      if (!abs && footF > room && patch > 1) {
        // Without ABS, braking past what the cornering leaves locks the
        // wheels: they slide straight on along the patch's travel, and don't steer.
        const f = (gripF * slideOn(this.c.slideFront, gF)) / patch;
        fxw = -wx * f;
        fyw = -wy * f;
        footGiven += footF;
        t.slideF = patch;
      } else {
        const brakeF = Math.min(footF, abs ? this.c.absLimit * room : room, (Math.abs(wx) * m) / h / 4);
        fxw = -Math.sign(wx) * brakeF;
        footGiven += brakeF;
        t.slideF = Math.abs(sy) > 1 ? Math.abs(wy) : 0;
      }

      // The rear is driven.
      if (this.traction > 0 && drive > gripR) drive -= (drive - gripR) * this.traction;
      // Reverse has no gearbox to bog it: keep it inside the grip cornering leaves.
      if (drive < 0) drive = Math.max(drive, -0.85 * gripR * Math.sqrt(Math.max(0, 1 - (this.tire.forceR[1] / gripR) ** 2)));
      const ws = this.spinAxle(false, this.wheelSpeed, drive, J, vF, vyR, loadR, footR, hand, engine.engineBrake, h);
      footGiven += this.footApplied;
      this.wheelSpeed = rearWheel = ws;
      this.wheelSpin = Math.max(0, Math.abs(ws) - Math.abs(vF));
      // A deliberate slide (handbrake, wheelspin) switches stability control off for a moment.
      const spinning = ws - vF > Math.max(1.5, 2 * this.c.peakSlipRatio * gR.peakSlip * Math.max(Math.abs(vF), P.tireMinSpeed));
      if (this.handbrakeF > 0.2 || spinning || this.drifting) this.intent = this.c.stabilityOff;
      else this.intent -= h;
      rear = axleTire(this.c, false, gR, ws, vF, vyR, loadR, _rear);
    }
    const frontLong = fxw * cd - fyw * sd;
    const frontLat = fxw * sd + fyw * cd;
    t.slipF = Math.atan2(wy, Math.abs(wx));
    t.slipR = Math.atan2(vyR, Math.abs(vF));
    t.slideR = rear.sliding ? Math.hypot(rearWheel - vF, vyR) : 0;
    t.forceF[0] = frontLong;
    t.forceF[1] = frontLat;
    t.forceR[0] = rear.x;
    t.forceR[1] = rear.y;

    // Body.
    // Stability control: the rear stepping out with no handbrake, wheelspin or
    // drift under way (braking or lifting mid-corner) gets a yaw torque back.
    let spin = 0;
    const slipR = Math.abs(t.slipR);
    // On loose ground the rear's peak comes later, and the brakes it works
    // with have less grip to push against.
    const allow = (this.c.stabilitySlip ?? this.c.peakSlipAngle) * gR.peakSlip;
    if (this.assists.esc && this.intent <= 0 && slipR > allow && vF > 3) spin -= Math.sign(r) * Math.min(Math.abs(r) / h, this.c.stability * gR.grip * (slipR - allow));
    const forceF = frontLong + rear.x;
    const forceL = frontLat + rear.y;
    this.vel.x += ((forceF * fx + forceL * lx) / m) * h;
    this.vel.z += ((forceF * fz + forceL * lz) / m) * h;
    this.yawRate += ((a * frontLat - b * rear.y) / this.c.yawInertia + spin) * h;
    this.heading += this.yawRate * h;
    this.accelF += (forceF / m - this.accelF) * (1 - Math.exp(-h / 0.08));

    // Drag and rolling resistance oppose motion and never reverse it. The
    // surface's share is each axle's, weighted by the load it carries.
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp > 1e-4) {
      const L = this.c.wheelbase;
      const roll = (gF.rolling * b + gR.rolling * a) / L;
      const soft = (gF.drag * b + gR.drag * a) / L;
      const decel = (this.c.rollingDecel + roll + soft * sp + this.c.dragK * sp * sp) * h;
      // Soft ground under one side holds that side back and slews the car
      // toward it (each wheel carrying half its axle's share of the weight),
      // as far as the drag it adds actually slows the car.
      const pull = ((gF.rollingDiff + gF.dragDiff * sp) * b + (gR.rollingDiff + gR.dragDiff * sp) * a) / L;
      if (pull !== 0) {
        const ahead = (this.vel.x * fx + this.vel.z * fz) / sp;
        this.yawRate += ((pull * (m / 2) * this.c.cornerX * ahead) / this.c.yawInertia) * Math.min(1, sp / decel) * h;
      }
      const s2 = moveToward(sp, 0, decel) / sp;
      this.vel.x *= s2;
      this.vel.z *= s2;
    }

    // Diagnostics for the debug tools.
    const ax = (this.vel.x - vx0) / h;
    const az = (this.vel.z - vz0) / h;
    this.accelLong = ax * fx + az * fz;
    this.accelLat = ax * lx + az * lz;
    const aids = this.aids;
    aids.abs = abs && footAsked > 0 ? MathUtils.clamp(1 - footGiven / footAsked, 0, 1) : 0;
    aids.tc = driveAsked > 0 ? MathUtils.clamp(1 - drive / driveAsked, 0, 1) : 0;
    aids.stability = spin;
    aids.rearm = Math.max(0, this.intent);
  }

  private clearAids(): void {
    const aids = this.aids;
    aids.abs = aids.tc = aids.stability = 0;
    aids.rearm = Math.max(0, this.intent);
  }

  /**
   * One axle's wheel speed after a substep. It is integrated implicitly against
   * the tire's longitudinal force (linearised), which is stiff next to the
   * wheels' inertia `J` (an equivalent mass at the contact patch). Brakes and
   * engine braking only ever slow the wheels toward a stop. ABS lets the foot
   * brake off while the wheels turn slower than peak slip; the handbrake and
   * engine braking have none.
   */
  private spinAxle(
    front: boolean,
    ws: number,
    drive: number,
    J: number,
    vx: number,
    vy: number,
    load: number,
    foot: number,
    hand: number,
    engineBrake: number,
    h: number,
  ): number {
    const g = this.axleSurface[front ? 0 : 1];
    const fx0 = axleTire(this.c, front, g, ws, vx, vy, load, _probe).x;
    const k = Math.max(0, (axleTire(this.c, front, g, ws + 0.05, vx, vy, load, _probe).x - fx0) / 0.05);
    ws += (h * (drive - fx0)) / (J + h * k);
    if (this.assists.abs && Math.abs(ws) < Math.abs(vx) - this.c.peakSlipRatio * g.peakSlip * Math.max(Math.abs(vx), P.tireMinSpeed)) foot = 0;
    this.footApplied = foot;
    const resist = foot + hand + engineBrake;
    return moveToward(ws, 0, (h * resist) / (J + h * k));
  }

  /**
   * Eases each axle's surface toward the mean of its two wheels' (time constant
   * `surfaceTau`), so a wheel crossing onto gravel doesn't jolt the car. After
   * a reset or a car swap it takes the surface under the wheels as it is.
   */
  private blendSurfaces(collider: Collider, dt: number): void {
    let k = 1 - Math.exp(-dt / P.surfaceTau);
    if (this.surfaceSnap) {
      const sinH = Math.sin(this.heading);
      const cosH = Math.cos(this.heading);
      for (let i = 0; i < 4; i++) {
        const [cx, cz] = this.corners[i];
        this.surface[i] = this.surfaceAt(collider, this.pos.x + cx * cosH + cz * sinH, this.pos.z - cx * sinH + cz * cosH);
      }
      this.surfaceSnap = false;
      k = 1;
    }
    for (let a = 0; a < 2; a++) {
      const g = this.axleSurface[a];
      const l = SURFACES[this.surface[2 * a]];
      const r = SURFACES[this.surface[2 * a + 1]];
      g.grip += ((l.grip + r.grip) / 2 - g.grip) * k;
      g.peakSlip += ((l.peakSlip + r.peakSlip) / 2 - g.peakSlip) * k;
      g.slideLift += ((l.slideLift + r.slideLift) / 2 - g.slideLift) * k;
      g.rolling += ((l.rolling + r.rolling) / 2 - g.rolling) * k;
      g.drag += ((l.drag + r.drag) / 2 - g.drag) * k;
      g.rollingDiff += (l.rolling - r.rolling - g.rollingDiff) * k;
      g.dragDiff += (l.drag - r.drag - g.dragDiff) * k;
    }
  }

  /**
   * The world's surface at (x, z), except in a tunnel: its virtual road is
   * asphalt whatever the map says of the ground above (a river, a park).
   */
  private surfaceAt(collider: Collider, x: number, z: number): SurfaceId {
    return this.tunnel ? 'asphalt' : collider.surfaceAt(x, z);
  }

  // --- Ground --------------------------------------------------------------

  private solveGround(collider: Collider, dt: number): void {
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    let groundCount = 0;
    let blockedCount = 0;
    if (this.debugRays) this.probes.length = 0;

    for (let i = 0; i < 4; i++) {
      const [cx, cz] = this.corners[i];
      // Car space → world: x' = cx·cos + cz·sin, z' = −cx·sin + cz·cos (rotation about +Y by ψ).
      const wx = this.pos.x + cx * cosH + cz * sinH;
      const wz = this.pos.z - cx * sinH + cz * cosH;
      this.wheelX[i] = wx;
      this.wheelZ[i] = wz;
      const h = this.cornerH[i];
      // Probe from the wheel's last ground height so canopy/overpasses above are
      // ignored. In the air, probe from the body instead, so decks between the
      // car and the ground it left are found rather than fallen through.
      const base = this.airborne ? Math.max(h, this.pos.y) : h;
      _o.set(wx, base + P.stepUp, wz);
      let hit = collider.cast(_o, DOWN, base - h + P.stepUp + P.probeDepth, _hit);
      // In a tunnel, the cover over the virtual road isn't ground.
      if (hit && this.tunnel && hit.point.y > this.tunnel.h + P.blobRoadTol) {
        const below = collider.castAll(_o, DOWN, base - h + P.stepUp + P.probeDepth).find((b) => b.point.y <= this.tunnel!.h + P.blobRoadTol);
        hit = below ? _hit : null;
        if (below) {
          _hit.point.copy(below.point);
          _hit.normal.copy(below.normal);
          _hit.distance = below.distance;
          _hit.object = below.object;
        }
      }
      // The top of a passable blob (a baked car) isn't ground: drive through it.
      // Judged against the road the blob sits on, or a wheel would climb a
      // gently sloped one step by step and launch off it.
      if (hit) {
        const b = this.blobAt(wx, wz);
        if (b ? hit.point.y > blobRoad(b, wx, wz) + P.blobRoadTol : hit.point.y > base + P.blobRoadTol && this.overBlob(collider, wx, wz, hit.point.y))
          hit = null;
      }
      if (!hit || hit.normal.y < P.minGroundNormalY) {
        // Steep triangles under one wheel are mesh noise more often than walls;
        // the horizontal wall probes handle real walls.
        this.probeState[i] =
          !hit && !this.airborne && !this.tunnel && !this.inBlob(wx, wz) && this.isDrop(collider, wx, wz, h) ? Probe.Drop : Probe.Miss;
      } else if (hit.point.y > base + P.maxStep) {
        this.probeState[i] = Probe.Blocked;
        blockedCount++;
        this.cornerProbeY[i] = hit.point.y;
      } else {
        this.probeState[i] = Probe.Ground;
        this.cornerProbeY[i] = hit.point.y;
        groundCount++;
      }
      if (this.debugRays) {
        const len = base - h + P.stepUp + P.probeDepth;
        this.probes.push({ x: wx, z: wz, fromY: _o.y, toY: _o.y - len, state: this.probeState[i], hitY: hit ? hit.point.y : null });
      }
    }

    // Every corner "blocked" at once is a LOD swap or a single step up, not a wall: accept it.
    if (groundCount === 0 && blockedCount === 4) {
      for (let i = 0; i < 4; i++) this.probeState[i] = Probe.Ground;
      groundCount = 4;
    }

    if (groundCount === 0) {
      // Fall back to one long ray: catches drops, roof edges, and the surface moving up under us.
      const h = this.longProbe(collider);
      if (h === null) {
        this.missTime += dt;
        if (!collider.candidateCount && this.missTime > P.freezeAfterMiss) {
          // Nothing loaded here yet: hold still until tiles arrive.
          this.waiting = true;
          this.pos.x = this.prevPos.x;
          this.pos.z = this.prevPos.z;
          this.vel.set(0, 0, 0);
          this.vy = 0;
          this.stopRotating();
        } else {
          // A hole in the mesh: carry the last ground plane on under the car.
          if (!this.airborne) this.extendGround(dt);
          this.integrateSuspension(dt);
        }
        return;
      }
      for (let i = 0; i < 4; i++) {
        this.cornerProbeY[i] = h;
        this.probeState[i] = Probe.Ground;
      }
      groundCount = 4;
      this.usedLongProbe = true;
    }
    this.missTime = 0;
    this.waiting = false;

    // Edges, judged on the wheels leading in the direction of travel (drifts slide
    // sideways): all of them blocked by a ledge too tall to climb, or any of them
    // over a drop, while other wheels still have ground. A single blocked wheel
    // is usually a kerb or mesh noise, so it rides up.
    const leading = this.leadingCorners(sinH, cosH);
    const blockedLead = leading.length > 0 && leading.every((i) => this.probeState[i] === Probe.Blocked);
    const dropLead = groundCount >= 2 && leading.some((i) => this.probeState[i] === Probe.Drop);
    if (groundCount > 0 && (blockedLead || dropLead)) {
      const edge = blockedLead ? Probe.Blocked : Probe.Drop;
      this.edge = blockedLead ? Edge.Blocked : Edge.Drop;
      this.hitEdge(leading.filter((i) => this.probeState[i] === edge), sinH, cosH);
    } else {
      for (let i = 0; i < 4; i++) if (this.probeState[i] === Probe.Blocked) this.probeState[i] = Probe.Ground;
    }
    for (let i = 0; i < 4; i++) if (this.probeState[i] === Probe.Ground) this.surface[i] = this.surfaceAt(collider, this.wheelX[i], this.wheelZ[i]);

    // Fill missing/blocked corners from the ones that found ground.
    let fill = 0;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      if (this.probeState[i] === Probe.Ground) {
        fill += this.cornerProbeY[i];
        n++;
      }
    }
    fill /= n;
    const hts = this.cornerScratch;
    for (let i = 0; i < 4; i++) hts[i] = this.probeState[i] === Probe.Ground ? this.cornerProbeY[i] : fill;
    rejectOutlier(hts);
    for (let i = 0; i < 4; i++) this.cornerH[i] = hts[i];

    // Plane fit.
    const hFront = (hts[0] + hts[1]) / 2;
    const hRear = (hts[2] + hts[3]) / 2;
    const hLeft = (hts[0] + hts[2]) / 2;
    const hRight = (hts[1] + hts[3]) / 2;
    const slopeF = (hFront - hRear) / (2 * this.c.cornerZ);
    const slopeL = (hLeft - hRight) / (2 * this.c.cornerX);
    this.pitch = MathUtils.clamp(Math.atan(slopeF), -P.maxTilt, P.maxTilt);
    this.roll = MathUtils.clamp(Math.atan(slopeL), -P.maxTilt, P.maxTilt);
    // Height gradient in world XZ = slopeF·forward + slopeL·left.
    const gx = slopeF * -sinH + slopeL * -cosH;
    const gz = slopeF * -cosH + slopeL * sinH;
    const target = new Vector3(-gx, 1, -gz).normalize();
    this.groundNormal.lerp(target, 1 - Math.exp(-dt / 0.1)).normalize();

    // Rough ground rocks and lifts the body. It stays out of the plane fit (a
    // bump is no slope to roll down) and out of cornerH (which the next probes
    // start from and steps are judged against): its tilt goes to ridePitch and
    // rideRoll, which the car model adds as they are (its 80 ms easing of the
    // plane's pitch and roll would swallow a cobble), its height to the springs.
    // Bumps that come faster than the body can follow (P.bumpHz) are soaked up
    // by the tires and springs; it also keeps short ones from aliasing into
    // random shake once a step covers most of a bump.
    let lift = 0;
    this.ridePitch = this.rideRoll = 0;
    if (!this.airborne) {
      const bump = this.bumpScratch;
      for (let i = 0; i < 4; i++) {
        const s = SURFACES[this.surface[i]];
        const follow = Math.min(1, (P.bumpHz * s.bumpLength) / Math.max(this.speed, 1e-3));
        bump[i] = s.bump > 0 ? s.bump * follow * bumpNoise(this.wheelX[i] / s.bumpLength, this.wheelZ[i] / s.bumpLength) : 0;
      }
      this.ridePitch = (bump[0] + bump[1] - bump[2] - bump[3]) / (4 * this.c.cornerZ);
      this.rideRoll = (bump[0] + bump[2] - bump[1] - bump[3]) / (4 * this.c.cornerX);
      lift = (bump[0] + bump[1] + bump[2] + bump[3]) / 4;
    }
    const newGround = (hts[0] + hts[1] + hts[2] + hts[3]) / 4 + lift;
    const gv = (newGround - this.groundY) / dt;
    this.groundVel += (MathUtils.clamp(gv, -30, 30) - this.groundVel) * (1 - Math.exp(-dt / 0.05));
    this.groundY = newGround;
    this.integrateSuspension(dt);
  }

  private readonly cornerProbeY = [0, 0, 0, 0];
  /** Set while inside a tunnel the portal test let the car into. */
  tunnel: Tunnel | null = null;
  private ghostTunnel: GhostTunnelPoint[] | null = null;
  /** Road heights behind the car on real ground (a point a metre), for a tunnel's starting grade. */
  private readonly roadTrail: Array<{ x: number; y: number; z: number }> = [];
  private readonly overpassCache = new Map<string, boolean>();
  private readonly blobCache = new Map<string, Blob | null>();
  /** Recently passed blobs: probes ignore their surfaces. */
  private readonly blobs: Blob[] = [];
  private readonly cornerScratch = [0, 0, 0, 0];
  private readonly bumpScratch = [0, 0, 0, 0];

  /** Zeroes everything that turns: wheels, yaw, tire state, engine (to idle in 1st). */
  private stopRotating(): void {
    this.wheelSpeed = this.rollSpeed = this.wheelSpin = this.yawRate = this.accelF = 0;
    this.steer = this.steerCmd = 0;
    const t = this.tire;
    t.slipF = t.slipR = t.slideF = t.slideR = 0;
    t.forceF[0] = t.forceF[1] = t.forceR[0] = t.forceR[1] = 0;
    this.accelLong = this.accelLat = 0;
    this.clearAids();
    this.drivetrain.matchSpeed(0);
  }

  /** Moves the ground estimate along the last ground plane by this step's motion. */
  private extendGround(dt: number): void {
    const n = this.groundNormal;
    // Height gradient is −(n.x, n.z) / n.y; slopes past ~25° are capped there.
    const dy = -(n.x * (this.pos.x - this.prevPos.x) + n.z * (this.pos.z - this.prevPos.z)) / Math.max(n.y, 0.9);
    this.groundY += dy;
    this.groundVel = dy / dt;
    for (let i = 0; i < 4; i++) this.cornerH[i] += dy;
  }

  /** Highest walkable surface under the car that is not far above it, or null. */
  private longProbe(collider: Collider): number | null {
    _o.set(this.pos.x, this.pos.y + 25, this.pos.z);
    const hits = collider.castAll(_o, DOWN, 25 + 80);
    let found: number | null = null;
    for (const h of hits) {
      if (h.point.y > this.groundY + P.blobRoadTol && this.inBlob(h.point.x, h.point.z)) continue;
      if (h.point.y <= this.pos.y + 3 && h.normal.y >= P.minGroundNormalY) {
        found = h.point.y;
        break;
      }
    }
    // Inside a tunnel the road is virtual, unless real road turns up at about its height.
    if (this.tunnel) {
      const v = this.tunnelRoad(collider);
      return found !== null && found <= v + 0.45 && found >= v - 1.5 ? found : v;
    }
    return found;
  }

  /**
   * True if walkable ground under (x, z) is more than `dropHeight` below `h` and
   * the surface doesn't resume just beyond in the direction of travel (that
   * would be a hole in the mesh, which photogrammetry decks do have).
   */
  private isDrop(collider: Collider, x: number, z: number, h: number): boolean {
    _o.set(x, h + P.stepUp, z);
    const below = collider.castAll(_o, DOWN, 60).find((b) => b.normal.y >= P.minGroundNormalY);
    if (!below || below.point.y >= h - P.dropHeight) return false;
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp < 0.05) return true;
    _o.set(x + (this.vel.x / sp) * 1.5, h + P.stepUp, z + (this.vel.z / sp) * 1.5);
    const beyond = collider.cast(_o, DOWN, P.stepUp + P.probeDepth);
    return !beyond || beyond.normal.y < P.minGroundNormalY || beyond.point.y < h - P.maxStep * 2;
  }

  /** Corner indices on the side the car is moving toward. */
  private leadingCorners(sinH: number, cosH: number): number[] {
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp < 0.05) return [];
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [cx, cz] = this.corners[i];
      const ox = cx * cosH + cz * sinH;
      const oz = -cx * sinH + cz * cosH;
      if ((ox * this.vel.x + oz * this.vel.z) / sp > 0.3) out.push(i);
    }
    return out;
  }

  /** Suspension pushes only; gravity pulls. Gives natural crests, jumps and landings. */
  private integrateSuspension(dt: number): void {
    const gap = this.pos.y - this.groundY;
    const spring = P.suspensionK * -gap + P.suspensionC * (this.groundVel - this.vy);
    const support = gap < P.airborneGap * 2 ? Math.max(0, G + spring) : 0;
    this.vy += (support - G) * dt;
    this.pos.y += this.vy * dt;
    // Bump stop.
    if (this.pos.y < this.groundY - 0.3) {
      this.pos.y = this.groundY - 0.3;
      this.vy = Math.max(this.vy, this.groundVel);
    }
    const wasAirborne = this.airborne;
    this.airborne = this.pos.y - this.groundY > P.airborneGap;
    if (wasAirborne && !this.airborne) this.events.onLand?.(Math.max(0, this.groundVel - this.vy));
  }

  // --- Walls ---------------------------------------------------------------

  private solveWalls(collider: Collider, dt: number): void {
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp < 0.05) return;
    const dx = this.vel.x / sp;
    const dz = this.vel.z / sp;
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const fx = -sinH;
    const fz = -cosH;
    const lx = -cosH;
    const lz = sinH;
    // Rays run along the motion direction from points across the car's width.
    // Each ray's reach is the car outline's extent along that line, so a rotated
    // (drifting) body neither collides early nor leaves gaps between rays.
    const px = -dz;
    const pz = dx;
    const df = dx * fx + dz * fz;
    const dl = dx * lx + dz * lz;
    const pf = px * fx + pz * fz;
    const pl = px * lx + pz * lz;
    const pext = this.c.halfLength * Math.abs(pf) + this.c.halfWidth * Math.abs(pl);
    // In the air, probe from the body, not from the ground far below.
    const y = Math.max(this.groundY, this.pos.y) + P.wallProbeHeight;
    _d.set(dx, 0, dz);

    let bestPen = 0;
    for (let r = 0; r < WALL_RAYS.length; r++) {
      const q = WALL_RAYS[r] * pext;
      const reach = supportAlong(q * pf, df, this.c.halfLength, q * pl, dl, this.c.halfWidth);
      if (reach === null) continue;
      _o.set(this.pos.x + px * q, y, this.pos.z + pz * q);
      const length = reach + sp * dt + 0.3;
      const meshHit = collider.cast(_o, _d, length);
      const ghostHit = this.ghostTunnelWall(_o, dx, dz, length);
      const isGhost = !!ghostHit && (!meshHit || ghostHit.distance < meshHit.distance);
      const hit = isGhost ? ghostHit : meshHit;
      let verdict: WallRayDebug['verdict'] = 'clear';
      if (hit && Math.abs(hit.normal.y) > P.wallMaxNormalY) verdict = 'steep-floor';
      else if (hit && hit.distance >= reach + 0.05) verdict = 'beyond';
      else if (hit) {
        const pen = reach + 0.03 - hit.distance;
        if (pen <= bestPen) verdict = 'wall-minor';
        else if (!isGhost && (this.inBlob(hit.point.x, hit.point.z) || this.isBlob(collider, hit.point.x, hit.point.z, dx, dz, hit.point.y)))
          verdict = 'blob';
        else if (!isGhost && meshHit && this.isOverpass(collider, meshHit, dx, dz)) verdict = 'overpass';
        else {
          verdict = 'wall';
          bestPen = pen;
          this.wall.point.copy(hit.point);
          this.wall.normal.copy(hit.normal);
          this.wall.geometricError = isGhost
            ? -1
            : (meshHit?.object.userData.tile as { geometricError?: number } | undefined)?.geometricError ?? -1;
          const w = this.wall;
          w.ray = r;
        }
      }
      if (this.debugRays) {
        this.rays.push({
          origin: [_o.x, _o.y, _o.z],
          dir: [dx, dz],
          reach,
          length,
          hit: hit ? { point: hit.point.toArray(), normal: hit.normal.toArray(), distance: hit.distance } : null,
          verdict,
        });
      }
    }
    if (bestPen === 0) return;
    this.wall.pen = bestPen;

    const n = this.wall.normal;
    n.y = 0;
    if (n.lengthSq() < 1e-6) n.set(-dx, 0, -dz);
    n.normalize();
    if (n.x * dx + n.z * dz > 0) n.negate();
    // `bestPen` is measured along the motion; the depth into the wall is that
    // times the cosine to its normal. Backing up the full ray distance would stop
    // a car grazing a barrier dead instead of letting it slide along.
    const depth = bestPen * Math.max(0.1, -(n.x * dx + n.z * dz));
    this.pos.x += n.x * depth;
    this.pos.z += n.z * depth;
    this.collide(n.x, n.z);
  }

  private blobAt(x: number, z: number): Blob | null {
    for (const b of this.blobs) if ((x - b.x) ** 2 + (z - b.z) ** 2 < b.r * b.r) return b;
    return null;
  }

  private inBlob(x: number, z: number): boolean {
    return this.blobAt(x, z) !== null;
  }

  /**
   * A probe hit `y` above a wheel at (x, z) is on a blob: one already known, or
   * one the blob test accepts looking along the direction of travel.
   */
  private overBlob(collider: Collider, x: number, z: number, y: number): boolean {
    if (y > this.roadPlane(x, z) + P.blobMaxHeight) return false;
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp < 0.5) return false;
    const dx = this.vel.x / sp;
    const dz = this.vel.z / sp;
    return this.isBlob(collider, x - dx * 0.5, z - dz * 0.5, dx, dz, y);
  }

  /**
   * True if an obstacle at (x, z), met moving along (dx, dz), is a car-sized
   * blob on flat road: photogrammetry bakes in parked cars and smears moving
   * ones into translucent "ghosts", both solid lumps in the mesh. A level ray
   * just above car-roof height must pass clear over it (a facade, bus or
   * overpass curtain stops it), and the surface below that height must be back
   * at road level within `blobMaxDepth` ahead and `blobMaxHalfWidth` to either
   * side. Long barriers and kerb walls fail the width test. Skyways, decks and
   * canopy overhead don't matter. The lump's top must reach about `hitY` (where
   * the probe met it): a facade with a floor behind it has no top at all.
   * Cached per spot, like the overpass test.
   */
  /** Height of the plane of the road under the car at (x, z): its ground height, tilted by its ground normal. */
  private roadPlane(x: number, z: number): number {
    const n = this.groundNormal;
    return this.groundY - (n.x * (x - this.pos.x) + n.z * (z - this.pos.z)) / n.y;
  }

  private isBlob(collider: Collider, x: number, z: number, dx: number, dz: number, hitY: number): boolean {
    if (this.airborne || this.groundNormal.y < P.blobGroundNormalY) return false;
    const key = `${Math.round(x / 1.5)},${Math.round(z / 1.5)},${Math.round(Math.atan2(dx, dz) / (Math.PI / 4))}`;
    const cached = this.blobCache.get(key);
    if (cached !== undefined) {
      if (cached && !this.blobs.includes(cached)) this.addBlob(cached);
      return cached !== null;
    }
    if (this.blobCache.size > 512) this.blobCache.clear();

    const g = this.groundY;
    const tol = P.blobRoadTol;
    const clear = P.blobMaxHeight + 0.3;
    const samples: OverpassDecision['samples'] = [];
    // Highest surface below the clearance height, above the road's plane.
    const topAt = (px: number, pz: number, d: number, phase: 'along' | 'side') => {
      const road = this.roadPlane(px, pz);
      const h = collider.castColumn(px, pz, road + clear, clear + 3)[0];
      const t = h ? h.point.y - road : null;
      samples.push([d, t, phase]);
      return t;
    };
    let reason: OverpassDecision['reason'] = 'blob-too-long';
    let depth = -1;
    let peak = -Infinity;
    for (let s = 0.25; s <= P.blobMaxDepth + 0.5; s += 0.5) {
      const t = topAt(x + dx * s, z + dz * s, s, 'along');
      if (t !== null) peak = Math.max(peak, t);
      if (t !== null && t > P.blobMaxHeight) {
        reason = 'blob-too-tall';
        break;
      }
      // No surface at all here (a hole, or inside the lump's shell): keep looking.
      // Road again, twice in a row (once is enough a car's length in: the
      // next lump of a parked row is its own).
      if (t !== null && Math.abs(t) < tol) {
        if (s >= P.blobRowGap) {
          depth = s;
          break;
        }
        const t2 = topAt(x + dx * (s + 0.75), z + dz * (s + 0.75), s + 0.75, 'along');
        if (t2 !== null && Math.abs(t2) < tol) {
          depth = s;
          break;
        }
      }
    }
    let blob: Blob | null = null;
    const mid = Math.max(0.25, depth / 2);
    if (depth >= 0 && peak < hitY - this.roadPlane(x, z) - P.blobTopSlack) {
      reason = 'blob-no-top';
      depth = -1;
    }
    if (depth >= 0) {
      // Over the lump only, so a building just beyond it doesn't count; along
      // the road's slope, so a hill ahead doesn't either.
      const bx = x - dx * 1.5;
      const bz = z - dz * 1.5;
      _bo.set(bx, this.roadPlane(bx, bz) + clear, bz);
      const n = this.groundNormal;
      _bd.set(dx, -(n.x * dx + n.z * dz) / n.y, dz);
      const len = _bd.length();
      _bd.divideScalar(len);
      if (collider.castWide(_bo, _bd, (depth + 2) * len)) {
        reason = 'blob-too-tall';
        depth = -1;
      }
    }
    if (depth >= 0) {
      const mx = x + dx * mid;
      const mz = z + dz * mid;
      let half = 0;
      reason = 'blob';
      for (const side of [-1, 1]) {
        let found = -1;
        for (let k = 0.75; k <= P.blobMaxHalfWidth + 0.01; k += 0.75) {
          const t = topAt(mx - dz * side * k, mz + dx * side * k, side * k, 'side');
          if (t !== null && t > P.blobMaxHeight) break;
          if (t !== null && Math.abs(t) < tol) {
            found = k;
            break;
          }
        }
        if (found < 0) {
          reason = 'blob-too-wide';
          break;
        }
        half = Math.max(half, found);
      }
      const n = this.groundNormal;
      if (reason === 'blob') blob = { x: mx, z: mz, r: Math.max(mid, half) + 0.6, ground: this.roadPlane(mx, mz), gx: -n.x / n.y, gz: -n.z / n.y };
    }
    this.blobCache.set(key, blob);
    if (blob) this.addBlob(blob);
    this.events.onOverpass?.({ hit: [x, g, z], dir: [dx, dz], groundY: g, result: !!blob, reason, start: -1, deck: 0, samples, mid });
    return blob !== null;
  }

  private addBlob(b: Blob): void {
    this.blobs.push(b);
    if (this.blobs.length > 24) this.blobs.shift();
  }

  /**
   * True if a wall probe hit is the curtain under an overpass (or a skyway/awning)
   * rather than a building. Ray tests at the hit can't tell them apart — Google's
   * mesh has floors under buildings and curtains reaching the road — so judge the
   * structure's shape from above: a flat deck 3.5–9 m up (within a few metres of
   * the hit), with ground beneath, that ends within ~40 m with the surface back
   * near road level. Results are
   * cached per spot since probes hit the same place every step.
   */
  private isOverpass(collider: Collider, hit: RayHit, dx: number, dz: number): boolean {
    if (hit.object.userData.solid) return false;
    // Inside a tunnel (under its cover, or still going in) every face ahead is
    // the far portal or a wall; out from under it, the usual tests apply.
    const t = this.tunnel;
    if (t) {
      // Still going through the entry curtain and its skirt: faces under the
      // same cover pass. Not a building just past a skyway (whose roof is far
      // higher), which the usual tests judge.
      if (t.d < P.tunnelEntryGrace) {
        const c = this.coverAt(collider, hit.point.x + dx, hit.point.z + dz, t.h);
        if (c !== null && c >= t.clearance - 1.5 && c <= t.clearance + P.tunnelGraceCover) return true;
      }
      if (this.coverAt(collider, this.pos.x, this.pos.z, t.h) !== null) return this.isTunnelExit(collider, hit, dx, dz);
    }
    const key = `${Math.round(hit.point.x / 2)},${Math.round(hit.point.z / 2)},${Math.round(Math.atan2(dx, dz) / (Math.PI / 8))}`;
    const cached = this.overpassCache.get(key);
    if (cached !== undefined) return cached;
    if (this.overpassCache.size > 512) this.overpassCache.clear();

    const g = Math.max(this.groundY, this.pos.y);
    const samples: OverpassDecision['samples'] = [];
    const at = (s: number) => [hit.point.x + dx * s, hit.point.z + dz * s] as const;
    const topAt = (s: number, phase: 'skirt' | 'far') => {
      const [x, z] = at(s);
      const h = collider.castColumn(x, z, g + 80, 160).find((h) => h.normal.y > 0.6);
      const t = h ? h.point.y - g : null;
      samples.push([s, t, phase]);
      return t;
    };
    let result = false;
    let reason: OverpassDecision['reason'] = 'no-deck';
    // The curtain often ends in a low sloped skirt a few metres before the deck
    // edge; step over anything under 2 m until the deck starts.
    let start = -1;
    let deck = 0;
    for (let s = 1; s <= P.overpassSkirt; s += 1.5) {
      const t = topAt(s, 'skirt');
      if (t === null) continue; // steep skirt face: no walkable top here
      if (t >= P.skywayMaxDeck) break;
      if (t >= P.overpassMinDeck) {
        start = s;
        deck = t;
        break;
      }
      if (t > 2) break;
    }
    if (start >= 0) {
      const [xf, zf] = at(start + 1);
      const floor = collider
        .castColumn(xf, zf, g + 1.6, 2.6)
        .some((h) => h.normal.y >= P.minGroundNormalY && Math.abs(h.point.y - g) <= P.maxStep);
      reason = floor ? 'deck-runs-on' : 'no-floor';
      // A deck above overpassMaxDeck is only a skyway if it is narrow.
      const maxDepth = deck > P.overpassMaxDeck ? P.skywayMaxDepth : P.overpassMaxDepth;
      for (let s = start + 3; floor && s <= start + maxDepth; s += 3) {
        const t = topAt(s, 'far');
        if (t === null) {
          reason = 'no-data';
          break;
        }
        if (Math.abs(t - deck) <= P.overpassDeckTolerance) continue;
        result = t < deck - 3 && t > -3 && t < 2;
        reason = 'far-side';
        break;
      }
    }
    if (!result) {
      // Too deep for an overpass: maybe a wide underpass or a tunnel portal.
      const portal = this.isPortal(collider, hit, dx, dz, g, reason);
      // A curtain pass isn't cached: it has to start tunnel mode every time.
      if (!portal || !this.tunnel) this.overpassCache.set(key, portal);
      return portal;
    }
    this.overpassCache.set(key, result);
    this.events.onOverpass?.({ hit: hit.point.toArray(), dir: [dx, dz], groundY: g, result, reason, start, deck, samples });
    return result;
  }

  /** Height of the lowest surface at least portalMinCover above `y` over (x, z), relative to `y`, or null. */
  private coverAt(collider: Collider, x: number, z: number, y: number): number | null {
    const hs = collider.castColumn(x, z, y + 60, 60 - P.portalMinCover);
    return hs.length ? hs[hs.length - 1].point.y - y : null;
  }

  /** Walkable surface within `tol` of `y` at (x, z). */
  private floorAt(collider: Collider, x: number, z: number, y: number, tol: number): boolean {
    const top = Math.max(1.6, tol + 0.5);
    return collider.castColumn(x, z, y + top, top + tol).some((h) => h.normal.y >= P.minGroundNormalY && Math.abs(h.point.y - y) <= tol);
  }

  /**
   * True if a wall hit too deep for the overpass test is the curtain of a wide
   * underpass or a tunnel portal. The cover over it must be low and the face
   * must lean toward the car: decks and portals do, facades are vertical. With
   * the road reconstructed under the cover (stacked freeway decks), the road
   * must also run on under it until it ends or for portalFloorRun. With no road
   * under it (photogrammetry can't see into tunnels and covered roadways), a
   * pass starts tunnel mode.
   */
  private isPortal(collider: Collider, hit: RayHit, dx: number, dz: number, g: number, overpass: OverpassDecision['reason']): boolean {
    const at = (s: number) => [hit.point.x + dx * s, hit.point.z + dz * s] as const;
    const samples: OverpassDecision['samples'] = [];
    let start = -1;
    let cover = 0;
    for (let s = 1; s <= P.overpassSkirt; s += 1.5) {
      const c = this.coverAt(collider, ...at(s), g);
      samples.push([s, c, 'skirt']);
      if (c !== null) {
        start = s;
        cover = c;
        break;
      }
    }
    let result = false;
    let reason: OverpassDecision['reason'] = 'portal-no-cover';
    let lean: OverpassDecision['lean'];
    if (start >= 0) {
      const floored = this.floorAt(collider, ...at(start + 1), g, P.portalFloorTol) && this.floorAt(collider, ...at(start + 3), g, P.portalFloorTol);
      const leans = () => {
        lean = this.leanRays(collider, hit, dx, dz, g);
        const [low, , high] = lean;
        return !!low && !!high && lean.every(Boolean) && low[0] - high[0] >= P.portalLean && lean.some((l) => !!l && l[1] <= P.portalLeanNy);
      };
      if (floored) {
        // The road is reconstructed under the cover. It must run on until the
        // cover ends or for portalFloorRun, and the cover must look like a deck:
        // flat and low enough to drive under, a slab (a deck's top and underside
        // both in the mesh) over enough of the run, or with a leaning face. The
        // mesh has floors under some buildings, whose roofs step about.
        reason = cover > P.portalMaxCoverFloored ? 'portal-high' : 'portal-floor-ends';
        let miss = 0;
        let columns = 0;
        let slabs = 0;
        const covers: number[] = [];
        for (let s = start + 3; cover <= P.portalMaxCoverFloored && s <= start + 150; s += 3) {
          const [x, z] = at(s);
          // The road may climb or fall a little under the cover.
          if (!this.floorAt(collider, x, z, g, P.portalFloorTol + 0.04 * (s - start))) {
            samples.push([s, null, 'far']);
            if (++miss >= 2) break;
            continue;
          }
          miss = 0;
          const c = this.coverAt(collider, x, z, g);
          samples.push([s, c, 'far']);
          columns++;
          if (c !== null) covers.push(c);
          if (c !== null && this.hasSlab(collider, x, z, g)) slabs++;
          if (c === null || s - start >= P.portalFloorRun) {
            covers.sort((p, q) => p - q);
            const q = (f: number) => covers[Math.min(covers.length - 1, Math.floor(f * covers.length))];
            const flat =
              covers.length >= 3 &&
              cover <= P.portalMaxCover &&
              q(0.5) >= P.portalMinClearance &&
              q(0.5) <= P.portalMaxCover &&
              q(0.9) - q(0.1) <= P.portalDeckFlatness;
            if (flat || slabs >= P.portalSlabShare * columns || leans()) {
              result = true;
              reason = c === null ? 'portal-floored' : 'portal-floored-long';
            } else reason = 'portal-vertical';
            break;
          }
        }
      }
      if (!floored || reason === 'portal-floor-ends') {
        // No road under the cover (or road only under its edge): a tunnel or
        // covered roadway, if the cover is high enough to drive under along its
        // length (parking decks are lower) and the face leans toward the car.
        let median = Infinity;
        for (const off of [-1.5, 0, 1.5]) {
          const cs: number[] = [];
          for (let s = start + 4; s <= start + 20; s += 4) {
            const [x, z] = at(s);
            const c = this.coverAt(collider, x - dz * off, z + dx * off, g);
            if (c !== null) cs.push(c);
            if (off === 0) samples.push([s, c, 'lid']);
          }
          cs.sort((p, q) => p - q);
          median = Math.min(median, cs.length ? cs[cs.length >> 1] : cover);
        }
        if (cover > P.portalMaxCover) reason = 'portal-high';
        else if (median < P.portalMinClearance) reason = 'portal-low';
        // A tunnel's lid or a covered roadway's deck runs on at about the
        // portal's height; behind a building's overhang the cover jumps to its
        // roof (and the hollow shell has nothing inside to hit).
        else if (median > cover + P.portalLidRise) reason = 'portal-building';
        else if (leans()) {
          result = true;
          reason = 'portal-curtain';
          this.enterTunnel(cover, g);
        } else reason = 'portal-vertical';
      }
    }
    this.events.onOverpass?.({ hit: hit.point.toArray(), dir: [dx, dz], groundY: g, result, reason, start, deck: cover, samples, lean, overpass });
    return result;
  }

  /** Two surfaces 0.3–2.5 m apart above the cover height at (x, z): a deck's top and its underside. */
  private hasSlab(collider: Collider, x: number, z: number, y: number): boolean {
    const hs = collider.castColumn(x, z, y + 60, 60 - P.portalMinCover);
    for (let i = 1; i < hs.length; i++) {
      const gap = hs[i - 1].point.y - hs[i].point.y;
      if (gap >= 0.3 && gap <= 2.5) return true;
    }
    return false;
  }

  /** Level rays at 1.5, 3 and 4.5 m from 8 m before the hit: [distance past the hit, normal y] or null. */
  private leanRays(collider: Collider, hit: RayHit, dx: number, dz: number, g: number): Array<[number, number] | null> {
    const out: Array<[number, number] | null> = [];
    for (const up of [1.5, 3, 4.5]) {
      _bo.set(hit.point.x - dx * 8, g + up, hit.point.z - dz * 8);
      _bd.set(dx, 0, dz);
      const h = collider.castWide(_bo, _bd, 14);
      out.push(h ? [h.distance - 8, h.normal.y] : null);
    }
    return out;
  }

  /** Keeps a metre-spaced trail of the last 20 m of real road under the car. */
  private recordRoad(): void {
    if (this.airborne || this.tunnel || this.usedLongProbe) return;
    const last = this.roadTrail[this.roadTrail.length - 1];
    if (last && Math.hypot(this.pos.x - last.x, this.pos.z - last.z) < 1) return;
    this.roadTrail.push({ x: this.pos.x, y: this.groundY, z: this.pos.z });
    if (this.roadTrail.length > 20) this.roadTrail.shift();
  }

  /**
   * The road's grade coming into a portal: over the last 8–16 m of trail, so
   * a bump at the portal doesn't tilt the whole virtual road (the ground
   * normal under the car alone can be 7% off cresting one).
   */
  private approachGrade(): number {
    const tr = this.roadTrail;
    for (let i = 0; i < tr.length - 1; i++) {
      const d = Math.hypot(this.pos.x - tr[i].x, this.pos.z - tr[i].z);
      if (d <= 16 && d >= 8) return (this.groundY - tr[i].y) / d;
    }
    const n = this.groundNormal;
    const sp = Math.hypot(this.vel.x, this.vel.z) || 1;
    return -(n.x * this.vel.x + n.z * this.vel.z) / sp / n.y;
  }

  private enterTunnel(cover: number, g: number): void {
    const grade = this.approachGrade();
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const dx = speed > 0.1 ? this.vel.x / speed : -Math.sin(this.heading);
    const dz = speed > 0.1 ? this.vel.z / speed : -Math.cos(this.heading);
    const entryX = this.pos.x;
    const entryZ = this.pos.z;
    this.tunnel = {
      h: g,
      grade: MathUtils.clamp(grade, -P.tunnelMaxGrade, P.tunnelMaxGrade),
      clearance: cover,
      remeasured: false,
      cover,
      d: 0,
      scannedAt: -Infinity,
      exit: null,
      real: 0,
      open: 0,
      traced: new Set(),
      x: this.pos.x,
      z: this.pos.z,
    };
    this.ghostTunnel = [
      { x: entryX - dx * P.ghostTunnelEntryPadding, z: entryZ - dz * P.ghostTunnelEntryPadding, h: g },
      { x: entryX, z: entryZ, h: g },
    ];
  }

  private ghostTunnelWall(origin: Vector3, dx: number, dz: number, far: number): GhostTunnelWallHit | null {
    const path = this.ghostTunnel;
    if (!path || path.length < 2) return null;
    let nearest: GhostTunnelWallHit | null = null;
    const halfWidth = P.ghostTunnelWidth / 2;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const segmentLength = Math.hypot(vx, vz);
      if (segmentLength < 1e-4) continue;
      const tx = vx / segmentLength;
      const tz = vz / segmentLength;
      const leftX = -tz;
      const leftZ = tx;
      const startPadding = i === 0 ? P.ghostTunnelEntryPadding : 0;
      const endPadding = i === path.length - 2 ? P.ghostTunnelExitPadding : 0;
      for (const side of [-1, 1]) {
        const ax = a.x + side * leftX * halfWidth - tx * startPadding;
        const az = a.z + side * leftZ * halfWidth - tz * startPadding;
        const bx = b.x + side * leftX * halfWidth + tx * endPadding;
        const bz = b.z + side * leftZ * halfWidth + tz * endPadding;
        const sx = bx - ax;
        const sz = bz - az;
        const denom = dx * sz - dz * sx;
        if (Math.abs(denom) < 1e-6) continue;
        const ox = ax - origin.x;
        const oz = az - origin.z;
        const distance = (ox * sz - oz * sx) / denom;
        const along = (ox * dz - oz * dx) / denom;
        if (distance < 0 || distance > far || along < 0 || along > 1) continue;
        const road = a.h + (b.h - a.h) * along;
        if (origin.y < road - P.ghostTunnelBarrierTolerance || origin.y > road + P.ghostTunnelWallHeight + P.ghostTunnelBarrierTolerance)
          continue;
        if (nearest && distance >= nearest.distance) continue;
        nearest = {
          point: new Vector3(origin.x + dx * distance, origin.y, origin.z + dz * distance),
          normal: new Vector3(-side * leftX, 0, -side * leftZ),
          distance,
        };
      }
    }
    return nearest;
  }

  private recordGhostTunnel(t: Tunnel): void {
    const path = this.ghostTunnel;
    if (!path) return;
    const last = path[path.length - 1];
    if (Math.hypot(this.pos.x - last.x, this.pos.z - last.z) < 1) {
      last.x = this.pos.x;
      last.z = this.pos.z;
      last.h = t.h;
      return;
    }
    path.push({ x: this.pos.x, z: this.pos.z, h: t.h });
    let length = 0;
    let keepFrom = path.length - 1;
    for (let i = path.length - 1; i > 0; i--) {
      length += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      if (length > 80) {
        keepFrom = i;
        break;
      }
    }
    if (keepFrom > 0) path.splice(0, keepFrom);
  }

  /**
   * In a tunnel, a face ahead is the exit portal's curtain if the road resumes
   * within 20 m beyond it at about the virtual road's height, or a curtain
   * inside a covered roadway if the cover runs on beyond it.
   */
  private isTunnelExit(collider: Collider, hit: RayHit, dx: number, dz: number): boolean {
    const t = this.tunnel!;
    let result = false;
    let covered = 0;
    for (let s = 1; s <= 20 && !result; s += 1.5) {
      const x = hit.point.x + dx * s;
      const z = hit.point.z + dz * s;
      const c = this.coverAt(collider, x, z, t.h);
      // A curtain hanging inside a covered roadway: the same cover runs on beyond it.
      covered = s >= 3 && c !== null && c >= t.clearance - 1.5 ? covered + 1 : 0;
      if (covered >= 2) result = true;
      // The exit: road close to the virtual road's height, open above or still well under the cover.
      else if (this.floorAt(collider, x, z, t.h, P.tunnelExitTol)) result = c === null || c >= t.clearance - 1;
    }
    // Traced once per spot per verdict, per tunnel.
    const key = `${Math.round(hit.point.x / 2)},${Math.round(hit.point.z / 2)},${result}`;
    if (!t.traced.has(key)) {
      t.traced.add(key);
      this.events.onOverpass?.({
        hit: hit.point.toArray(),
        dir: [dx, dz],
        groundY: t.h,
        result,
        reason: result ? 'tunnel-exit' : 'tunnel-wall',
        start: -1,
        deck: 0,
        samples: [],
      });
    }
    return result;
  }

  /**
   * Advances the tunnel's virtual road to the car and returns its height. Every
   * tunnelScanEvery metres it looks ahead for the exit road (walkable, near
   * the road's height, open above) and for the cover overhead. With an exit in
   * sight the road ramps to meet it; otherwise it keeps its clearance under
   * the cover.
   */
  private tunnelRoad(collider: Collider): number {
    const t = this.tunnel!;
    const ds = Math.hypot(this.pos.x - t.x, this.pos.z - t.z);
    t.x = this.pos.x;
    t.z = this.pos.z;
    t.d += ds;
    if (t.d - t.scannedAt > P.tunnelScanEvery) {
      t.scannedAt = t.d;
      const exit = this.scanExit(collider, t);
      if (exit) t.exit = { ...exit, d: t.d };
      t.cover = this.coverAt(collider, this.pos.x, this.pos.z, t.h);
      // The deck edge at the portal is thicker than the lid inside: measure the clearance again once in.
      if (!t.remeasured && t.d > 10 && t.cover !== null) {
        t.clearance = t.cover;
        t.remeasured = true;
      }
    }
    let grade = t.grade;
    if (t.exit && t.d - t.exit.d < t.exit.s) grade = (t.exit.h - t.h) / Math.max(4, t.exit.s - (t.d - t.exit.d));
    else if (t.cover !== null) grade = (t.cover - t.clearance) / 30;
    t.grade = MathUtils.clamp(grade, -P.tunnelMaxGrade, P.tunnelMaxGrade);
    t.h += t.grade * ds;
    return t.h;
  }

  private scanExit(collider: Collider, t: Tunnel): { s: number; h: number } | null {
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp < 1) return null;
    const dx = this.vel.x / sp;
    const dz = this.vel.z / sp;
    let run = 0;
    let first: { s: number; h: number } | null = null;
    let prevTop: number | null = null;
    for (let s = 8; s <= P.tunnelScanRange; s += 4) {
      const tol = Math.min(0.05 * s + 1, 4);
      // Upward, stay clear of the cover itself (at least portalMinCover up).
      const up = Math.min(tol, t.clearance - 1.5);
      const hs = collider.castColumn(this.pos.x + dx * s, this.pos.z + dz * s, t.h + 30, 30 + tol + 2);
      const lidBefore = prevTop;
      if (hs.length) prevTop = hs[0].point.y;
      let road: number | null = null;
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i];
        const dy = h.point.y - t.h;
        if (h.normal.y < 0.85 || dy > up || dy < -tol) continue;
        if (i === 0 || hs[i - 1].point.y - h.point.y >= P.portalMinCover) road = h.point.y;
        break;
      }
      // The exit starts where the surface drops a portal's height from the lid
      // (otherwise the lid's own top, sloping down to the road, would pass).
      if (road === null || (!run && (lidBefore === null || lidBefore - road < P.portalMinCover))) {
        run = 0;
        continue;
      }
      if (!run) first = { s, h: road };
      if (++run >= 3) return first;
    }
    return null;
  }

  /**
   * Tunnel mode ends once the car is out from under the cover on real ground
   * (or after a long stretch on real ground, or an implausibly long tunnel):
   * while it lasts, faces ahead are judged leniently as the exit curtain.
   */
  private updateTunnel(collider: Collider): void {
    const t = this.tunnel;
    if (!t) return;
    if (!this.usedLongProbe) {
      // Real ground under the car (the portal apron, the exit road): the road follows it.
      t.d += Math.hypot(this.pos.x - t.x, this.pos.z - t.z);
      t.x = this.pos.x;
      t.z = this.pos.z;
      // Follow real road down or level, never up: a sloped curtain skirt would ratchet it.
      if (this.groundY <= t.h + 0.1) t.h = this.groundY;
      t.real++;
    } else t.real = 0;
    // Open sky overhead, on real ground or the virtual road: out of the tunnel
    // (its lid is always in the mesh), or past a skyway taken for a portal.
    t.open = this.coverAt(collider, this.pos.x, this.pos.z, t.h) === null ? t.open + 1 : 0;
    // (Real ground only counts once the car has been on the virtual road: a
    // tunnel can start with road under the cover's edge.)
    const onVirtual = t.scannedAt > -Infinity;
    const ended = (t.open > 10 && t.d > 10) || (onVirtual && t.real > 60 && t.d > 15) || t.d > P.tunnelMaxLength;
    if (!ended) this.recordGhostTunnel(t);
    if (ended) {
      this.tunnel = null;
      this.ghostTunnel = null;
    }
  }

  /**
   * Reverts horizontal motion and bounces off an edge (ledge or drop) under the
   * given corners. The wall normal points from those corners back toward the
   * car's centre, so grazing an edge slides along it instead of stopping dead.
   */
  private hitEdge(corners: number[], sinH: number, cosH: number): void {
    this.pos.x = this.prevPos.x;
    this.pos.z = this.prevPos.z;
    let ox = 0;
    let oz = 0;
    for (const i of corners) {
      const [cx, cz] = this.corners[i];
      ox += cx * cosH + cz * sinH;
      oz += -cx * sinH + cz * cosH;
    }
    const len = Math.hypot(ox, oz);
    if (len > 1e-6) {
      this.collide(-ox / len, -oz / len);
    } else {
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > 1e-4) this.collide(-this.vel.x / sp, -this.vel.z / sp);
    }
    for (const i of corners) this.probeState[i] = Probe.Miss;
  }

  private collide(nx: number, nz: number): void {
    const vn = this.vel.x * nx + this.vel.z * nz;
    this.contact = true;
    if (vn >= 0) return;
    const tx = this.vel.x - vn * nx;
    const tz = this.vel.z - vn * nz;
    const keep = 1 - P.wallFriction * Math.min(1, -vn / 10);
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const vF = this.vel.x * fx + this.vel.z * fz;
    this.vel.x = tx * keep - P.wallRestitution * vn * nx;
    this.vel.z = tz * keep - P.wallRestitution * vn * nz;
    // The wheels lose the forward speed the car did: a rolling or locked wheel
    // scales down with it, a spinning one keeps its slip.
    const vFa = this.vel.x * fx + this.vel.z * fz;
    const hit = (ws: number) => (ws * vF >= 0 && Math.abs(ws) <= Math.abs(vF) ? (vF === 0 ? 0 : ws * MathUtils.clamp(vFa / vF, 0, 1)) : ws - (vF - vFa));
    this.wheelSpeed = hit(this.wheelSpeed);
    this.rollSpeed = hit(this.rollSpeed);
    // Glancing hits nudge the nose along the wall.
    this.yawRate *= 0.5;
    const impact = -vn;
    if (impact > this.impact) this.impact = impact;
    if (impact > P.impactThreshold) this.events.onImpact?.(impact);
  }
}

const WALL_RAYS = [-0.92, -0.46, 0, 0.46, 0.92];

/**
 * How far the car's rectangle extends along a ray t·(du, dv) from (u0, v0), in
 * car axes, where the rectangle is |u| <= a, |v| <= b. Null if the ray misses it.
 */
function supportAlong(u0: number, du: number, a: number, v0: number, dv: number, b: number): number | null {
  let lo = -Infinity;
  let hi = Infinity;
  for (const [o, c, half] of [
    [u0, du, a],
    [v0, dv, b],
  ]) {
    if (Math.abs(c) < 1e-6) {
      if (Math.abs(o) > half) return null;
      continue;
    }
    const t1 = (-half - o) / c;
    const t2 = (half - o) / c;
    lo = Math.max(lo, Math.min(t1, t2));
    hi = Math.min(hi, Math.max(t1, t2));
  }
  return hi >= lo ? hi : null;
}

function moveToward(v: number, target: number, maxDelta: number): number {
  if (Math.abs(target - v) <= maxDelta) return target;
  return v + Math.sign(target - v) * maxDelta;
}

/**
 * Replaces one corner that sits on a blob (parked car, bollard, noise) with the
 * plane through the other three. A planar rectangle satisfies FL + RR = FR + RL;
 * the residual can't say which corner is off, so pick the one furthest from the median.
 */
function rejectOutlier(h: number[]): void {
  if (Math.abs(h[0] + h[3] - h[1] - h[2]) < P.outlierThreshold) return;
  const sorted = [...h].sort((a, b) => a - b);
  const median = (sorted[1] + sorted[2]) / 2;
  let worst = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(h[i] - median) > Math.abs(h[worst] - median)) worst = i;
  if (Math.abs(h[worst] - median) > P.outlierThreshold) h[worst] = predictCorner(h, worst);
}

function predictCorner(h: number[], i: number): number {
  switch (i) {
    case 0:
      return h[1] + h[2] - h[3];
    case 1:
      return h[0] + h[3] - h[2];
    case 2:
      return h[0] + h[3] - h[1];
    default:
      return h[1] + h[2] - h[0];
  }
}

/**
 * Smooth value noise in −1…1 on a unit lattice, hashed from the position, so
 * the same bumps come back every time a wheel rolls over them.
 */
function bumpNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const u = x - ix;
  const v = z - iz;
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  const a = lattice(ix, iz);
  const b = lattice(ix + 1, iz);
  const c = lattice(ix, iz + 1);
  const d = lattice(ix + 1, iz + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

/** A lattice point's value, −1…1. */
function lattice(ix: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 2147483647.5 - 1;
}

/** A slide factor (slideFront/slideRear) on ground that loses less grip past the peak. */
function slideOn(slide: number, g: AxleSurface): number {
  return slide + (1 - slide) * g.slideLift;
}

/**
 * Tire force as a share of peak for normalised slip `s` (1 = peak): a smooth
 * rise to the peak, then a fall to `slide` by s = 3.
 */
/**
 * Share of peak grip a tire gives at normalised slip `s` (1 = peak slip),
 * falling to `slide` well past the peak. Exported for the tuning plots.
 */
export function tireCurve(s: number, slide: number): number {
  if (s < 1) return s * (2 - s);
  return 1 - (1 - slide) * MathUtils.smoothstep(s, 1, 3);
}

interface AxleForce {
  x: number;
  y: number;
  /** Past the peak of the combined slip. */
  sliding: boolean;
}

const _front: AxleForce = { x: 0, y: 0, sliding: false };
const _rear: AxleForce = { x: 0, y: 0, sliding: false };
const _probe: AxleForce = { x: 0, y: 0, sliding: false };

/**
 * Axle force (in the wheels' frame: x along them, y left) under `load` for
 * wheel surface speed `ws` over ground moving at (vx, vy) under the tire, into
 * `out`. Longitudinal and lateral slip are normalised by their peaks and
 * combined, and the force points against the combined slip (scaled to an
 * ellipse of muRear forward, muRearSide sideways at the rear; muFront both ways
 * at the front), so wheelspin or a locked wheel leaves little sideways grip.
 * The surface `g` scales the grip and the peaks, and softens the fall past them.
 */
function axleTire(c: ChassisSpec, front: boolean, g: AxleSurface, ws: number, vx: number, vy: number, load: number, out: AxleForce): AxleForce {
  const ref = Math.max(Math.abs(vx), P.tireMinSpeed);
  const sx = (ws - vx) / ref / (c.peakSlipRatio * g.peakSlip);
  const sy = vy / ref / (Math.tan(c.peakSlipAngle) * g.peakSlip);
  const s = Math.hypot(sx, sy);
  if (s < 1e-6) {
    out.x = out.y = 0;
    out.sliding = false;
    return out;
  }
  const f = (load * tireCurve(s, slideOn(front ? c.slideFront : c.slideRear, g))) / s;
  out.x = (front ? c.muFront : c.muRear) * g.grip * f * sx;
  out.y = -(front ? c.muFront : c.muRearSide) * g.grip * f * sy;
  out.sliding = s > 1;
  return out;
}
