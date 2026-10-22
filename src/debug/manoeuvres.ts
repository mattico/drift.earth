import { MathUtils } from 'three';
import type { CarSpec } from '../car/cars';
import type { CarInput, CarPhysics } from '../car/physics';
import { PHYSICS } from '../config';

const DEG = 180 / Math.PI;
const G = 9.80665;
const dt = PHYSICS.dt;

/**
 * A stretch of recorded steps, as the Scope pins it: column-major (one
 * column's steps are contiguous, so a channel is a zero-copy subarray), with
 * the column names it was recorded under, since FRAME_COLUMNS may grow.
 */
export interface Run {
  id: number;
  /** The car and preset, from ScopeHandlers.describe(). */
  label: string;
  /** Wall-clock time it was taken, "14:03:22". */
  time: string;
  /** The manoeuvre it recorded (its first step is the manoeuvre's start), or null for a window of free driving. */
  manoeuvre: string | null;
  columns: readonly string[];
  n: number;
  data: Float32Array;
  metrics: Metric[] | null;
  /** Drawn on the chart. */
  on: boolean;
}

export interface Metric {
  label: string;
  value: number | string | null;
  unit: string;
  digits: number;
  /** What it means, for the table's tooltip. */
  hint?: string;
}

/** One column of a run (a view, not a copy), or null if it wasn't recorded. */
export function series(r: Run, name: string): Float32Array | null {
  const c = r.columns.indexOf(name);
  return c < 0 ? null : r.data.subarray(c * r.n, (c + 1) * r.n);
}

/** `gear` as recorded holds manual mode as +10 (manual reverse is 9). */
export function decodeGear(v: number): number {
  return v > 8.5 ? v - 10 : v;
}

/** Per-run scratch the scripts keep between steps. */
export class RunState {
  /** Speed hold's integral term (throttle). */
  integral = 0.25;
  /** A throttle frozen at some point (−1 until then). */
  held = -1;
}

export interface Manoeuvre {
  id: string;
  name: string;
  /** What it does and what to read from it (button tooltip). */
  title: string;
  /** Start speed (km/h). */
  kmh: number;
  /** 'hold' runs in manual, in the gear the start speed picked (no shifts mid-test); 'auto' lets the box shift. */
  gear: 'auto' | 'hold';
  /** Longest it runs (s). */
  duration: number;
  /** How much time the chart shows while it runs (s). */
  span: number;
  /** The Scope channel preset that suits it. */
  preset: string;
  /** Per physics step: the input at `t` (s since the start) into `out`. Closed-loop scripts read the car; it's all deterministic. */
  drive(t: number, p: CarPhysics, s: RunState, out: CarInput): void;
  /** Ends the run before `duration`. */
  done?(t: number, p: CarPhysics, s: RunState): boolean;
  /** Reads the results from the recorded run. */
  metrics(r: Run, car: CarSpec): Metric[];
}

function set(out: CarInput, throttle: number, steer: number, brake = 0, handbrake = false): void {
  out.throttle = throttle;
  out.steer = steer;
  out.brake = brake;
  out.handbrake = handbrake;
}

/** PI throttle holding the ground speed at `kmh` (an open-loop throttle would drift off speed differently per car). */
function holdSpeed(p: CarPhysics, s: RunState, kmh: number): number {
  const e = kmh / 3.6 - p.speed;
  s.integral = MathUtils.clamp(s.integral + e * 0.8 * dt, 0, 1);
  return MathUtils.clamp(s.integral + e * 0.5, 0, 1);
}

const metric = (label: string, value: number | string | null, unit = '', digits = 2, hint?: string): Metric => ({
  label,
  value: typeof value === 'number' && !Number.isFinite(value) ? null : value,
  unit,
  digits,
  hint,
});

const idx = (r: Run, t: number) => MathUtils.clamp(Math.round(t / dt), 0, r.n - 1);

function mean(a: Float32Array, from: number, to: number, scale = 1): number {
  let s = 0;
  const i0 = Math.max(0, from);
  const i1 = Math.min(a.length, to);
  for (let i = i0; i < i1; i++) s += a[i];
  return i1 > i0 ? (s / (i1 - i0)) * scale : NaN;
}

/** Body slip angle (rad) per step: the velocity's angle off the heading. */
function bodySlip(r: Run): Float32Array {
  const vx = series(r, 'vx')!;
  const vz = series(r, 'vz')!;
  const h = series(r, 'heading')!;
  const out = new Float32Array(r.n);
  for (let i = 0; i < r.n; i++) {
    const s = Math.sin(h[i]);
    const c = Math.cos(h[i]);
    const vF = -vx[i] * s - vz[i] * c;
    const vL = -vx[i] * c + vz[i] * s;
    out[i] = Math.hypot(vF, vL) > 1 ? Math.atan2(vL, vF) : 0;
  }
  return out;
}

/** Distance travelled over steps [0, end). */
function distance(r: Run, end = r.n): number {
  const x = series(r, 'x')!;
  const z = series(r, 'z')!;
  let d = 0;
  for (let i = 1; i < end; i++) d += Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  return d;
}

/** Time (s) of the first step at or after `from` where `test` holds, or NaN. */
function first(r: Run, from: number, test: (i: number) => boolean): number {
  for (let i = idx(r, from); i < r.n; i++) if (test(i)) return i * dt;
  return NaN;
}

// --- Step steer -------------------------------------------------------------

const STEP_AT = 1;
const STEP_INPUT = 0.12;

const stepSteer: Manoeuvre = {
  id: 'step-steer',
  name: 'Step steer',
  title: `80 km/h, then a step to ${STEP_INPUT} steering input at ${STEP_AT} s with the throttle held: how fast and how cleanly the yaw rate answers (response time, overshoot, settling)`,
  kmh: 80,
  gear: 'hold',
  duration: STEP_AT + 4,
  span: STEP_AT + 4,
  preset: 'balance',
  drive(t, p, s, out) {
    if (t < STEP_AT) return set(out, holdSpeed(p, s, 80), 0);
    if (s.held < 0) s.held = holdSpeed(p, s, 80);
    set(out, s.held, STEP_INPUT);
  },
  metrics(r) {
    const yaw = series(r, 'yawRate')!;
    const cmd = series(r, 'steerCmd')!;
    const angle = series(r, 'steerAngle')!;
    const end = r.n;
    const last = end - Math.round(1 / dt);
    const ss = mean(yaw, last, end);
    const cmdSS = mean(cmd, last, end);
    // Times from the road wheels reaching half their final angle (the steering's rate limit makes the "step" a ramp).
    const t50 = first(r, STEP_AT, (i) => Math.abs(cmd[i]) >= 0.5 * Math.abs(cmdSS));
    const sgn = Math.sign(ss) || 1;
    const t90 = first(r, STEP_AT, (i) => yaw[i] * sgn >= 0.9 * Math.abs(ss));
    let peak = 0;
    let tPeak = NaN;
    for (let i = idx(r, STEP_AT); i < end; i++) {
      if (yaw[i] * sgn > peak) {
        peak = yaw[i] * sgn;
        tPeak = i * dt;
      }
    }
    let lastOut = t90;
    for (let i = idx(r, t90); i < end; i++) if (Math.abs(yaw[i] - ss) > 0.05 * Math.abs(ss)) lastOut = i * dt;
    return [
      metric('Steady yaw rate', ss * DEG, '°/s', 1),
      metric('Steady lateral', mean(series(r, 'accelLat')!, last, end, 1 / G), 'g', 2),
      metric('Road-wheel angle', mean(angle, last, end, DEG), '°', 2),
      metric('Yaw gain', ss / mean(angle, last, end), '1/s', 2, 'Steady yaw rate per road-wheel angle'),
      metric('Response (90%)', t90 - t50, 's', 3, 'From the road wheels at half their angle to the yaw rate at 90% of steady'),
      metric('Peak response', tPeak - t50, 's', 3, 'From half the road-wheel angle to the yaw rate’s peak'),
      metric('Overshoot', ((peak - Math.abs(ss)) / Math.abs(ss)) * 100, '%', 1, 'Yaw rate peak above steady'),
      metric('Settled (±5%)', lastOut - t50, 's', 2, 'Until the yaw rate stays within 5% of steady'),
      metric('Peak rear slip', maxAbs(series(r, 'slipR')!, idx(r, STEP_AT), end) * DEG, '°', 1),
    ];
  },
};

function maxAbs(a: Float32Array, from = 0, to = a.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

// --- Sine with dwell (FMVSS 126 / UN R140, the stability-control test) ------------

const SD_AT = 0.5;
const SD_FREQ = 0.7;
const SD_DWELL = 0.5;
const SD_INPUT = 0.5;
/** Steering completes (COS) this long after it starts. */
const SD_STEER = 1 / SD_FREQ + SD_DWELL;

const sineDwell: Manoeuvre = {
  id: 'sine-dwell',
  name: 'Sine with dwell',
  title: `80 km/h coasting: a 0.7 Hz sine of ±${SD_INPUT} input, held ${SD_DWELL} s at the second peak. The yaw rate 1 s and 1.75 s after steering completes, as a share of its peak, says whether the car stops rotating (the regulation asks ≤ 35% and ≤ 20%)`,
  kmh: 80,
  gear: 'hold',
  duration: SD_AT + SD_STEER + 2.25,
  span: SD_AT + SD_STEER + 2.25,
  preset: 'balance',
  drive(t, _p, _s, out) {
    const u = t - SD_AT;
    const quarter = 0.25 / SD_FREQ;
    let steer = 0;
    if (u < 0 || u >= SD_STEER) steer = 0;
    else if (u < 3 * quarter) steer = SD_INPUT * Math.sin(2 * Math.PI * SD_FREQ * u);
    else if (u < 3 * quarter + SD_DWELL) steer = -SD_INPUT;
    else steer = SD_INPUT * Math.sin(2 * Math.PI * SD_FREQ * (u - SD_DWELL));
    set(out, 0, steer);
  },
  metrics(r) {
    const yaw = series(r, 'yawRate')!;
    const cos = SD_AT + SD_STEER;
    // The peak the reversal produces: the largest yaw rate the other way, from the first zero crossing of the steering on.
    let peak = 0;
    for (let i = idx(r, SD_AT + 0.5 / SD_FREQ); i < r.n; i++) peak = Math.min(peak, yaw[i]);
    const share = (t: number) => (t < r.n * dt && peak < 0 ? (yaw[idx(r, t)] / peak) * 100 : NaN);
    const at1 = share(cos + 1);
    const at175 = share(cos + 1.75);
    // Responsiveness: sideways travel 1.07 s after the steering starts, across the start heading.
    const x = series(r, 'x')!;
    const z = series(r, 'z')!;
    const h0 = series(r, 'heading')![0];
    const i0 = idx(r, SD_AT);
    const i1 = idx(r, SD_AT + 1.07);
    const lateral = (x[i1] - x[i0]) * -Math.cos(h0) + (z[i1] - z[i0]) * Math.sin(h0);
    const pass = Number.isFinite(at1) && Number.isFinite(at175) ? (at1 <= 35 && at175 <= 20 ? 'pass' : 'fail') : '—';
    return [
      metric('Peak yaw (reversal)', -peak * DEG, '°/s', 1),
      metric('Yaw at COS + 1 s', at1, '%', 1, 'Yaw rate 1 s after steering completes, as a share of the peak (≤ 35%)'),
      metric('Yaw at COS + 1.75 s', at175, '%', 1, 'Yaw rate 1.75 s after steering completes, as a share of the peak (≤ 20%)'),
      metric('Stability', pass, '', 0, 'Both shares within the regulation’s limits'),
      metric('Lateral at 1.07 s', lateral, 'm', 2, 'Sideways travel 1.07 s after steering starts (responsiveness; ≥ 1.83 m)'),
      metric('Peak body slip', maxAbs(bodySlip(r)) * DEG, '°', 1),
      metric('Stability ctrl peak', maxAbs(series(r, 'stability')!) * DEG, '°/s²', 0, 'Most yaw acceleration stability control added'),
      metric('End speed', (series(r, 'speed')![r.n - 1] ?? 0) * 3.6, 'km/h', 0),
    ];
  },
};

// --- J-turn: handbrake entry -----------------------------------------------------

const J_AT = 0.5;
const J_PULL = 0.3;

const jTurn: Manoeuvre = {
  id: 'j-turn',
  name: 'J-turn',
  title: `70 km/h, then the handbrake at full lock for ${J_PULL} s and full throttle at 0.4 steer: how readily it rotates, and whether the throttle holds the drift or spins it`,
  kmh: 70,
  gear: 'hold',
  duration: J_AT + J_PULL + 3,
  span: J_AT + J_PULL + 3,
  preset: 'balance',
  drive(t, p, s, out) {
    if (t < J_AT) set(out, holdSpeed(p, s, 70), 0);
    else if (t < J_AT + J_PULL) set(out, 0, 1, 0, true);
    else set(out, 1, 0.4);
  },
  metrics(r) {
    const slip = bodySlip(r);
    const flags = series(r, 'flags')!;
    const yaw = series(r, 'yawRate')!;
    const end = r.n;
    const tail = end - Math.round(1.5 / dt);
    let drift = 0;
    for (let i = idx(r, J_AT); i < end; i++) if (flags[i] & 4) drift += dt;
    const peak = maxAbs(slip, idx(r, J_AT));
    const heading = series(r, 'heading')!;
    return [
      metric('Time to 15° slip', first(r, J_AT, (i) => Math.abs(slip[i]) >= 15 / DEG) - J_AT, 's', 2, 'From the handbrake pull'),
      metric('Peak body slip', peak * DEG, '°', 1),
      metric('Held body slip', mean(slip, tail, end, DEG), '°', 1, 'Mean over the last 1.5 s'),
      metric('Held yaw rate', mean(yaw, tail, end, DEG), '°/s', 0, 'Mean over the last 1.5 s'),
      metric('Drifting', drift, 's', 2),
      metric('Turned', (heading[end - 1] - heading[0]) * DEG, '°', 0),
      metric('Exit speed', series(r, 'speed')![end - 1] * 3.6, 'km/h', 0),
      metric('Spun', peak * DEG > 100 ? 'yes' : 'no', '', 0, 'Body slip passed 100°'),
    ];
  },
};

// --- 0–100 km/h -------------------------------------------------------------

const launch: Manoeuvre = {
  id: 'launch',
  name: '0–100',
  title: 'From rest, full throttle in auto: 0–60 and 0–100 km/h times, distance, and where it shifts',
  kmh: 0,
  gear: 'auto',
  duration: 25,
  span: 12,
  preset: 'drivetrain',
  drive(_t, _p, _s, out) {
    set(out, 1, 0);
  },
  done(t, p, s) {
    // Half a second past 100, to see the trace level off.
    if (s.held < 0 && p.speed * 3.6 >= 100) s.held = t;
    return s.held >= 0 && t >= s.held + 0.5;
  },
  metrics(r) {
    const v = series(r, 'speed')!;
    const gear = series(r, 'gear')!;
    const rpm = series(r, 'rpm')!;
    const t60 = first(r, 0, (i) => v[i] * 3.6 >= 60);
    const t100 = first(r, 0, (i) => v[i] * 3.6 >= 100);
    const out = [
      metric('0–60 km/h', t60, 's', 2),
      metric('0–100 km/h', t100, 's', 2),
      metric('Distance to 100', Number.isFinite(t100) ? distance(r, idx(r, t100) + 1) : NaN, 'm', 1),
      metric('Peak wheelspin', maxAbs(series(r, 'wheelSpin')!) * 3.6, 'km/h', 1),
    ];
    for (let i = 1; i < r.n; i++) {
      const a = decodeGear(gear[i - 1]);
      const b = decodeGear(gear[i]);
      if (a === b) continue;
      out.push(metric(`Shift ${a}→${b}`, `${(i * dt).toFixed(2)} s · ${Math.round(rpm[i - 1])} rpm · ${Math.round(v[i] * 3.6)} km/h`, '', 0, 'When, at what engine speed (before the shift), and at what road speed'));
    }
    return out;
  },
};

// --- 100–0 km/h -------------------------------------------------------------

const STOPPED = 0.5;

const braking: Manoeuvre = {
  id: 'braking',
  name: '100–0',
  title: 'From 100 km/h, full brake in a straight line until stopped: distance, time, deceleration and how much ABS worked',
  kmh: 100,
  gear: 'auto',
  duration: 10,
  span: 4,
  preset: 'grip',
  drive(_t, _p, _s, out) {
    set(out, 0, 0, 1);
  },
  // Stop before the brake key turns into reverse.
  done: (_t, p) => p.speed < STOPPED,
  metrics(r) {
    const v = series(r, 'speed')!;
    const end = first(r, 0, (i) => v[i] < STOPPED);
    const n = Number.isFinite(end) ? idx(r, end) + 1 : r.n;
    const abs = series(r, 'abs')!;
    let absOn = 0;
    for (let i = 0; i < n; i++) if (abs[i] > 0.01) absOn++;
    const x = series(r, 'x')!;
    const z = series(r, 'z')!;
    const h0 = series(r, 'heading')![0];
    let wander = 0;
    for (let i = 0; i < n; i++) wander = Math.max(wander, Math.abs((x[i] - x[0]) * -Math.cos(h0) + (z[i] - z[0]) * Math.sin(h0)));
    const time = n * dt;
    return [
      metric('Stopping distance', distance(r, n), 'm', 2),
      metric('Time', time, 's', 2),
      metric('Mean decel', (v[0] - v[n - 1]) / time / G, 'g', 2),
      metric('Peak decel', -min(series(r, 'accelLong')!, n) / G, 'g', 2),
      metric('ABS working', (absOn / n) * 100, '%', 0, 'Share of the stop ABS was releasing the brakes'),
      metric('Wander', wander, 'm', 2, 'Largest sideways drift off the start line'),
    ];
  },
};

function min(a: Float32Array, n = a.length): number {
  let m = Infinity;
  for (let i = 0; i < n; i++) m = Math.min(m, a[i]);
  return m;
}

// --- Ramp steer: the handling diagram ---------------------------------------

export const RAMP_AT = 1;
const RAMP_KMH = 60;
const RAMP_RATE = 0.1;

/** Lateral g (left +) and road-wheel angle (°) through a ramp-steer run's ramp, for the handling diagram. */
export function rampPoints(r: Run): { g: Float32Array; deg: Float32Array; from: number } {
  return { g: series(r, 'accelLat')!, deg: series(r, 'steerAngle')!, from: idx(r, RAMP_AT) };
}

export interface UndersteerFit {
  /** dδ/da_y over the linear range (°/g). */
  slope: number;
  intercept: number;
  /** The slope a neutral-steering car would show at this speed: wheelbase·g/v² (°/g). */
  neutral: number;
  /** The understeer gradient: slope − neutral (°/g; + understeer, − oversteer). */
  K: number;
  /** Lateral g range fitted. */
  lo: number;
  hi: number;
  /** Mean speed over it (m/s). */
  speed: number;
}

/**
 * Least squares of road-wheel angle on lateral g through the linear range
 * (0.05 g up to half the peak, at most 0.4 g). At a constant speed
 * δ = (L/v² + K)·a_y, so the understeer gradient is the slope less the
 * Ackermann (neutral) part.
 */
export function understeerFit(r: Run, car: CarSpec): UndersteerFit | null {
  const { g, deg, from } = rampPoints(r);
  const v = series(r, 'speed')!;
  let peak = 0;
  for (let i = from; i < r.n; i++) peak = Math.max(peak, g[i] / G);
  const lo = 0.05;
  const hi = Math.min(0.4, 0.5 * peak);
  if (hi <= lo + 0.05) return null;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let sv = 0;
  for (let i = from; i < r.n; i++) {
    const x = g[i] / G;
    if (x < lo || x > hi) continue;
    const y = deg[i] * DEG;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    sv += v[i];
  }
  if (n < 20) return null;
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const speed = sv / n;
  const neutral = ((car.chassis.wheelbase * G) / (speed * speed)) * DEG;
  return { slope, intercept: (sy - slope * sx) / n, neutral, K: slope - neutral, lo, hi, speed };
}

const rampSteer: Manoeuvre = {
  id: 'ramp-steer',
  name: 'Ramp steer',
  title: `${RAMP_KMH} km/h held by the throttle while the steering winds on at ${RAMP_RATE}/s: road-wheel angle against lateral g (the handling diagram) and the understeer gradient from its linear part`,
  kmh: RAMP_KMH,
  gear: 'hold',
  duration: RAMP_AT + 1 / RAMP_RATE,
  span: RAMP_AT + 1 / RAMP_RATE,
  preset: 'steering',
  drive(t, p, s, out) {
    set(out, holdSpeed(p, s, RAMP_KMH), MathUtils.clamp((t - RAMP_AT) * RAMP_RATE, 0, 1));
  },
  // Spun, or scrubbed off so much speed the curve no longer means anything.
  done: (t, p) => t > RAMP_AT && (Math.abs(p.slip) > 0.6 || p.speed < (RAMP_KMH / 3.6) * 0.5),
  metrics(r, car) {
    const fit = understeerFit(r, car);
    const { g, deg, from } = rampPoints(r);
    let peak = 0;
    let at = from;
    for (let i = from; i < r.n; i++) {
      if (g[i] > peak) {
        peak = g[i];
        at = i;
      }
    }
    const v = series(r, 'speed')!;
    let vLo = Infinity;
    let vHi = 0;
    for (let i = from; i < r.n; i++) {
      vLo = Math.min(vLo, v[i]);
      vHi = Math.max(vHi, v[i]);
    }
    return [
      metric('Understeer gradient', fit?.K ?? null, '°/g', 2, 'Road-wheel angle per g beyond what a neutral car would need at this speed (+ understeer, − oversteer)'),
      metric('Slope', fit?.slope ?? null, '°/g', 2, 'Road-wheel angle per g through the linear range'),
      metric('Neutral slope', fit?.neutral ?? null, '°/g', 2, 'Wheelbase·g/v²: the slope of a neutral-steering car'),
      metric('Fitted range', fit ? `${fit.lo.toFixed(2)}–${fit.hi.toFixed(2)} g` : '—', '', 0),
      metric('Peak lateral', peak / G, 'g', 2),
      metric('Angle at peak', deg[at] * DEG, '°', 1),
      metric('Speed range', `${(vLo * 3.6).toFixed(0)}–${(vHi * 3.6).toFixed(0)} km/h`, '', 0),
      metric('Ended at', (r.n - 1) * dt, 's', 1, `${(RAMP_AT + 1 / RAMP_RATE).toFixed(0)} s unless it spun or bled off speed`),
    ];
  },
};

export const MANOEUVRES: readonly Manoeuvre[] = [stepSteer, sineDwell, jTurn, launch, braking, rampSteer];

export function manoeuvre(id: string | null): Manoeuvre | undefined {
  return MANOEUVRES.find((m) => m.id === id);
}
