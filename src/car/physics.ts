import { MathUtils, Vector3, type Matrix4 } from 'three';
import { PHYSICS as P } from '../config';
import { Drivetrain } from './drivetrain';
import type { Collider, RayHit } from '../world/collider';

export interface CarInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (reverse when stopped)
  steer: number; // −1 right … +1 left
  handbrake: boolean;
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
    | 'blob-no-top';
  /** Distance along `dir` where the deck starts (−1 if none) and its height. */
  start: number;
  deck: number;
  /**
   * Surface heights sampled: [distance, height or null, phase]. `skirt`, `far`
   * and `along` run along `dir` from `hit`; `side` runs across it (signed
   * distance) from the point `mid` metres along.
   */
  samples: Array<[number, number | null, 'skirt' | 'far' | 'along' | 'side']>;
  mid?: number;
}

/** Footprint of a car-sized blob judged passable (baked or ghosted vehicle). */
interface Blob {
  x: number;
  z: number;
  r: number;
  ground: number;
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

// Corner order: front-left, front-right, rear-left, rear-right. Front is −Z in car space.
const CORNERS: ReadonlyArray<[number, number]> = [
  [-P.cornerX, -P.cornerZ],
  [P.cornerX, -P.cornerZ],
  [-P.cornerX, P.cornerZ],
  [P.cornerX, P.cornerZ],
];

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
  readonly drivetrain = new Drivetrain();
  heading = 0;
  prevHeading = 0;
  yawRate = 0;
  steer = 0;

  drifting = false;
  private lowSlipTime = 0;
  private gripBlend = 1;
  /** Seconds since the current drift started (its yaw authority ramps in). */
  private driftAge = 0;
  /** Throttle and handbrake smoothed over `driftFeatherTau`, so tapping a digital key feathers. */
  private throttleF = 0;
  private handbrakeF = 0;
  private steerF = 0;
  /** Side the rear is out on (±1); only changes once the slip clearly crosses over. */
  private driftDir = 1;
  /** Slip angle the drift is steering toward (signed like `slip`). */
  driftTarget = 0;

  /** Body pitch (nose up +) and roll (left side up +) from the ground plane. */
  pitch = 0;
  roll = 0;
  readonly groundNormal = new Vector3(0, 1, 0);
  groundY = 0;
  private groundVel = 0;
  airborne = false;
  /** Physics is paused because no collision geometry is loaded under the car. */
  waiting = false;
  private missTime = 0;
  private readonly cornerH = [0, 0, 0, 0];
  readonly probeState: Probe[] = [Probe.Miss, Probe.Miss, Probe.Miss, Probe.Miss];

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

  constructor(private readonly events: CarEvents = {}) {}

  get forward(): Vector3 {
    return new Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  reset(pos: Vector3, heading: number): void {
    this.pos.copy(pos);
    this.prevPos.copy(pos);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.heading = this.prevHeading = heading;
    this.yawRate = 0;
    this.steer = 0;
    this.drifting = false;
    this.gripBlend = 1;
    this.throttleF = this.handbrakeF = this.steerF = 0;
    this.drivetrain.reset();
    this.overpassCache.clear();
    this.blobCache.clear();
    this.blobs.length = 0;
    this.driftTarget = 0;
    this.pitch = this.roll = 0;
    this.groundNormal.set(0, 1, 0);
    this.groundY = pos.y;
    this.groundVel = 0;
    this.cornerH.fill(pos.y);
    this.airborne = false;
    this.waiting = false;
    this.missTime = 0;
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
    this.groundY += dy;
    for (let i = 0; i < 4; i++) this.cornerH[i] += dy;
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

    collider.prepare(this.pos.x, this.pos.z, P.halfLength + 2 + this.speed * dt * 4);

    if (this.waiting) {
      this.solveGround(collider, dt);
      if (this.waiting) return;
    }

    const traction = this.airborne ? 0 : 1;
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const fx = -sinH;
    const fz = -cosH;
    const lx = -cosH;
    const lz = sinH;
    let vF = this.vel.x * fx + this.vel.z * fz;
    let vL = this.vel.x * lx + this.vel.z * lz;
    const speed = Math.hypot(vF, vL);

    // Steering: speed-scaled lock, rate-limited so digital input feels analogue.
    const absVF = Math.abs(vF);
    const lock = P.steerMax / (1 + absVF / P.steerSpeedFalloff);
    const target = MathUtils.clamp(input.steer, -1, 1) * lock;
    const rate = (Math.abs(target) > Math.abs(this.steer) ? P.steerRate : P.steerReturn) / (1 + absVF / 25);
    this.steer += MathUtils.clamp(target - this.steer, -rate * dt, rate * dt);

    // Longitudinal forces. While sliding, the driven wheels turn at the car's
    // speed (plus some wheelspin), not just its forward component.
    const reversing = vF < -0.3 || (input.brake > 0 && input.throttle === 0 && vF < 0.5);
    const wheelSpeed = this.drifting ? speed * (1 + P.driftWheelspin * this.throttleF) : vF;
    const engine = this.drivetrain.update(dt, wheelSpeed, input.throttle, reversing, this.airborne, this.drifting);
    let aF = 0;
    if (input.throttle > 0) aF += vF < -0.5 ? P.brakeDecel * input.throttle : engine.drive;
    if (input.brake > 0) {
      if (vF > 0.5) aF -= P.brakeDecel * input.brake;
      else if (vF > -P.topSpeedReverse) aF -= P.reverseAccel * input.brake;
    }
    vF += aF * dt * traction;
    // Resistances always oppose motion and never reverse it.
    let resist = P.rollingDecel + P.dragK * vF * vF + engine.engineBrake;
    if (input.handbrake) resist += P.handbrakeDecel;
    vF = moveToward(vF, 0, resist * dt * (traction || 0.1));

    // Drift state machine.
    const feather = 1 - Math.exp(-dt / P.driftFeatherTau);
    this.throttleF += (input.throttle - this.throttleF) * feather;
    this.handbrakeF += ((input.handbrake ? 1 : 0) - this.handbrakeF) * feather;
    this.steerF += (MathUtils.clamp(input.steer, -1, 1) - this.steerF) * feather;
    const beta = Math.atan2(vL, Math.max(Math.abs(vF), 1));
    if (
      !this.drifting &&
      traction > 0 &&
      speed > P.driftEnterSpeed &&
      ((input.handbrake && Math.abs(input.steer) > 0.2) || Math.abs(beta) > P.driftEnterSlip)
    ) {
      this.drifting = true;
      this.lowSlipTime = 0;
      // Steering left swings the rear out right (negative slip).
      this.driftDir = Math.abs(beta) > 0.05 ? Math.sign(beta) : -Math.sign(input.steer || 1);
      // Steering inverts when reversing, as in grip mode.
      this.driftAge = 0;
    }
    if (this.drifting) {
      this.lowSlipTime = Math.abs(beta) < P.driftExitSlip && !input.handbrake ? this.lowSlipTime + dt : 0;
      if (this.lowSlipTime > P.driftExitTime || speed < P.driftExitSpeed) this.drifting = false;
    }
    this.gripBlend = this.drifting ? 0 : Math.min(1, this.gripBlend + dt / P.gripRecoverTime);

    // Yaw.
    if (traction > 0) {
      const yawMax = P.aLatGrip / Math.max(absVF, 3);
      const gripYaw = MathUtils.clamp((vF * Math.tan(this.steer)) / P.wheelbase, -yawMax, yawMax);
      let yawTarget: number;
      if (!this.drifting) {
        yawTarget = gripYaw;
      } else {
        // Throttle and handbrake set the slip angle the car holds; lifting off
        // lets it straighten (and the drift ends). Steering adds rotation on top,
        // and some steering (either way) is needed to hold an angle at all, so a
        // centred wheel straightens out even with the throttle pinned.
        const engaged = Math.min(1, Math.abs(this.steerF) / P.driftHoldSteer);
        // The handbrake that starts a drift only adds oversteer after a beat, so
        // the pull that kicks the car into the slide doesn't also over-rotate it.
        const hbDelay = P.driftHandbrakeDelay;
        const handbrake = this.handbrakeF * MathUtils.smoothstep(this.driftAge, hbDelay, hbDelay + P.driftHandbrakeRamp);
        // Power oversteer needs power: a high gear at low revs bogs the slide.
        const power = this.throttleF * MathUtils.clamp(this.drivetrain.capacity / P.driftPowerRef, 0.35, 1.2);
        const angle = Math.min(P.driftAngleMax, P.driftAngleThrottle * power + P.driftAngleHandbrake * handbrake) * engaged;
        if (Math.abs(beta) > 0.1) this.driftDir = Math.sign(beta);
        this.driftTarget = angle * this.driftDir;
        // Power and the handbrake also rotate the car directly, swinging the rear
        // further out (−driftDir is the way the nose is turning).
        const oversteer = (P.driftThrottleYaw * power + P.driftHandbrakeYaw * handbrake) * engaged;
        // Steering into the slide stops adding rotation as the angle nears the
        // cap, so full lock with everything held can't hang the car sideways.
        let steerYaw = this.steerF * P.driftYawMax * Math.min(1, speed / 10);
        if (Math.sign(this.steerF) === -this.driftDir) steerYaw *= MathUtils.clamp(1 - Math.abs(beta) / P.driftAngleMax, 0, 1) ** 0.5;
        const driftYaw =
          (steerYaw +
            // Capped, so a far-off target angle swings the car round progressively.
            MathUtils.clamp(P.driftAlign * (beta - this.driftTarget), -P.driftAlignMax, P.driftAlignMax) -
            this.driftDir * oversteer) *
          Math.sign(vF || 1);
        // The rear steps out over driftEntryTime instead of being kicked sideways.
        this.driftAge += dt;
        const e = MathUtils.smoothstep(this.driftAge, 0, P.driftEntryTime);
        yawTarget = MathUtils.lerp(gripYaw, driftYaw, e);
      }
      const tau = MathUtils.lerp(P.tauYawDrift, P.tauYawGrip, this.gripBlend);
      this.yawRate += (yawTarget - this.yawRate) * (1 - Math.exp(-dt / tau));
    } else {
      this.yawRate *= Math.exp(-dt * 0.5);
    }
    this.heading += this.yawRate * dt;

    if (traction > 0 && this.drifting && vF > 0.5) {
      // Sliding tyres turn the velocity toward the nose: the further the rear
      // hangs out, the harder the car carves round, scrubbing some speed. This
      // is what makes the drift angle bend the line rather than just look good.
      const b = Math.atan2(vL, vF);
      const sp = Math.hypot(vF, vL);
      const carve = P.driftCarve * Math.min(1, Math.abs(b) / P.driftCarveAngle);
      const nb = b - Math.sign(b) * Math.min(Math.abs(b), carve * dt);
      const nsp = sp * (1 - P.driftScrub * Math.abs(Math.sin(b)) * dt);
      vF = nsp * Math.cos(nb);
      vL = nsp * Math.sin(nb);
    } else if (traction > 0) {
      // Lateral grip: friction-capped exponential bleed of sideways speed.
      let mu = MathUtils.lerp(P.muDrift, P.muGrip, this.gripBlend);
      if (this.drifting) mu *= 1 - P.throttleDriftLoss * this.throttleF;
      // Locked rears: a held handbrake slides wide, a feathered one only partly.
      mu = MathUtils.lerp(mu, Math.min(mu, P.muHandbrake), this.drifting ? this.handbrakeF : input.handbrake ? 1 : 0);
      const bleed = Math.min(Math.abs(vL), Math.min(Math.abs(vL) * P.gripRate, mu * G) * dt);
      vL -= Math.sign(vL) * bleed;
      if (this.drifting) vF += Math.sign(vF) * bleed * P.driftKeep;
    }

    // Rebuild world velocity in the basis it was measured in. The heading has
    // already turned, so next step this velocity reads partly as lateral slip,
    // which grip then bleeds away (cornering) or fails to (drifting).
    this.vel.x = fx * vF + lx * vL;
    this.vel.z = fz * vF + lz * vL;

    // Slope gravity (ignores photogrammetry noise on near-flat ground).
    const n = this.groundNormal;
    if (traction > 0 && Math.hypot(n.x, n.z) > P.slopeDeadzone) {
      this.vel.x += G * P.slopeGravity * n.x * dt;
      this.vel.z += G * P.slopeGravity * n.z * dt;
    }
    if (traction > 0 && Math.hypot(this.vel.x, this.vel.z) < 0.3 && input.throttle === 0 && input.brake === 0) {
      this.vel.x = this.vel.z = 0;
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
  }

  // --- Ground --------------------------------------------------------------

  private solveGround(collider: Collider, dt: number): void {
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    let groundCount = 0;
    let blockedCount = 0;
    if (this.debugRays) this.probes.length = 0;

    for (let i = 0; i < 4; i++) {
      const [cx, cz] = CORNERS[i];
      // Car space → world: x' = cx·cos + cz·sin, z' = −cx·sin + cz·cos (rotation about +Y by ψ).
      const wx = this.pos.x + cx * cosH + cz * sinH;
      const wz = this.pos.z - cx * sinH + cz * cosH;
      const h = this.cornerH[i];
      // Probe from the wheel's last ground height so canopy/overpasses above are
      // ignored. In the air, probe from the body instead, so decks between the
      // car and the ground it left are found rather than fallen through.
      const base = this.airborne ? Math.max(h, this.pos.y) : h;
      _o.set(wx, base + P.stepUp, wz);
      let hit = collider.cast(_o, DOWN, base - h + P.stepUp + P.probeDepth, _hit);
      // The top of a passable blob (a baked car) isn't ground: drive through it.
      // Judged against the road the blob sits on, or a wheel would climb a
      // gently sloped one step by step and launch off it.
      if (hit) {
        const b = this.blobAt(wx, wz);
        if (b ? hit.point.y > b.ground + P.blobRoadTol : hit.point.y > base + P.blobRoadTol && this.overBlob(collider, wx, wz, hit.point.y))
          hit = null;
      }
      if (!hit || hit.normal.y < P.minGroundNormalY) {
        // Steep triangles under one wheel are mesh noise more often than walls;
        // the horizontal wall probes handle real walls.
        this.probeState[i] =
          !hit && !this.airborne && !this.inBlob(wx, wz) && this.isDrop(collider, wx, wz, h) ? Probe.Drop : Probe.Miss;
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
        } else {
          // A hole in the mesh: keep the last ground estimate and carry on.
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
    const slopeF = (hFront - hRear) / (2 * P.cornerZ);
    const slopeL = (hLeft - hRight) / (2 * P.cornerX);
    this.pitch = MathUtils.clamp(Math.atan(slopeF), -P.maxTilt, P.maxTilt);
    this.roll = MathUtils.clamp(Math.atan(slopeL), -P.maxTilt, P.maxTilt);
    // Height gradient in world XZ = slopeF·forward + slopeL·left.
    const gx = slopeF * -sinH + slopeL * -cosH;
    const gz = slopeF * -cosH + slopeL * sinH;
    const target = new Vector3(-gx, 1, -gz).normalize();
    this.groundNormal.lerp(target, 1 - Math.exp(-dt / 0.1)).normalize();

    const newGround = (hts[0] + hts[1] + hts[2] + hts[3]) / 4;
    const gv = (newGround - this.groundY) / dt;
    this.groundVel += (MathUtils.clamp(gv, -30, 30) - this.groundVel) * (1 - Math.exp(-dt / 0.05));
    this.groundY = newGround;
    this.integrateSuspension(dt);
  }

  private readonly cornerProbeY = [0, 0, 0, 0];
  private readonly overpassCache = new Map<string, boolean>();
  private readonly blobCache = new Map<string, Blob | null>();
  /** Recently passed blobs: probes ignore their surfaces. */
  private readonly blobs: Blob[] = [];
  private readonly cornerScratch = [0, 0, 0, 0];

  /** Highest walkable surface under the car that is not far above it, or null. */
  private longProbe(collider: Collider): number | null {
    _o.set(this.pos.x, this.pos.y + 25, this.pos.z);
    const hits = collider.castAll(_o, DOWN, 25 + 80);
    for (const h of hits) {
      if (h.point.y > this.groundY + P.blobRoadTol && this.inBlob(h.point.x, h.point.z)) continue;
      if (h.point.y <= this.pos.y + 3 && h.normal.y >= P.minGroundNormalY) return h.point.y;
    }
    return null;
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
      const [cx, cz] = CORNERS[i];
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
    const pext = P.halfLength * Math.abs(pf) + P.halfWidth * Math.abs(pl);
    // In the air, probe from the body, not from the ground far below.
    const y = Math.max(this.groundY, this.pos.y) + P.wallProbeHeight;
    _d.set(dx, 0, dz);

    let best: RayHit | null = null;
    let bestPen = 0;
    for (let r = 0; r < WALL_RAYS.length; r++) {
      const q = WALL_RAYS[r] * pext;
      const reach = supportAlong(q * pf, df, P.halfLength, q * pl, dl, P.halfWidth);
      if (reach === null) continue;
      _o.set(this.pos.x + px * q, y, this.pos.z + pz * q);
      const length = reach + sp * dt + 0.3;
      const hit = collider.cast(_o, _d, length);
      let verdict: WallRayDebug['verdict'] = 'clear';
      if (hit && Math.abs(hit.normal.y) > P.wallMaxNormalY) verdict = 'steep-floor';
      else if (hit && hit.distance >= reach + 0.05) verdict = 'beyond';
      else if (hit) {
        const pen = reach + 0.03 - hit.distance;
        if (pen <= bestPen) verdict = 'wall-minor';
        else if (this.inBlob(hit.point.x, hit.point.z) || this.isBlob(collider, hit.point.x, hit.point.z, dx, dz, hit.point.y))
          verdict = 'blob';
        else if (this.isOverpass(collider, hit, dx, dz)) verdict = 'overpass';
        else {
          verdict = 'wall';
          best = hit;
          bestPen = pen;
          const w = this.wall;
          w.ray = r;
          w.point.copy(hit.point);
          w.normal.copy(hit.normal);
          w.geometricError = (hit.object.userData.tile as { geometricError?: number } | undefined)?.geometricError ?? -1;
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
    if (!best) return;
    this.wall.pen = bestPen;

    const n = best.normal;
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
    if (y > this.groundY + P.blobMaxHeight) return false;
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
    // Highest surface below the clearance height.
    const topAt = (px: number, pz: number, d: number, phase: 'along' | 'side') => {
      const h = collider.castColumn(px, pz, g + clear, clear + 3)[0];
      const t = h ? h.point.y - g : null;
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
      if (t !== null && Math.abs(t) < tol) {
        const t2 = topAt(x + dx * (s + 0.75), z + dz * (s + 0.75), s + 0.75, 'along');
        if (t2 !== null && Math.abs(t2) < tol) {
          depth = s;
          break;
        }
      }
    }
    let blob: Blob | null = null;
    const mid = Math.max(0.25, depth / 2);
    if (depth >= 0 && peak < hitY - g - P.blobTopSlack) {
      reason = 'blob-no-top';
      depth = -1;
    }
    if (depth >= 0) {
      // Over the lump only, so a building just beyond it doesn't count.
      _bo.set(x - dx * 1.5, g + clear, z - dz * 1.5);
      _bd.set(dx, 0, dz);
      if (collider.castWide(_bo, _bd, depth + 2)) {
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
      if (reason === 'blob') blob = { x: mx, z: mz, r: Math.max(mid, half) + 0.6, ground: g };
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
    this.overpassCache.set(key, result);
    this.events.onOverpass?.({ hit: hit.point.toArray(), dir: [dx, dz], groundY: g, result, reason, start, deck, samples });
    return result;
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
      const [cx, cz] = CORNERS[i];
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
    this.vel.x = tx * keep - P.wallRestitution * vn * nx;
    this.vel.z = tz * keep - P.wallRestitution * vn * nz;
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
