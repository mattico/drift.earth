import { PHYSICS } from '../config';
import { SURFACE_IDS } from '../car/surfaces';
import type { CarInput, CarPhysics } from '../car/physics';

/**
 * Per-step columns. Kept in a Float64Array ring so recording is always on and
 * costs nothing noticeable; a trace is the last `capacity` steps.
 */
export const FRAME_COLUMNS = [
  'step',
  't',
  'epoch',
  'x',
  'y',
  'z',
  'vx',
  'vz',
  'vy',
  'heading',
  'speed',
  'groundY',
  'throttle',
  'brake',
  'steer',
  'handbrake',
  /** Bits: 1 airborne, 2 waiting, 4 drifting, 8 contact, 16 long probe used, 32 in a tunnel. */
  'flags',
  /** Corner probe states (Probe enum), 2 bits each: FL | FR<<2 | RL<<4 | RR<<6. */
  'probes',
  /** Edge enum: 0 none, 1 ledge too tall, 2 drop. */
  'edge',
  'wallPen',
  'wallRay',
  'wallX',
  'wallY',
  'wallZ',
  'wallNx',
  'wallNz',
  /** geometricError of the tile the wall ray hit (−1 if unknown). */
  'wallGe',
  'impact',
  'colliders',
  'rpm',
  /** −1 reverse; +10 when the gearbox is in manual. */
  'gear',
  /** Rear wheel surface speed (m/s). */
  'wheelSpeed',
  /** Road-wheel angle (rad, left +). */
  'steerAngle',
  /** Front / rear slip angles (rad). */
  'slipF',
  'slipR',
  'yawRate',
  /** Body acceleration (m/s²; forward +, left +). */
  'accelLong',
  'accelLat',
  /** Axle normal loads (N). */
  'loadF',
  'loadR',
  /** Axle forces on the body (N; x forward, y left). */
  'forceFx',
  'forceFy',
  'forceRx',
  'forceRy',
  /** Contact-patch sliding speeds (m/s, 0 while gripping). */
  'slideF',
  'slideR',
  /** Driven wheels running ahead of the road (m/s). */
  'wheelSpin',
  /** Pedals after smoothing (0…1). */
  'throttleF',
  'handbrakeF',
  /** The driver's part of the road-wheel angle, and the lock full input asks for at this speed (rad). */
  'steerCmd',
  'steerLock',
  /** Driver aids: ABS and traction control as the share held back (0…1), stability as added yaw accel (rad/s²), re-arm countdown (s). */
  'abs',
  'tc',
  'stability',
  'rearm',
  /** Turbo boost (0…1), engine torque on tap (N·m) and drive force at the wheels (N). */
  'boost',
  'torque',
  'driveForce',
  /** Foot brake the car took (0…1): a key's or touch button's eased in. */
  'brakeF',
  /** Surface under each wheel (index into SURFACE_IDS), 3 bits each: FL | FR<<3 | RL<<6 | RR<<9. */
  'surfaces',
] as const;

export type FrameColumn = (typeof FRAME_COLUMNS)[number];

const STRIDE = FRAME_COLUMNS.length;
const COL = Object.fromEntries(FRAME_COLUMNS.map((c, i) => [c, i])) as Record<(typeof FRAME_COLUMNS)[number], number>;

export const FLAG_AIRBORNE = 1;
export const FLAG_WAITING = 2;
export const FLAG_DRIFTING = 4;
export const FLAG_CONTACT = 8;
export const FLAG_LONG_PROBE = 16;
export const FLAG_TUNNEL = 32;

export interface TraceEvent {
  /** Game clock (s). */
  t: number;
  /** Physics step counter at the time of the event. */
  step: number;
  kind: string;
  [k: string]: unknown;
}

export interface Trace {
  format: 'drift-trace';
  version: 1;
  meta: Record<string, unknown>;
  frames: { columns: readonly string[]; rows: number[][] };
  events: TraceEvent[];
}

/** Strips anything that looks like a Google API key or session token. */
export function redact(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…REDACTED')
    .replace(/([?&](?:key|session|token)=)[^&\s"']+/gi, '$1REDACTED');
}

export class TraceRecorder {
  private readonly buf: Float64Array;
  private head = 0;
  private count = 0;
  private readonly events: TraceEvent[] = [];
  private eventHead = 0;
  stepIndex = 0;
  epoch = 0;
  /** Game clock, set by the game each frame. */
  now = 0;

  constructor(
    readonly capacity = 120 * 60,
    private readonly eventCapacity = 4000,
  ) {
    this.buf = new Float64Array(capacity * STRIDE);
  }

  step(p: CarPhysics, inp: CarInput, colliders: number): void {
    const o = this.head * STRIDE;
    const b = this.buf;
    const w = p.wall;
    b[o + COL.step] = this.stepIndex++;
    b[o + COL.t] = this.now;
    b[o + COL.epoch] = this.epoch;
    b[o + COL.x] = p.pos.x;
    b[o + COL.y] = p.pos.y;
    b[o + COL.z] = p.pos.z;
    b[o + COL.vx] = p.vel.x;
    b[o + COL.vz] = p.vel.z;
    b[o + COL.vy] = p.vy;
    b[o + COL.heading] = p.heading;
    b[o + COL.speed] = p.speed;
    b[o + COL.groundY] = p.groundY;
    b[o + COL.throttle] = inp.throttle;
    b[o + COL.brake] = inp.brake;
    b[o + COL.steer] = inp.steer;
    b[o + COL.handbrake] = inp.handbrake ? 1 : 0;
    b[o + COL.flags] =
      (p.airborne ? FLAG_AIRBORNE : 0) |
      (p.waiting ? FLAG_WAITING : 0) |
      (p.drifting ? FLAG_DRIFTING : 0) |
      (p.contact ? FLAG_CONTACT : 0) |
      (p.usedLongProbe ? FLAG_LONG_PROBE : 0) |
      (p.tunnel ? FLAG_TUNNEL : 0);
    const s = p.probeState;
    b[o + COL.probes] = s[0] | (s[1] << 2) | (s[2] << 4) | (s[3] << 6);
    b[o + COL.edge] = p.edge;
    b[o + COL.wallPen] = w.pen;
    b[o + COL.wallRay] = w.pen > 0 ? w.ray : -1;
    b[o + COL.wallX] = w.pen > 0 ? w.point.x : 0;
    b[o + COL.wallY] = w.pen > 0 ? w.point.y : 0;
    b[o + COL.wallZ] = w.pen > 0 ? w.point.z : 0;
    b[o + COL.wallNx] = w.pen > 0 ? w.normal.x : 0;
    b[o + COL.wallNz] = w.pen > 0 ? w.normal.z : 0;
    b[o + COL.wallGe] = w.pen > 0 ? w.geometricError : 0;
    b[o + COL.impact] = p.impact;
    b[o + COL.colliders] = colliders;
    b[o + COL.rpm] = p.drivetrain.rpm;
    b[o + COL.gear] = p.drivetrain.gear + (p.drivetrain.mode === 'manual' ? 10 : 0);
    b[o + COL.wheelSpeed] = p.wheelSpeed;
    b[o + COL.steerAngle] = p.steer;
    b[o + COL.slipF] = p.tire.slipF;
    b[o + COL.slipR] = p.tire.slipR;
    b[o + COL.yawRate] = p.yawRate;
    const t = p.tire;
    b[o + COL.accelLong] = p.accelLong;
    b[o + COL.accelLat] = p.accelLat;
    b[o + COL.loadF] = t.loadF;
    b[o + COL.loadR] = t.loadR;
    b[o + COL.forceFx] = t.forceF[0];
    b[o + COL.forceFy] = t.forceF[1];
    b[o + COL.forceRx] = t.forceR[0];
    b[o + COL.forceRy] = t.forceR[1];
    b[o + COL.slideF] = t.slideF;
    b[o + COL.slideR] = t.slideR;
    b[o + COL.wheelSpin] = p.wheelSpin;
    b[o + COL.throttleF] = p.throttleF;
    b[o + COL.handbrakeF] = p.handbrakeF;
    b[o + COL.steerCmd] = p.steerCmd;
    b[o + COL.steerLock] = p.steerLock;
    b[o + COL.abs] = p.aids.abs;
    b[o + COL.tc] = p.aids.tc;
    b[o + COL.stability] = p.aids.stability;
    b[o + COL.rearm] = p.aids.rearm;
    const d = p.drivetrain;
    b[o + COL.boost] = d.boost;
    b[o + COL.torque] = d.output().torque;
    b[o + COL.driveForce] = d.force;
    b[o + COL.brakeF] = p.brakeF;
    const g = p.surface;
    b[o + COL.surfaces] = SURFACE_IDS.indexOf(g[0]) | (SURFACE_IDS.indexOf(g[1]) << 3) | (SURFACE_IDS.indexOf(g[2]) << 6) | (SURFACE_IDS.indexOf(g[3]) << 9);
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  event(kind: string, data: Record<string, unknown> = {}): TraceEvent {
    const e: TraceEvent = { t: this.now, step: this.stepIndex, kind, ...data };
    if (this.events.length < this.eventCapacity) this.events.push(e);
    else {
      this.events[this.eventHead] = e;
      this.eventHead = (this.eventHead + 1) % this.eventCapacity;
    }
    return e;
  }

  get steps(): number {
    return this.count;
  }

  /** Events oldest first. */
  eventList(): TraceEvent[] {
    return [...this.events.slice(this.eventHead), ...this.events.slice(0, this.eventHead)];
  }

  /** Column index, for `value`. */
  static column(name: FrameColumn): number {
    return COL[name];
  }

  /**
   * One recorded value without copying: `ago` steps back from the newest (0),
   * up to `steps − 1`. `col` from `TraceRecorder.column`.
   */
  value(col: number, ago = 0): number {
    return this.buf[((this.head - 1 - ago + 2 * this.capacity) % this.capacity) * STRIDE + col];
  }

  /** Most recent frame row as a column → value object (or null before the first step). */
  lastFrame(): Record<string, number> | null {
    if (!this.count) return null;
    const o = ((this.head - 1 + this.capacity) % this.capacity) * STRIDE;
    return Object.fromEntries(FRAME_COLUMNS.map((c, i) => [c, this.buf[o + i]]));
  }

  /** Snapshot as plain JSON-able data. `seconds` limits how far back frames go. */
  export(meta: Record<string, unknown>, seconds?: number): Trace {
    const n = seconds ? Math.min(this.count, Math.round(seconds / PHYSICS.dt)) : this.count;
    const rows: number[][] = [];
    for (let k = n; k > 0; k--) {
      const o = ((this.head - k + this.capacity) % this.capacity) * STRIDE;
      const row = new Array<number>(STRIDE);
      for (let i = 0; i < STRIDE; i++) row[i] = round(this.buf[o + i]);
      rows.push(row);
    }
    const firstStep = rows.length ? rows[0][COL.step] : this.stepIndex;
    const events = this.eventList().filter((e) => !seconds || e.step >= firstStep);
    return { format: 'drift-trace', version: 1, meta, frames: { columns: FRAME_COLUMNS, rows }, events };
  }

  clear(): void {
    this.head = this.count = 0;
    this.events.length = 0;
    this.eventHead = 0;
  }
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
