import { MathUtils } from 'three';
import { DRIVETRAIN as D } from '../config';

export type ShiftMode = 'auto' | 'manual';

export interface DriveOutput {
  /** Engine drive force at the rear contact patches this step (N, already × throttle). */
  drive: number;
  /** Engine braking force resisting the rear wheels' rotation (N, ≥ 0). */
  engineBrake: number;
  /**
   * Rotating inertia the rear wheels carry, as an equivalent mass at the
   * contact patch (kg): the wheels alone, plus the engine through the gear
   * ratio when the clutch is locked. Low gears make the wheels hard to spin up
   * or stop.
   */
  inertia: number;
}

const RPM_PER_RAD_S = 60 / (2 * Math.PI);
const HP_PER_KW = 1.341;

/** Engine torque (N·m) at `rpm`, from the curve in config. */
export function torqueAt(rpm: number): number {
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

export function powerHp(rpm: number): number {
  return ((torqueAt(rpm) * rpm) / 9549) * HP_PER_KW;
}

/**
 * Engine + gearbox. Turns throttle into wheel force through a torque curve and
 * gear ratios, with clutch slip at launch, a rev limiter, shift torque cuts and
 * rpm-dependent engine braking. `auto` shifts by itself; Q/E switch to manual.
 */
export class Drivetrain {
  mode: ShiftMode = 'auto';
  /** −1 reverse, else 1…gears.length. */
  gear = 1;
  /** Engine speed (smoothed for the tach and audio). */
  rpm: number = D.idleRpm;
  /** The rev limiter cut fuel this step. */
  limiting = false;
  /** Drive force delivered last step (N), for the debug readout. */
  force = 0;
  /** Set briefly when a manual downshift was refused because it would over-rev. */
  refused = 0;
  private shiftTimer = 0;
  private autoHold = 0;
  private engineRpm: number = D.idleRpm;
  private cutTimer = 0;

  get shifting(): boolean {
    return this.shiftTimer > 0;
  }

  /** Engine rpm the wheels would turn in `gear` at forward speed `v`. */
  wheelRpm(v: number, gear = this.gear): number {
    const ratio = gear < 0 ? D.reverse : D.gears[gear - 1];
    return (Math.abs(v) / D.wheelRadius) * ratio * D.finalDrive * RPM_PER_RAD_S;
  }

  shiftUp(): void {
    this.mode = 'manual';
    if (this.gear > 0 && this.gear < D.gears.length) this.shift(this.gear + 1);
  }

  shiftDown(v: number): void {
    this.mode = 'manual';
    if (this.gear <= 1) return;
    // A downshift that would throw the engine past the limiter is refused.
    if (this.wheelRpm(v, this.gear - 1) > D.limiter + 200) {
      this.refused = 0.6;
      return;
    }
    this.shift(this.gear - 1);
  }

  toggleMode(): void {
    this.mode = this.mode === 'auto' ? 'manual' : 'auto';
  }

  /** Picks the gear the auto box would hold at `speed` (m/s) on light throttle. */
  matchSpeed(speed: number): void {
    let g = 1;
    while (g < D.gears.length && this.wheelRpm(speed, g) > D.autoUpRpm[1] - 1500) g++;
    this.gear = g;
    this.rpm = this.engineRpm = Math.max(D.idleRpm, this.wheelRpm(speed, g));
  }

  reset(): void {
    this.gear = 1;
    this.rpm = this.engineRpm = D.idleRpm;
    this.shiftTimer = this.autoHold = this.cutTimer = 0;
    this.limiting = false;
  }

  /**
   * `wheelSpeed` is the rear wheels' surface speed (m/s), which runs ahead of
   * the car under wheelspin and drops to 0 when they lock; `roadSpeed` is the
   * car's speed over the ground. `reverse` while
   * backing up under the brake key; `declutch` disconnects the engine (in the
   * air, and on the handbrake, as a driver would).
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
    this.refused = Math.max(0, this.refused - dt);
    this.autoHold = Math.max(0, this.autoHold - dt);
    if (reverse) this.gear = -1;
    else if (this.gear < 0) this.gear = 1;

    if (this.mode === 'auto' && !reverse && !declutch && this.shiftTimer <= 0 && this.autoHold <= 0)
      this.autoShift(wheelSpeed, roadSpeed, throttle, drifting);

    const ratio = (this.gear < 0 ? D.reverse : D.gears[this.gear - 1]) * D.finalDrive;
    const toForce = (torque: number) => (torque * ratio * D.efficiency) / D.wheelRadius;
    const wheel = this.wheelRpm(wheelSpeed);
    let target: number;
    let engaged = true;
    if (declutch) {
      // Clutch in: the engine free-revs on the throttle.
      target = D.idleRpm + (D.limiter - D.idleRpm) * throttle;
      engaged = false;
    } else if (wheel < D.clutchRpm) {
      // Pulling away: the clutch slips, holding the engine near launch rpm.
      target = Math.max(wheel, D.idleRpm + (D.launchRpm - D.idleRpm) * throttle);
      engaged = throttle > 0;
    } else {
      target = wheel;
    }
    // Free or slipping engine speed moves quickly but not instantly; locked to
    // the wheels it follows them exactly.
    const locked = engaged && wheel >= D.clutchRpm && this.shiftTimer <= 0;
    this.engineRpm = locked ? target : MathUtils.damp(this.engineRpm, target, 12, dt);
    this.engineRpm = MathUtils.clamp(this.engineRpm, D.idleRpm * 0.8, D.limiter + 300);

    // Rev limiter: cut fuel for a moment, which makes the tach bounce.
    if (this.engineRpm >= D.limiter) this.cutTimer = D.limiterCut;
    this.cutTimer = Math.max(0, this.cutTimer - dt);
    this.limiting = this.cutTimer > 0;

    const torque = torqueAt(this.engineRpm);
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
    this.rpm = MathUtils.damp(this.rpm, this.engineRpm, 30, dt);
    const inertia = (D.wheelInertia + (locked ? D.engineInertia * ratio * ratio : 0)) / D.wheelRadius ** 2;
    return { drive, engineBrake, inertia };
  }

  /** Current torque (N·m) and power (hp), for the debug readout. */
  output(): { torque: number; hp: number } {
    return { torque: torqueAt(this.engineRpm), hp: powerHp(this.engineRpm) };
  }

  /**
   * Shifts up on engine (wheel) speed, down on road speed, so locked rear
   * wheels don't drop a gear. Sliding, it shifts up only on road speed and as
   * if at full throttle, so wheelspin and feathering don't shift it, and only
   * shifts down if the road speed collapses.
   */
  private autoShift(wheelSpeed: number, roadSpeed: number, throttle: number, drifting: boolean): void {
    const upSpeed = drifting ? roadSpeed : Math.max(wheelSpeed, roadSpeed);
    const up = MathUtils.lerp(D.autoUpRpm[0], D.autoUpRpm[1], drifting ? 1 : throttle);
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
    this.gear = gear;
    this.shiftTimer = D.shiftTime;
    this.autoHold = D.autoHold;
  }
}
