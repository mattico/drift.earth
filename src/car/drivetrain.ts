import { MathUtils } from 'three';
import { DRIVETRAIN as D } from '../config';

export type ShiftMode = 'auto' | 'manual';

export interface DriveOutput {
  /** Forward acceleration from the engine this step (m/s², already × throttle). */
  drive: number;
  /** Deceleration from engine braking (m/s², ≥ 0). */
  engineBrake: number;
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
  /** Full-throttle drive available at the current rpm and gear (m/s²), for the drift model. */
  capacity = 0;
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

  reset(): void {
    this.gear = 1;
    this.rpm = this.engineRpm = D.idleRpm;
    this.shiftTimer = this.autoHold = this.cutTimer = 0;
    this.limiting = false;
  }

  /**
   * `wheelSpeed` is the driven wheels' surface speed (above the forward speed
   * when sliding). `reverse` while backing up under the brake key.
   */
  update(dt: number, wheelSpeed: number, throttle: number, reverse: boolean, airborne: boolean, drifting: boolean): DriveOutput {
    this.refused = Math.max(0, this.refused - dt);
    this.autoHold = Math.max(0, this.autoHold - dt);
    if (reverse) this.gear = -1;
    else if (this.gear < 0) this.gear = 1;

    if (this.mode === 'auto' && !reverse && this.shiftTimer <= 0 && this.autoHold <= 0) this.autoShift(wheelSpeed, drifting ? 1 : throttle);

    const ratio = this.gear < 0 ? D.reverse : D.gears[this.gear - 1];
    const toAccel = (torque: number) => (torque * ratio * D.finalDrive * D.efficiency) / D.wheelRadius / D.mass;
    const wheel = this.wheelRpm(wheelSpeed);
    let target: number;
    let engaged = true;
    if (airborne) {
      // Wheels unloaded: the engine free-revs on the throttle.
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
    this.engineRpm = engaged && wheel >= D.clutchRpm ? target : MathUtils.damp(this.engineRpm, target, 12, dt);
    this.engineRpm = MathUtils.clamp(this.engineRpm, D.idleRpm * 0.8, D.limiter + 300);

    // Rev limiter: cut fuel for a moment, which makes the tach bounce.
    if (this.engineRpm >= D.limiter) this.cutTimer = D.limiterCut;
    this.cutTimer = Math.max(0, this.cutTimer - dt);
    this.limiting = this.cutTimer > 0;

    const torque = torqueAt(this.engineRpm);
    this.capacity = Math.min(D.maxAccel, toAccel(torque));
    let drive = 0;
    let engineBrake = 0;
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
    } else if (!airborne && !reverse) {
      if (throttle > 0 && !this.limiting) drive = Math.min(D.maxAccel, toAccel(torque * throttle));
      else if (throttle === 0 && wheel >= D.clutchRpm) engineBrake = toAccel(D.engineBrakeTorque * (this.engineRpm / D.redline));
    }
    this.rpm = MathUtils.damp(this.rpm, this.engineRpm, 30, dt);
    return { drive, engineBrake };
  }

  /** Current torque (N·m) and power (hp), for the debug readout. */
  output(): { torque: number; hp: number } {
    return { torque: torqueAt(this.engineRpm), hp: powerHp(this.engineRpm) };
  }

  /** Sliding, the box shifts as if at full throttle so lifting to feather doesn't short-shift. */
  private autoShift(wheelSpeed: number, throttle: number): void {
    const rpm = this.wheelRpm(wheelSpeed);
    const up = MathUtils.lerp(D.autoUpRpm[0], D.autoUpRpm[1], throttle);
    const down = MathUtils.lerp(D.autoDownRpm[0], D.autoDownRpm[1], throttle);
    if (rpm > up && this.gear < D.gears.length) {
      // Several gears at once if far over (e.g. spawned already moving).
      let g = this.gear + 1;
      while (g < D.gears.length && this.wheelRpm(wheelSpeed, g) > D.redline) g++;
      this.shift(g);
    }
    else if (rpm < down && this.gear > 1 && this.wheelRpm(wheelSpeed, this.gear - 1) < D.autoUpRpm[1] - 400) this.shift(this.gear - 1);
  }

  private shift(gear: number): void {
    this.gear = gear;
    this.shiftTimer = D.shiftTime;
    this.autoHold = D.autoHold;
  }
}
