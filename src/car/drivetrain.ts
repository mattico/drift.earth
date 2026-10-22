import { MathUtils } from 'three';
import type { DrivetrainSpec } from './cars';

export type ShiftMode = 'auto' | 'manual';

export interface DriveOutput {
  /** Engine drive force at the driven wheels' contact patches this step (N, already × throttle). */
  drive: number;
  /** Engine braking force resisting the driven wheels' rotation (N, ≥ 0). */
  engineBrake: number;
  /**
   * Rotating inertia the driven wheels carry, as an equivalent mass at the
   * contact patch (kg): the wheels alone, plus the engine through the gear
   * ratio when the clutch is locked. Low gears make the wheels hard to spin up
   * or stop.
   */
  inertia: number;
}

const RPM_PER_RAD_S = 60 / (2 * Math.PI);
/** Seconds for the auto box's held throttle demand to ease from full to none on part throttle. */
const DEMAND_DECAY = 2;
/** Below this throttle the pedal counts as lifted, and the auto box holds its gear. */
const LIFTED = 0.05;
const HP_PER_KW = 1.341;

/** Engine torque (N·m) at `rpm`, from the car's curve. */
export function torqueAt(D: DrivetrainSpec, rpm: number): number {
  const c = D.torque;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const [r0, t0] = c[i - 1];
      const [r1, t1] = c[i];
      return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return c[c.length - 1][1];
}

export function powerHp(D: DrivetrainSpec, rpm: number): number {
  return ((torqueAt(D, rpm) * rpm) / 9549) * HP_PER_KW;
}

/**
 * Engine + gearbox. Turns throttle into wheel force through a torque curve and
 * gear ratios, with clutch slip at launch, a rev limiter, shift torque cuts,
 * rpm-dependent engine braking and, if fitted, turbo lag. `auto` shifts by
 * itself; Q/E switch to manual.
 */
export class Drivetrain {
  mode: ShiftMode = 'auto';
  /** −1 reverse, else 1…gears.length. */
  gear = 1;
  /** Engine speed (smoothed for the tach and audio). */
  rpm: number;
  /** The rev limiter cut fuel this step. */
  limiting = false;
  /** Drive force delivered last step (N), for the debug readout. */
  force = 0;
  /** Throttle the engine got last step, and whether the clutch was locked to the wheels (for the sound). */
  throttle = 0;
  engaged = false;
  /** Turbo boost, 0 (none, or off boost) … 1 (full). Always 0 for a naturally aspirated engine. */
  boost = 0;
  private shiftTimer = 0;
  private autoHold = 0;
  /**
   * Throttle the auto box picks its upshift point from: the recent peak, easing
   * down on part throttle and held when lifted, so lifting off (a key or touch
   * button goes straight to 0) doesn't drop the upshift point and shift up.
   */
  private demand = 0;
  private engineRpm: number;
  private cutTimer = 0;

  constructor(readonly spec: DrivetrainSpec) {
    this.rpm = this.engineRpm = spec.idleRpm;
  }

  get shifting(): boolean {
    return this.shiftTimer > 0;
  }

  /** Engine rpm the wheels would turn in `gear` at forward speed `v`. */
  wheelRpm(v: number, gear = this.gear): number {
    const D = this.spec;
    const ratio = gear < 0 ? D.reverse : D.gears[gear - 1];
    return (Math.abs(v) / D.wheelRadius) * ratio * D.finalDrive * RPM_PER_RAD_S;
  }

  shiftUp(): void {
    const D = this.spec;
    this.mode = 'manual';
    if (this.gear > 0 && this.gear < D.gears.length) this.shift(this.gear + 1);
  }

  shiftDown(): void {
    this.mode = 'manual';
    // Always allowed, even over the limiter: the engine holds on it with no
    // drive and, off the throttle, engine braking drags at the driven wheels.
    if (this.gear > 1) this.shift(this.gear - 1);
  }

  toggleMode(): void {
    this.mode = this.mode === 'auto' ? 'manual' : 'auto';
  }

  /** Picks the gear the auto box would hold at `speed` (m/s) on light throttle. */
  matchSpeed(speed: number): void {
    const D = this.spec;
    let g = 1;
    while (g < D.gears.length && this.wheelRpm(speed, g) > D.autoUpRpm[1] - 1500) g++;
    this.gear = g;
    this.rpm = this.engineRpm = Math.max(D.idleRpm, this.wheelRpm(speed, g));
  }

  reset(): void {
    const D = this.spec;
    this.gear = 1;
    this.rpm = this.engineRpm = D.idleRpm;
    this.shiftTimer = this.autoHold = this.cutTimer = this.demand = 0;
    this.limiting = false;
    this.boost = 0;
  }

  /**
   * `wheelSpeed` is the driven wheels' surface speed (m/s), which runs ahead of
   * the car under wheelspin and drops to 0 when they lock; `roadSpeed` is the
   * car's speed over the ground. `reverse` while
   * backing up under the brake key; `declutch` disconnects the engine (in the
   * air, and on a rear-drive car's handbrake, as a driver would).
   */
  update(
    dt: number,
    wheelSpeed: number,
    roadSpeed: number,
    throttle: number,
    reverse: boolean,
    declutch: boolean,
    drifting: boolean,
  ): DriveOutput {
    const D = this.spec;
    this.autoHold = Math.max(0, this.autoHold - dt);
    if (throttle >= this.demand) this.demand = throttle;
    else if (throttle > LIFTED) this.demand = Math.max(throttle, this.demand - dt / DEMAND_DECAY);
    if (reverse) this.gear = -1;
    else if (this.gear < 0) this.gear = 1;

    if (this.mode === 'auto' && !reverse && !declutch && this.shiftTimer <= 0 && this.autoHold <= 0)
      this.autoShift(wheelSpeed, roadSpeed, throttle, drifting);

    const ratio = (this.gear < 0 ? D.reverse : D.gears[this.gear - 1]) * D.finalDrive;
    const toForce = (torque: number) => (torque * ratio * D.efficiency) / D.wheelRadius;
    const wheel = this.wheelRpm(wheelSpeed);
    let target: number;
    let engaged = true;
    // Pulling away (1st or reverse) the clutch slips up to clutchRpm; in a
    // higher gear it stays in until the engine would drop below idle, so
    // coasting keeps its engine braking.
    const slipBelow = this.gear === 1 || this.gear < 0 ? D.clutchRpm : D.idleRpm;
    if (declutch) {
      // Clutch in: the engine free-revs on the throttle.
      target = D.idleRpm + (D.limiter - D.idleRpm) * throttle;
      engaged = false;
    } else if (wheel < slipBelow) {
      // Pulling away: the clutch slips, holding the engine near launch rpm.
      target = Math.max(wheel, D.idleRpm + (D.launchRpm - D.idleRpm) * throttle);
      engaged = throttle > 0;
    } else {
      target = wheel;
    }
    // Free or slipping engine speed moves quickly but not instantly; locked to
    // the wheels it follows them exactly.
    const locked = engaged && wheel >= slipBelow && this.shiftTimer <= 0;
    this.engineRpm = locked ? target : MathUtils.damp(this.engineRpm, target, 12, dt);
    this.engineRpm = MathUtils.clamp(this.engineRpm, D.idleRpm * 0.8, D.limiter + 300);

    // Rev limiter: cut fuel for a moment, which makes the tach bounce.
    if (this.engineRpm >= D.limiter) this.cutTimer = D.limiterCut;
    this.cutTimer = Math.max(0, this.cutTimer - dt);
    this.limiting = this.cutTimer > 0;

    this.spool(dt, throttle, engaged);
    const torque = this.boosted(torqueAt(D, this.engineRpm));
    let drive = 0;
    let engineBrake = 0;
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
    } else if (engaged && !reverse) {
      if (!this.limiting) drive = toForce(torque * throttle);
      // Engine braking fades in as the throttle closes.
      if (locked) engineBrake = toForce(D.engineBrakeTorque * (this.engineRpm / D.redline)) * Math.max(0, 1 - throttle / 0.15);
    }
    this.force = drive;
    this.throttle = throttle;
    this.engaged = locked;
    this.rpm = MathUtils.damp(this.rpm, this.engineRpm, 30, dt);
    const inertia = (D.wheelInertia + (locked ? D.engineInertia * ratio * ratio : 0)) / D.wheelRadius ** 2;
    return { drive, engineBrake, inertia };
  }

  /** Current torque on tap (N·m) and power (hp) at the (unsmoothed) engine rpm, for the debug readouts. */
  output(): { rpm: number; torque: number; hp: number } {
    const D = this.spec;
    const torque = this.boosted(torqueAt(D, this.engineRpm));
    return { rpm: this.engineRpm, torque, hp: ((torque * this.engineRpm) / 9549) * HP_PER_KW };
  }

  /**
   * Moves boost toward what the turbo can make at this rpm and throttle: slowly
   * up (lag, worse low in the rev range), quickly down when the throttle shuts
   * or a shift lifts it, as the blow-off valve vents. Free-revving, unloaded,
   * the engine builds little.
   */
  private spool(dt: number, throttle: number, engaged: boolean): void {
    const T = this.spec.turbo;
    if (!T) {
      // Also when one is taken off mid-drive (tuning).
      this.boost = 0;
      return;
    }
    const rpm = this.engineRpm;
    const available = MathUtils.smoothstep(rpm, T.onsetRpm, T.fullRpm);
    const target = this.shiftTimer > 0 ? 0 : available * throttle * (engaged ? 1 : 0.3);
    const tau = target > this.boost ? (T.spool * T.fullRpm) / Math.max(rpm, T.onsetRpm) : T.vent;
    this.boost = MathUtils.damp(this.boost, target, 1 / tau, dt);
  }

  /** Torque from the full-boost curve at the current boost (unchanged without a turbo). */
  private boosted(torque: number): number {
    const T = this.spec.turbo;
    return T ? torque * (1 - T.share * (1 - this.boost)) : torque;
  }

  /**
   * Shifts up on engine (wheel) speed, down on road speed, so locked rear
   * wheels don't drop a gear. The upshift point follows the held demand, the
   * downshift point the throttle right now, so lifting off shifts neither way. Sliding, it shifts up only on road speed and as
   * if at full throttle, so wheelspin and feathering don't shift it, and only
   * shifts down if the road speed collapses.
   */
  private autoShift(wheelSpeed: number, roadSpeed: number, throttle: number, drifting: boolean): void {
    const D = this.spec;
    const upSpeed = drifting ? roadSpeed : Math.max(wheelSpeed, roadSpeed);
    const up = MathUtils.lerp(D.autoUpRpm[0], D.autoUpRpm[1], drifting ? 1 : this.demand);
    const down = drifting ? D.autoDownRpm[0] : MathUtils.lerp(D.autoDownRpm[0], D.autoDownRpm[1], throttle);
    // Never shift up into a gear the road speed would shift straight back out
    // of (wheelspin at low speed holds 1st and bounces off the limiter).
    if (this.wheelRpm(upSpeed) > up && this.gear < D.gears.length && this.wheelRpm(roadSpeed, this.gear + 1) > down + 300) {
      // Several gears at once if far over (e.g. spawned already moving).
      let g = this.gear + 1;
      while (g < D.gears.length && this.wheelRpm(upSpeed, g) > D.redline) g++;
      this.shift(g);
    } else if (
      this.wheelRpm(roadSpeed) < down &&
      this.gear > 1 &&
      this.wheelRpm(roadSpeed, this.gear - 1) < D.autoUpRpm[1] - 400
    )
      this.shift(this.gear - 1);
  }

  private shift(gear: number): void {
    const D = this.spec;
    this.gear = gear;
    this.shiftTimer = D.shiftTime;
    this.autoHold = D.autoHold;
  }
}
