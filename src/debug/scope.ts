import { Vector3 } from 'three';
import type { CarSpec } from '../car/cars';
import type { ShiftMode } from '../car/drivetrain';
import type { CarInput, CarPhysics } from '../car/physics';
import { PHYSICS } from '../config';
import { decodeGear, manoeuvre, MANOEUVRES, rampPoints, RunState, understeerFit, type Manoeuvre, type Metric, type Run } from './manoeuvres';
import './scope.css';
import { FRAME_COLUMNS, TraceRecorder, type FrameColumn } from './trace';

export interface ScopeHandlers {
  recorder: TraceRecorder;
  physics: CarPhysics;
  /** Respawns the car at `pos` facing `heading`, rolling at `kmh` (the game's own spawn: camera, crumbs and all). */
  teleport(pos: Vector3, heading: number, kmh: number): void;
  /** The car and preset being driven, e.g. "hatch · My grippy setup (unsaved)", to label runs with. */
  describe(): string;
  notice(text: string): void;
  event(kind: string, data?: Record<string, unknown>): void;
}

const dt = PHYSICS.dt;
const DEG = 180 / Math.PI;
const G = 9.80665;
const STORAGE = 'drift.earth:scope';

/**
 * Where the practice track has room: past the city's last blocks (±430 m) the
 * asphalt runs on to ±1500 m, so facing +x from here there are 2.5 km ahead
 * and 500 m either side, enough for a launch, a stop or a ramp-steer circle.
 */
const OPEN_GROUND = new Vector3(-1000, 0, 950);
const OPEN_HEADING = -Math.PI / 2;

const WINDOWS = [5, 10, 30];
const MAX_PINS = 5;
/** Pins draw in their channel's colour with a dash of their own; their letter, swatch and handling-diagram colour come from the slot. */
const PIN_DASH: number[][] = [[6, 3], [2, 2], [9, 3, 2, 3], [1, 4], [14, 4]];
const PIN_COLORS = ['#ffd166', '#06d6a0', '#ef476f', '#a78bfa', '#7dd3fc'];
const PIN_LETTERS = 'ABCDE';

const LANE_H = 66;
const LANE_HEAD = 13;
const AXIS_H = 16;
const PAD_R = 38;
const HANDLING_H = 300;
const FONT = '10px ui-monospace, Consolas, monospace';
const GRID = 'rgba(255,255,255,0.08)';
const MUTED = 'rgba(255,255,255,0.45)';

// --- Channels ----------------------------------------------------------------

type LaneId =
  | 'slip'
  | 'yaw'
  | 'steerIn'
  | 'steerDeg'
  | 'g'
  | 'slide'
  | 'aid'
  | 'stab'
  | 'rearm'
  | 'speed'
  | 'rpm'
  | 'gear'
  | 'boost'
  | 'spin'
  | 'force'
  | 'torque'
  | 'pedal'
  | 'hb'
  | 'load'
  | 'fy'
  | 'fx';

interface Ref {
  v: number;
  label: string;
  dash: boolean;
}

interface LaneDef {
  unit: string;
  /** Symmetric about 0. */
  sym: boolean;
  /** The least the axis shows (it grows to fit the data unless `fixed`). */
  lo: number;
  hi: number;
  fixed?: boolean;
  /** A range that depends on the car (rpm, gears), instead of lo/hi. */
  range?(car: CarSpec): [number, number];
  /** Lines that mean something for this car, in display units. */
  refs?(car: CarSpec): Ref[];
}

const LANES: Record<LaneId, LaneDef> = {
  slip: {
    unit: '°',
    sym: true,
    lo: -10,
    hi: 10,
    refs: (car) => {
      const c = car.chassis;
      const peak = c.peakSlipAngle * DEG;
      const out: Ref[] = [
        { v: peak, label: 'peak', dash: false },
        { v: -peak, label: '', dash: false },
      ];
      if (c.stabilitySlip !== undefined && Math.abs(c.stabilitySlip - c.peakSlipAngle) > 1e-4) {
        out.push({ v: c.stabilitySlip * DEG, label: 'ESC', dash: true }, { v: -c.stabilitySlip * DEG, label: '', dash: true });
      }
      return out;
    },
  },
  yaw: { unit: '°/s', sym: true, lo: -20, hi: 20 },
  steerIn: { unit: '', sym: true, lo: -1, hi: 1, fixed: true },
  steerDeg: { unit: '°', sym: true, lo: -5, hi: 5 },
  g: { unit: 'g', sym: true, lo: -0.5, hi: 0.5 },
  slide: { unit: 'km/h', sym: false, lo: 0, hi: 5 },
  aid: { unit: '%', sym: false, lo: 0, hi: 100, fixed: true },
  stab: { unit: '°/s²', sym: true, lo: -50, hi: 50 },
  rearm: { unit: 's', sym: false, lo: 0, hi: 1 },
  speed: { unit: 'km/h', sym: false, lo: 0, hi: 100 },
  rpm: {
    unit: '',
    sym: false,
    lo: 0,
    hi: 8000,
    fixed: true,
    range: (car) => [0, Math.ceil((car.drivetrain.limiter * 1.08) / 500) * 500],
    refs: (car) => [{ v: car.drivetrain.redline, label: 'red', dash: true }],
  },
  gear: { unit: '', sym: false, lo: -1, hi: 6, fixed: true, range: (car) => [-1, car.drivetrain.gears.length] },
  boost: { unit: '%', sym: false, lo: 0, hi: 100, fixed: true },
  spin: { unit: 'km/h', sym: false, lo: 0, hi: 5 },
  force: { unit: 'kN', sym: false, lo: 0, hi: 5 },
  torque: { unit: 'N·m', sym: false, lo: 0, hi: 200 },
  pedal: { unit: '%', sym: false, lo: 0, hi: 100, fixed: true },
  hb: { unit: '%', sym: false, lo: 0, hi: 100, fixed: true },
  load: { unit: 'kN', sym: false, lo: 0, hi: 10 },
  fy: { unit: 'kN', sym: true, lo: -5, hi: 5 },
  fx: { unit: 'kN', sym: true, lo: -5, hi: 5 },
};

interface Channel {
  col: FrameColumn;
  label: string;
  lane: LaneId;
  color: string;
  /** Recorded (SI) value → display units. */
  tf(v: number): number;
  digits: number;
  /** Also drawn negated (a ± limit). */
  mirror?: boolean;
  /** What it is, for the picker's tooltip. */
  title: string;
}

const C1 = '#5ec8ff';
const C2 = '#ffaa44';
const C3 = '#9be564';
const C4 = '#ff6b8b';
const C5 = '#c39bff';
const C6 = '#e8e8e8';
const DIM = '#8a8f99';

const deg = (v: number) => v * DEG;
const gs = (v: number) => v / G;
const kmh = (v: number) => v * 3.6;
const kN = (v: number) => v / 1000;
const pct = (v: number) => v * 100;
const raw = (v: number) => v;

const CHANNELS: Channel[] = [
  { col: 'slipF', label: 'slip F', lane: 'slip', color: C1, tf: deg, digits: 1, title: 'Front slip angle' },
  { col: 'slipR', label: 'slip R', lane: 'slip', color: C2, tf: deg, digits: 1, title: 'Rear slip angle' },
  { col: 'yawRate', label: 'yaw', lane: 'yaw', color: C4, tf: deg, digits: 1, title: 'Yaw rate (left +)' },
  { col: 'steer', label: 'input', lane: 'steerIn', color: C6, tf: raw, digits: 2, title: 'Steering input (−1 right … +1 left)' },
  { col: 'steerCmd', label: 'cmd', lane: 'steerDeg', color: C3, tf: deg, digits: 1, title: 'The driver’s part of the road-wheel angle (rate-limited)' },
  { col: 'steerAngle', label: 'wheel', lane: 'steerDeg', color: C1, tf: deg, digits: 1, title: 'Road-wheel angle, self-alignment included' },
  { col: 'steerLock', label: '±lock', lane: 'steerDeg', color: DIM, tf: deg, digits: 1, mirror: true, title: 'The lock full input asks for at this speed' },
  { col: 'accelLat', label: 'lat', lane: 'g', color: C1, tf: gs, digits: 2, title: 'Lateral acceleration (left +)' },
  { col: 'accelLong', label: 'long', lane: 'g', color: C2, tf: gs, digits: 2, title: 'Longitudinal acceleration (forward +)' },
  { col: 'slideF', label: 'slide F', lane: 'slide', color: C1, tf: kmh, digits: 1, title: 'Front contact patch sliding speed' },
  { col: 'slideR', label: 'slide R', lane: 'slide', color: C2, tf: kmh, digits: 1, title: 'Rear contact patch sliding speed' },
  { col: 'abs', label: 'ABS', lane: 'aid', color: C1, tf: pct, digits: 0, title: 'ABS: share of the brake held back' },
  { col: 'tc', label: 'TC', lane: 'aid', color: C2, tf: pct, digits: 0, title: 'Traction control: share of the drive held back' },
  { col: 'stability', label: 'ESC', lane: 'stab', color: C4, tf: deg, digits: 0, title: 'Stability control: yaw acceleration it added' },
  { col: 'rearm', label: 'rearm', lane: 'rearm', color: C3, tf: raw, digits: 2, title: 'Seconds until stability control re-arms after a deliberate slide' },
  { col: 'speed', label: 'speed', lane: 'speed', color: C6, tf: kmh, digits: 0, title: 'Ground speed' },
  { col: 'wheelSpeed', label: 'wheel', lane: 'speed', color: C1, tf: kmh, digits: 0, title: 'Driven wheels’ surface speed' },
  { col: 'rpm', label: 'rpm', lane: 'rpm', color: C6, tf: raw, digits: 0, title: 'Engine speed' },
  { col: 'gear', label: 'gear', lane: 'gear', color: C3, tf: decodeGear, digits: 0, title: 'Gear (−1 reverse)' },
  { col: 'boost', label: 'boost', lane: 'boost', color: C5, tf: pct, digits: 0, title: 'Turbo boost' },
  { col: 'wheelSpin', label: 'spin', lane: 'spin', color: C2, tf: kmh, digits: 1, title: 'Driven wheels running ahead of the road' },
  { col: 'driveForce', label: 'drive', lane: 'force', color: C3, tf: kN, digits: 2, title: 'Drive force at the wheels' },
  { col: 'torque', label: 'torque', lane: 'torque', color: C4, tf: raw, digits: 0, title: 'Engine torque on tap' },
  { col: 'throttle', label: 'thr', lane: 'pedal', color: C3, tf: pct, digits: 0, title: 'Throttle input' },
  { col: 'throttleF', label: 'thr F', lane: 'pedal', color: C1, tf: pct, digits: 0, title: 'Throttle after smoothing' },
  { col: 'brake', label: 'brake', lane: 'pedal', color: C4, tf: pct, digits: 0, title: 'Brake input' },
  { col: 'handbrake', label: 'hb', lane: 'hb', color: C5, tf: pct, digits: 0, title: 'Handbrake input' },
  { col: 'handbrakeF', label: 'hb F', lane: 'hb', color: C2, tf: pct, digits: 0, title: 'Handbrake after smoothing' },
  { col: 'loadF', label: 'load F', lane: 'load', color: C1, tf: kN, digits: 1, title: 'Front axle normal load' },
  { col: 'loadR', label: 'load R', lane: 'load', color: C2, tf: kN, digits: 1, title: 'Rear axle normal load' },
  { col: 'forceFy', label: 'Fy F', lane: 'fy', color: C1, tf: kN, digits: 2, title: 'Front axle lateral force on the body' },
  { col: 'forceRy', label: 'Fy R', lane: 'fy', color: C2, tf: kN, digits: 2, title: 'Rear axle lateral force on the body' },
  { col: 'forceFx', label: 'Fx F', lane: 'fx', color: C1, tf: kN, digits: 2, title: 'Front axle longitudinal force on the body' },
  { col: 'forceRx', label: 'Fx R', lane: 'fx', color: C2, tf: kN, digits: 2, title: 'Rear axle longitudinal force on the body' },
];
const LANE_ORDER = Object.keys(LANES) as LaneId[];

const PRESETS: Record<string, { label: string; title: string; cols: FrameColumn[] }> = {
  balance: { label: 'Balance', title: 'Slip angles front and rear, yaw rate and the road-wheel angle', cols: ['slipF', 'slipR', 'yawRate', 'steerAngle'] },
  steering: { label: 'Steering', title: 'Input, the rate-limited command, the road-wheel angle and the lock at this speed', cols: ['steer', 'steerCmd', 'steerAngle', 'steerLock'] },
  grip: { label: 'Grip', title: 'Lateral and longitudinal g, and how fast each axle slides', cols: ['accelLat', 'accelLong', 'slideF', 'slideR', 'speed'] },
  aids: { label: 'Aids', title: 'ABS, traction control, stability control and its re-arm countdown', cols: ['abs', 'tc', 'stability', 'rearm'] },
  drivetrain: { label: 'Drivetrain', title: 'Speed, rpm, gear, boost, wheelspin and drive force', cols: ['speed', 'rpm', 'gear', 'boost', 'wheelSpin', 'driveForce'] },
  pedals: { label: 'Pedals', title: 'Throttle, brake and handbrake, as pressed and after smoothing', cols: ['throttle', 'throttleF', 'brake', 'handbrake', 'handbrakeF'] },
  forces: { label: 'Forces', title: 'Axle loads and the forces each axle puts on the body', cols: ['loadF', 'loadR', 'forceFy', 'forceRy', 'forceFx', 'forceRx'] },
};

interface Lane {
  id: LaneId;
  def: LaneDef;
  channels: Channel[];
  lo: number;
  hi: number;
  refs: Ref[];
}

/**
 * One trace on the time axis: the live recorder (k = steps ago) or a pinned
 * run (k = its step index). Sample k sits at t0 + k·dk seconds; only
 * k ∈ [k0, n) are drawn.
 */
class Source {
  run: Run | null = null;
  n = 0;
  k0 = 0;
  t0 = 0;
  dk = 0;
  /** Drawn solid, like the live trace (a pinned run standing in for live data that's gone). */
  solid = false;
  constructor(private readonly rec: TraceRecorder | null) {}

  col(name: string): number {
    if (this.run) return this.run.columns.indexOf(name);
    return TraceRecorder.column(name as FrameColumn) ?? -1;
  }

  at(c: number, k: number): number {
    const r = this.run;
    return r ? r.data[c * r.n + k] : this.rec!.value(c, k);
  }

  /** Nearest sample to time `t`, or −1. */
  near(t: number): number {
    if (!this.n || !this.dk) return -1;
    const k = Math.round((t - this.t0) / this.dk);
    return k >= this.k0 && k < this.n ? k : -1;
  }
}

interface Anchor {
  /** Manoeuvre id. */
  id: string;
  startStep: number;
  /** Last step of the run; −1 while it runs. */
  endStep: number;
  /** The pin it became (−1 until it finishes). */
  pinId: number;
}

interface Active {
  m: Manoeuvre;
  /** Steps run. */
  k: number;
  startStep: number;
  epoch: number;
  /** The gearbox mode to put back. */
  mode: ShiftMode;
  s: RunState;
  resolve: ((r: Record<string, unknown> | null) => void) | null;
}

interface Saved {
  window?: number;
  cols?: string[];
  view?: 'strip' | 'handling';
  openGround?: boolean;
}

type Follow = 'live' | 'run';

/**
 * The debug panel's Scope tab: MoTeC-style strip charts of the trace
 * recorder, ghost runs pinned for A/B comparison, and scripted manoeuvres
 * that drive the car through repeatable tests. Plain DOM and Canvas 2D.
 * Also `__drift.debug.scope`.
 */
export class Scope {
  private readonly root = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly resize: ResizeObserver;
  private readonly pinList = document.createElement('div');
  private readonly metricsEl = document.createElement('div');
  private readonly statusEl = document.createElement('span');
  private readonly abortBtn: HTMLButtonElement;
  private readonly groundBtn: HTMLButtonElement;
  private readonly viewBtns = new Map<string, HTMLButtonElement>();
  private readonly windowBtns = new Map<number, HTMLButtonElement>();
  private readonly followBtns = new Map<Follow, HTMLButtonElement>();
  private readonly presetBtns = new Map<string, HTMLButtonElement>();
  private readonly chanBoxes = new Map<FrameColumn, HTMLInputElement>();
  private readonly runBtns: HTMLButtonElement[] = [];
  private readonly onKey = (e: KeyboardEvent) => this.key(e);

  /** Window length (s) when following live. */
  windowSec = 10;
  view: 'strip' | 'handling' = 'strip';
  follow: Follow = 'live';
  /** Start manoeuvres on the practice track's open ground rather than where the car is. */
  openGround = new URLSearchParams(location.search).has('practice');
  private cols: FrameColumn[] = [...PRESETS.balance.cols];
  private lanes: Lane[] = [];
  /** Pinned runs, oldest first. */
  private pinned: Run[] = [];
  private nextPin = 1;
  private active: Active | null = null;
  private anchor: Anchor | null = null;
  private readonly out: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private disposed = false;

  private readonly live: Source;
  private readonly pinSrc: Source[] = [];
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private hover: { x: number; y: number } | null = null;
  private dirty = true;
  private drawnStep = -1;
  private refsAt = -Infinity;
  private status = '';
  private readonly colStep = TraceRecorder.column('step');
  private readonly colSpeed = TraceRecorder.column('speed');
  private readonly colLat = TraceRecorder.column('accelLat');
  private readonly colAngle = TraceRecorder.column('steerAngle');
  // Pixel bucket for the min/max decimation in plot().
  private bx = NaN;
  private bFirst = 0;
  private bLast = 0;
  private bMin = 0;
  private bMax = 0;
  private bOpen = false;
  /** kRange()'s result. */
  private kLo = 0;
  private kHi = -1;

  constructor(
    readonly host: HTMLElement,
    readonly h: ScopeHandlers,
  ) {
    this.live = new Source(h.recorder);
    for (let i = 0; i < MAX_PINS; i++) this.pinSrc.push(new Source(null));
    this.load();
    this.ctx = this.canvas.getContext('2d')!;
    this.root.className = 'scope';
    this.build();
    host.append(this.root);
    this.abortBtn = this.root.querySelector<HTMLButtonElement>('[data-act="abort"]')!;
    this.groundBtn = this.root.querySelector<HTMLButtonElement>('[data-act="ground"]')!;
    this.resize = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1].contentRect.width;
      if (w !== this.cssW) {
        this.cssW = w;
        this.dirty = true;
      }
    });
    this.resize.observe(this.canvas.parentElement!);
    window.addEventListener('keydown', this.onKey);
    this.buildLanes();
    this.sync();
  }

  // --- API (also `__drift.debug.scope`) ------------------------------------------

  /** The scripted manoeuvres: `run(id)` takes one of these ids. */
  manoeuvres(): Array<{ id: string; name: string; title: string }> {
    return MANOEUVRES.map((m) => ({ id: m.id, name: m.name, title: m.title }));
  }

  /**
   * Runs a manoeuvre: respawns at its start speed (on open ground, or where the
   * car is) and drives it step by step. Resolves with its metrics when it
   * finishes, or null if it's aborted.
   */
  run(id: string): Promise<Record<string, unknown> | null> {
    const m = manoeuvre(id);
    // A hot update replaced this Scope; a script still holding it would wait forever.
    if (this.disposed) return Promise.resolve(null);
    if (!m) {
      this.h.notice(`No manoeuvre “${id}” (${MANOEUVRES.map((x) => x.id).join(', ')})`);
      return Promise.resolve(null);
    }
    if (this.active) this.abort('another started');
    const p = this.h.physics;
    const mode = p.drivetrain.mode;
    const pos = this.openGround ? OPEN_GROUND.clone() : p.pos.clone();
    this.h.teleport(pos, this.openGround ? OPEN_HEADING : p.heading, m.kmh);
    // The spawn's launch() picked the gear for the start speed; 'hold' keeps it there.
    p.drivetrain.mode = m.gear === 'hold' ? 'manual' : 'auto';
    const rec = this.h.recorder;
    const startStep = rec.stepIndex;
    this.active = { m, k: 0, startStep, epoch: rec.epoch, mode, s: new RunState(), resolve: null };
    this.anchor = { id: m.id, startStep, endStep: -1, pinId: -1 };
    this.follow = 'run';
    this.setPreset(m.preset);
    if (m.id === 'ramp-steer') this.view = 'handling';
    this.h.event('manoeuvre', { id: m.id, phase: 'start', car: this.h.describe(), openGround: this.openGround });
    this.sync();
    return new Promise((resolve) => {
      if (this.active?.m === m) this.active.resolve = resolve;
      else resolve(null);
    });
  }

  /** Stops the running manoeuvre; the player has the car back. */
  abort(reason = 'stopped'): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.h.physics.drivetrain.mode = a.mode;
    if (this.anchor) this.anchor.endStep = this.newestStep();
    this.h.notice(`${a.m.name} aborted: ${reason}`);
    this.h.event('manoeuvre', { id: a.m.id, phase: 'aborted', reason, steps: a.k });
    a.resolve?.(null);
    this.sync();
  }

  get running(): string | null {
    return this.active?.m.id ?? null;
  }

  /**
   * Pins the visible window (following a run: that run) as a ghost to compare
   * against. Returns its id, or null with nothing recorded.
   */
  pin(label = this.h.describe()): number | null {
    const rec = this.h.recorder;
    const a = this.anchor;
    let run: Run | null = null;
    if (this.follow === 'run' && a && !this.active) {
      const n = (a.endStep >= 0 ? a.endStep : this.newestStep()) - a.startStep + 1;
      const ago = this.newestStep() - a.startStep;
      if (ago < rec.steps && n > 1) run = this.capture(ago, n, a.id);
    }
    if (!run) {
      const n = Math.min(rec.steps, Math.round(this.windowSec / dt));
      if (n < 2) return null;
      run = this.capture(n - 1, n, null);
    }
    run.label = label;
    this.addPin(run);
    return run.id;
  }

  unpin(id: number): void {
    this.pinned = this.pinned.filter((r) => r.id !== id);
    this.syncPins();
  }

  clearPins(): void {
    this.pinned = [];
    this.syncPins();
  }

  /** The pinned runs, oldest first, with their metrics. */
  pins(): Array<{ id: number; letter: string; label: string; time: string; manoeuvre: string | null; seconds: number; on: boolean; metrics: Record<string, unknown> | null }> {
    return this.pinned.map((r) => ({
      id: r.id,
      letter: PIN_LETTERS[slotOf(r)],
      label: r.label,
      time: r.time,
      manoeuvre: r.manoeuvre,
      seconds: r.n * dt,
      on: r.on,
      metrics: r.metrics ? flatMetrics(r.metrics) : null,
    }));
  }

  /** Shows a pin on the chart or hides it. */
  showPin(id: number, on = true): void {
    const r = this.pinned.find((x) => x.id === id);
    if (r) r.on = on;
    this.syncPins();
  }

  /** Window length when following live: 5, 10 or 30 s. */
  setWindow(seconds: number): void {
    this.windowSec = WINDOWS.includes(seconds) ? seconds : 10;
    this.follow = 'live';
    this.persist();
    this.sync();
  }

  /** Channel preset: balance, steering, grip, aids, drivetrain, pedals or forces. */
  setPreset(name: string): void {
    const p = PRESETS[name];
    if (p) this.setChannels(p.cols);
  }

  /** Channels by trace column, e.g. `['slipF', 'yawRate', 'accelLat']` (see `channels()`). */
  setChannels(cols: readonly string[]): void {
    this.cols = CHANNELS.filter((c) => cols.includes(c.col)).map((c) => c.col);
    this.buildLanes();
    this.persist();
    this.sync();
  }

  /** Every channel the picker offers, by trace column. */
  channels(): Array<{ col: string; label: string; unit: string }> {
    return CHANNELS.map((c) => ({ col: c.col, label: c.label, unit: LANES[c.lane].unit }));
  }

  /** Strip charts, or the handling diagram (road-wheel angle against lateral g). */
  setView(view: 'strip' | 'handling'): void {
    this.view = view === 'handling' ? 'handling' : 'strip';
    this.persist();
    this.sync();
  }

  /** Follow the live trace, or the last manoeuvre run (time from its start). */
  setFollow(follow: Follow): void {
    this.follow = follow === 'run' && this.anchor ? 'run' : 'live';
    this.sync();
  }

  // --- Game hooks -------------------------------------------------------------

  /** Every rendered frame; `visible` is whether the tab is showing. */
  frame(_dt: number, time: number, visible: boolean): void {
    if (!visible) return;
    const a = this.active;
    const status = a ? `${a.m.name} ${(a.k * dt).toFixed(1)} s` : '';
    if (status !== this.status) {
      this.status = status;
      this.statusEl.textContent = status;
    }
    // The car's numbers (tuning edits included) change the reference lines and some ranges.
    if (time - this.refsAt > 0.5) {
      this.refsAt = time;
      this.refreshRefs();
      this.dirty = true;
    }
    const step = this.h.recorder.stepIndex;
    if (!this.dirty && step === this.drawnStep) return;
    this.dirty = false;
    this.drawnStep = step;
    this.draw();
  }

  /** Every physics step, before it runs: the input a scripted manoeuvre drives with, or null to let the player drive. */
  input(inp: CarInput): CarInput | null {
    const a = this.active;
    if (!a) return null;
    // A gamepad at rest can read a little off centre.
    if (inp.throttle > 0.1 || inp.brake > 0.1 || Math.abs(inp.steer) > 0.2 || inp.handbrake) {
      this.abort('player input');
      return null;
    }
    a.m.drive(a.k * dt, this.h.physics, a.s, this.out);
    return this.out;
  }

  /** Every physics step, after it ran (and after the recorder took it). */
  onStep(p: CarPhysics): void {
    const a = this.active;
    if (!a) return;
    a.k++;
    if (this.h.recorder.epoch !== a.epoch) return this.abort('the world moved under it');
    if (p.contact) return this.abort('hit something');
    const t = a.k * dt;
    if (t >= a.m.duration - 1e-9 || a.m.done?.(t, p, a.s)) this.finish();
  }

  /** Takes over what the previous Scope (from before a hot update; maybe older code) had. */
  adopt(prev: Scope): void {
    // Only the ghosts: the recorder is new too, so the last run's anchor means nothing now. (A run in
    // progress was stopped by prev.dispose(), which put the gearbox mode back before the new game copied it.)
    const old = prev as unknown as { pinned?: unknown };
    if (Array.isArray(old.pinned)) {
      for (const r of old.pinned as unknown[]) {
        if (!isRun(r) || this.pinned.length >= MAX_PINS) continue;
        this.pinned.push({ ...r, slot: undefined } as Run);
        this.nextPin = Math.max(this.nextPin, r.id + 1);
      }
      for (const r of this.pinned) setSlot(r, this.pinned);
    }
    this.syncPins();
  }

  dispose(): void {
    this.disposed = true;
    const a = this.active;
    if (a) {
      this.active = null;
      this.h.physics.drivetrain.mode = a.mode;
      a.resolve?.(null);
    }
    window.removeEventListener('keydown', this.onKey);
    this.resize.disconnect();
    this.root.remove();
  }

  // --- Runner -----------------------------------------------------------------

  private finish(): void {
    const a = this.active!;
    this.active = null;
    this.h.physics.drivetrain.mode = a.mode;
    const rec = this.h.recorder;
    const newest = this.newestStep();
    const n = newest - a.startStep + 1;
    if (n < 2 || n > rec.steps) {
      a.resolve?.(null);
      return this.sync();
    }
    const run = this.capture(n - 1, n, a.m.id);
    run.label = this.h.describe();
    run.metrics = a.m.metrics(run, this.h.physics.car);
    this.addPin(run);
    if (this.anchor) {
      this.anchor.endStep = newest;
      this.anchor.pinId = run.id;
    }
    const flat = flatMetrics(run.metrics);
    this.h.event('manoeuvre', { id: a.m.id, phase: 'done', car: run.label, steps: n, metrics: flat });
    const head = run.metrics.slice(0, 2).map(formatMetric).join(', ');
    this.h.notice(`${a.m.name}: ${head}`);
    a.resolve?.(flat);
    this.sync();
  }

  /** Copies `n` recorded steps, the oldest `ago` steps back, into a run. */
  private capture(ago: number, n: number, id: string | null): Run {
    const rec = this.h.recorder;
    const cols = FRAME_COLUMNS.length;
    const data = new Float32Array(cols * n);
    for (let c = 0; c < cols; c++) {
      const o = c * n;
      for (let i = 0; i < n; i++) data[o + i] = rec.value(c, ago - i);
    }
    const d = new Date();
    const pad = (v: number) => String(v).padStart(2, '0');
    return {
      id: this.nextPin++,
      label: '',
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      manoeuvre: id,
      columns: FRAME_COLUMNS,
      n,
      data,
      metrics: null,
      on: true,
    };
  }

  private addPin(run: Run): void {
    // Full: the oldest makes room.
    while (this.pinned.length >= MAX_PINS) this.pinned.shift();
    setSlot(run, this.pinned);
    this.pinned.push(run);
    this.syncPins();
  }

  private newestStep(): number {
    const rec = this.h.recorder;
    return rec.steps ? rec.value(this.colStep, 0) : rec.stepIndex - 1;
  }

  private key(e: KeyboardEvent): void {
    if (!this.active || e.repeat) return;
    // F-keys work the debug tools (F3 closes the panel, F8 marks); anything else is the player taking over.
    if (/^F\d+$/.test(e.key) || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    this.abort(e.key === 'Escape' ? 'Esc' : `key ${e.key}`);
  }

  // --- DOM --------------------------------------------------------------------

  private build(): void {
    const root = this.root;
    const row = (label: string, title = '') => {
      const r = document.createElement('div');
      r.className = 'dbg-row';
      const l = document.createElement('span');
      l.className = 'dbg-label';
      l.textContent = label;
      l.title = title;
      r.append(l);
      root.append(r);
      return r;
    };

    const view = row('View');
    for (const [v, label, title] of [
      ['strip', 'Strip', 'Strip charts against time'],
      ['handling', 'Handling', 'Handling diagram: road-wheel angle against lateral g (ramp-steer runs and the live window)'],
    ] as const) {
      const b = button(label, title, () => this.setView(v));
      this.viewBtns.set(v, b);
      view.append(b);
    }
    view.append(sep());
    for (const s of WINDOWS) {
      const b = button(`${s} s`, `Follow the last ${s} s live`, () => this.setWindow(s));
      this.windowBtns.set(s, b);
      view.append(b);
    }
    view.append(sep());
    const follow = button('Run', 'Follow the last manoeuvre: time from its start, ghosts of the same manoeuvre lined up on it', () => this.setFollow('run'));
    this.followBtns.set('run', follow);
    view.append(follow);

    const show = row('Show');
    for (const [name, p] of Object.entries(PRESETS)) {
      const b = button(p.label, p.title, () => this.setPreset(name));
      this.presetBtns.set(name, b);
      show.append(b);
    }
    const picker = document.createElement('details');
    picker.className = 'scope-chans';
    const summary = document.createElement('summary');
    summary.textContent = 'Channels';
    summary.addEventListener('click', () => summary.blur());
    const grid = document.createElement('div');
    for (const c of CHANNELS) {
      const label = document.createElement('label');
      label.title = c.title;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => {
        box.blur();
        this.setChannels(box.checked ? [...this.cols, c.col] : this.cols.filter((x) => x !== c.col));
      });
      this.chanBoxes.set(c.col, box);
      const sw = document.createElement('i');
      sw.style.background = c.color;
      const unit = LANES[c.lane].unit;
      label.append(box, sw, `${c.label}${unit ? ` (${unit})` : ''}`);
      grid.append(label);
    }
    picker.append(summary, grid);
    root.append(picker);

    const plot = document.createElement('div');
    plot.className = 'scope-plot';
    plot.append(this.canvas);
    root.append(plot);
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.dirty = true;
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.dirty = true;
    });

    const ghosts = row('Ghosts', 'Runs pinned to compare against');
    ghosts.append(
      button('Pin', 'Pin the visible window (following a run: that run) as a ghost', () => {
        if (this.pin() === null) this.h.notice('Nothing recorded to pin yet');
      }),
      button('Clear', 'Remove every ghost', () => this.clearPins()),
    );
    this.pinList.className = 'scope-pins';
    root.append(this.pinList);

    const tests = row('Tests', 'Scripted manoeuvres: deterministic, so two tunes can be compared exactly');
    for (const m of MANOEUVRES) {
      const b = button(m.name, m.title, () => void this.run(m.id));
      b.dataset.id = m.id;
      this.runBtns.push(b);
      tests.append(b);
    }
    const ctl = row('');
    const ground = button('Open ground', 'Start manoeuvres on the practice track’s open asphalt (otherwise where the car is: make sure there’s room)', () => {
      this.openGround = !this.openGround;
      this.persist();
      this.sync();
    });
    ground.dataset.act = 'ground';
    const abort = button('Abort', 'Stop the manoeuvre (Esc, or any input, does too)', () => this.abort());
    abort.dataset.act = 'abort';
    this.statusEl.className = 'scope-status';
    ctl.append(ground, abort, this.statusEl);
    this.metricsEl.className = 'scope-metrics';
    root.append(this.metricsEl);
  }

  /** Brings the buttons and canvas size in line with the state. */
  private sync(): void {
    for (const [v, b] of this.viewBtns) b.classList.toggle('on', v === this.view);
    for (const [s, b] of this.windowBtns) b.classList.toggle('on', this.follow === 'live' && s === this.windowSec);
    const run = this.followBtns.get('run')!;
    run.classList.toggle('on', this.follow === 'run');
    run.disabled = !this.anchor;
    for (const [name, b] of this.presetBtns) b.classList.toggle('on', sameSet(PRESETS[name].cols, this.cols));
    for (const [col, box] of this.chanBoxes) box.checked = this.cols.includes(col);
    for (const b of this.runBtns) b.classList.toggle('on', this.active?.m.id === b.dataset.id);
    this.abortBtn.disabled = !this.active;
    this.groundBtn.classList.toggle('on', this.openGround);
    this.cssH = this.view === 'handling' ? HANDLING_H : Math.max(1, this.lanes.length) * LANE_H + AXIS_H;
    this.canvas.style.height = `${this.cssH}px`;
    this.dirty = true;
  }

  private syncPins(): void {
    const list = this.pinList;
    list.textContent = '';
    for (const r of this.pinned) {
      const slot = slotOf(r);
      const el = document.createElement('div');
      el.className = 'scope-pin';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = r.on;
      box.title = 'Draw on the chart';
      box.addEventListener('change', () => {
        box.blur();
        this.showPin(r.id, box.checked);
      });
      const letter = document.createElement('b');
      letter.textContent = PIN_LETTERS[slot];
      letter.style.color = PIN_COLORS[slot];
      const what = document.createElement('span');
      const m = manoeuvre(r.manoeuvre);
      what.textContent = r.label;
      what.title = r.label;
      const meta = document.createElement('span');
      meta.className = 'scope-meta';
      meta.textContent = `${m ? m.name : `free ${Math.round(r.n * dt)} s`} · ${r.time}`;
      const x = button('×', 'Remove this ghost', () => this.unpin(r.id));
      x.classList.add('scope-x');
      el.append(box, dashSwatch(slot), letter, what, meta, x);
      list.append(el);
    }
    this.renderMetrics();
    this.dirty = true;
  }

  /** The last manoeuvre's metrics beside the ghosts of the same manoeuvre (newest first). */
  private renderMetrics(): void {
    const el = this.metricsEl;
    el.textContent = '';
    const id = this.anchor?.id ?? [...this.pinned].reverse().find((r) => r.metrics)?.manoeuvre ?? null;
    const runs = this.pinned.filter((r) => r.manoeuvre === id && r.metrics).reverse().slice(0, 3);
    if (!runs.length) return;
    const table = document.createElement('table');
    const head = table.insertRow();
    const title = document.createElement('th');
    title.textContent = manoeuvre(id)?.name ?? '';
    head.append(title);
    for (const r of runs) {
      const th = document.createElement('th');
      const slot = slotOf(r);
      th.innerHTML = `<b style="color:${PIN_COLORS[slot]}">${PIN_LETTERS[slot]}</b> ${escapeHtml(r.time)}`;
      th.title = r.label;
      head.append(th);
    }
    const labels: Metric[] = [];
    for (const r of runs) for (const m of r.metrics!) if (!labels.some((x) => x.label === m.label)) labels.push(m);
    for (const m of labels) {
      const tr = table.insertRow();
      const th = document.createElement('th');
      th.textContent = m.label;
      if (m.hint) th.title = m.hint;
      tr.append(th);
      for (const r of runs) {
        const v = r.metrics!.find((x) => x.label === m.label);
        tr.insertCell().textContent = v ? formatMetric(v) : '';
      }
    }
    el.append(table);
  }

  private buildLanes(): void {
    this.lanes = [];
    for (const id of LANE_ORDER) {
      const channels = CHANNELS.filter((c) => c.lane === id && this.cols.includes(c.col));
      if (channels.length) this.lanes.push({ id, def: LANES[id], channels, lo: LANES[id].lo, hi: LANES[id].hi, refs: [] });
    }
    this.refsAt = -Infinity;
  }

  private refreshRefs(): void {
    const car = this.h.physics.car;
    for (const l of this.lanes) {
      l.refs = l.def.refs?.(car) ?? [];
      if (l.def.range) [l.lo, l.hi] = l.def.range(car);
    }
  }

  private load(): void {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as Saved | null;
      if (!s) return;
      if (s.window && WINDOWS.includes(s.window)) this.windowSec = s.window;
      if (Array.isArray(s.cols)) {
        const cols = CHANNELS.filter((c) => s.cols!.includes(c.col)).map((c) => c.col);
        if (cols.length) this.cols = cols;
      }
      if (s.view === 'handling' || s.view === 'strip') this.view = s.view;
      if (typeof s.openGround === 'boolean' && new URLSearchParams(location.search).has('practice')) this.openGround = s.openGround;
    } catch {
      // Defaults.
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ window: this.windowSec, cols: this.cols, view: this.view, openGround: this.openGround } satisfies Saved));
    } catch {
      // Not persisted.
    }
  }

  // --- Drawing ----------------------------------------------------------------

  private draw(): void {
    const w = this.cssW;
    const hgt = this.cssH;
    if (w < 50) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(w * dpr);
    const ch = Math.round(hgt * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch || dpr !== this.dpr) {
      this.canvas.width = cw;
      this.canvas.height = ch;
      this.dpr = dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.font = FONT;
    ctx.textBaseline = 'alphabetic';
    if (this.view === 'handling') this.drawHandling(w, hgt);
    else this.drawStrip(w);
  }

  /** The time axis's ends (s): −window…0 following live, or around the run following one. */
  private timeRange(): [number, number] {
    const a = this.anchor;
    if (this.follow !== 'run' || !a) return [-this.windowSec, 0];
    const m = manoeuvre(a.id);
    let span = m?.span ?? 5;
    if (a.endStep >= 0) {
      span = (a.endStep - a.startStep) * dt;
      for (const r of this.pinned) if (r.on && r.manoeuvre === a.id) span = Math.max(span, (r.n - 1) * dt);
    }
    const pad = Math.max(0.1, span * 0.03);
    return [-pad, span + pad];
  }

  /** Puts the live trace and the shown ghosts on the time axis; returns how many ghost sources are in use. */
  private placeSources(): number {
    const rec = this.h.recorder;
    const live = this.live;
    const newest = this.newestStep();
    const a = this.anchor;
    live.run = null;
    live.n = rec.steps;
    live.k0 = 0;
    live.dk = -dt;
    live.t0 = 0;
    // Steps back to the anchor's start, if the recorder still has it.
    const startAgo = a ? newest - a.startStep : -1;
    const covered = a !== null && startAgo >= 0 && startAgo < rec.steps;
    const following = this.follow === 'run' && a !== null;
    if (following) {
      live.t0 = startAgo * dt;
      live.n = covered ? startAgo + 1 : 0;
      if (a.endStep >= 0) live.k0 = Math.max(0, newest - a.endStep);
    }
    let used = 0;
    for (const r of this.pinned) {
      if (!r.on) continue;
      const aligned = a !== null && r.manoeuvre === a.id;
      // Following a run only its own manoeuvre's ghosts mean anything.
      if (following && !aligned) continue;
      // The run's own pin is the live trace again, while the recorder still has it.
      const self = a !== null && r.id === a.pinId;
      if (self && covered) continue;
      const s = this.pinSrc[used++];
      s.run = r;
      s.n = r.n;
      s.k0 = 0;
      s.dk = dt;
      s.solid = self;
      if (following) s.t0 = 0;
      else if (aligned && covered) s.t0 = -startAgo * dt;
      else s.t0 = -(r.n - 1) * dt;
    }
    return used;
  }

  private drawStrip(w: number): void {
    const ctx = this.ctx;
    const [tMin, tMax] = this.timeRange();
    const used = this.placeSources();
    const x0 = 2;
    const pw = w - PAD_R - x0;
    const xs = pw / (tMax - tMin);
    const axisY = this.lanes.length * LANE_H;
    const hover = this.hover;
    const tCursor = hover && hover.x >= x0 && hover.x <= x0 + pw ? tMin + (hover.x - x0) / xs : NaN;

    // Time grid.
    const step = niceStep((tMax - tMin) / 6);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.ceil(tMin / step) * step; t <= tMax + 1e-9; t += step) {
      const x = Math.round(x0 + (t - tMin) * xs) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, axisY);
      // The end ticks' labels would hang off the canvas.
      ctx.textAlign = x < x0 + 20 ? 'left' : x > x0 + pw - 20 ? 'right' : 'center';
      ctx.fillText(`${Math.abs(t) < 1e-9 ? 0 : +t.toFixed(2)} s`, x, axisY + 11);
    }
    ctx.stroke();

    // The last manoeuvre's start, following live.
    const a = this.anchor;
    if (a && this.follow === 'live') {
      const t = -(this.newestStep() - a.startStep) * dt;
      if (t >= tMin) {
        const x = Math.round(x0 + (t - tMin) * xs) + 0.5;
        ctx.strokeStyle = 'rgba(255,209,102,0.5)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, axisY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    for (let li = 0; li < this.lanes.length; li++) this.drawLane(this.lanes[li], li * LANE_H, tMin, tMax, x0, pw, xs, used, tCursor);

    if (!this.lanes.length) {
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'left';
      ctx.fillText('No channels: pick a preset or some channels above', 8, 30);
    }

    if (Number.isFinite(tCursor)) {
      const x = Math.round(x0 + (tCursor - tMin) * xs) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, axisY);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'right';
      ctx.fillText(`${tCursor >= 0 ? '+' : ''}${tCursor.toFixed(2)} s`, w - 2, axisY + 11);
      if (used && hover) this.drawTooltip(hover, tCursor, used, w);
    } else if (this.live.n === 0 && !used) {
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'left';
      ctx.fillText('Nothing recorded yet', 8, axisY - 8);
    }
  }

  private drawLane(lane: Lane, top: number, tMin: number, tMax: number, x0: number, pw: number, xs: number, used: number, tCursor: number): void {
    const ctx = this.ctx;
    const def = lane.def;
    const yTop = top + LANE_HEAD + 2;
    const ph = LANE_H - LANE_HEAD - 6;

    // Range: the lane's least, grown to the data (live and ghosts).
    let lo = lane.lo;
    let hi = lane.hi;
    if (!def.fixed) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let si = -1; si < used; si++) {
        const src = si < 0 ? this.live : this.pinSrc[si];
        for (const ch of lane.channels) {
          const c = src.col(ch.col);
          if (c < 0) continue;
          if (!this.kRange(src, tMin, tMax)) continue;
          const k1 = this.kHi;
          const stride = Math.max(1, Math.floor((k1 - this.kLo) / 600));
          for (let k = this.kLo; k <= k1; k += stride) {
            const v = ch.tf(src.at(c, k));
            if (v < mn) mn = v;
            if (v > mx) mx = v;
            if (ch.mirror && -v < mn) mn = -v;
          }
        }
      }
      if (def.sym) {
        const m = niceCeil(Math.max(hi, Math.abs(mn), Math.abs(mx)));
        lo = -m;
        hi = m;
      } else {
        if (mn < lo) lo = -niceCeil(-mn);
        if (mx > hi) hi = niceCeil(mx);
      }
    }
    const ys = ph / (hi - lo || 1);

    // Frame, zero and reference lines, axis labels.
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(x0 + pw, top + 0.5);
    ctx.stroke();
    if (lo < 0 && hi > 0) {
      const y = Math.round(yTop + hi * ys) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + pw, y);
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    for (const r of lane.refs) {
      if (r.v < lo || r.v > hi) continue;
      const y = Math.round(yTop + (hi - r.v) * ys) + 0.5;
      ctx.strokeStyle = 'rgba(255,209,102,0.45)';
      ctx.setLineDash(r.dash ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + pw, y);
      ctx.stroke();
      if (r.label) {
        ctx.fillStyle = 'rgba(255,209,102,0.7)';
        ctx.textAlign = 'right';
        ctx.fillText(r.label, x0 + pw - 3, y - 2);
        ctx.textAlign = 'left';
      }
    }
    ctx.setLineDash([]);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'left';
    ctx.fillText(axisLabel(hi, def.unit), x0 + pw + 3, yTop + 7);
    ctx.fillText(axisLabel(lo, def.unit), x0 + pw + 3, yTop + ph);

    // Traces: ghosts dashed underneath, live on top.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, yTop - 1, pw, ph + 2);
    ctx.clip();
    ctx.lineJoin = 'round';
    for (let si = used - 1; si >= -1; si--) {
      const src = si < 0 ? this.live : this.pinSrc[si];
      const ghost = si >= 0 && !src.solid;
      ctx.lineWidth = ghost ? 1 : 1.4;
      ctx.globalAlpha = ghost ? 0.7 : 1;
      ctx.setLineDash(ghost ? PIN_DASH[slotOf(src.run!)] : []);
      for (const ch of lane.channels) {
        const c = src.col(ch.col);
        if (c < 0) continue;
        ctx.strokeStyle = ch.color;
        this.plot(src, c, ch, 1, tMin, tMax, x0, xs, hi, yTop, ys);
        if (ch.mirror) this.plot(src, c, ch, -1, tMin, tMax, x0, xs, hi, yTop, ys);
      }
    }
    ctx.restore();

    // Header: each channel's value at the cursor (or the newest).
    let x = x0 + 2;
    const src = this.live;
    const k = Number.isFinite(tCursor) ? src.near(tCursor) : src.n > src.k0 ? src.k0 : -1;
    for (const ch of lane.channels) {
      ctx.fillStyle = ch.color;
      const c = src.col(ch.col);
      const v = k >= 0 && c >= 0 ? ch.tf(src.at(c, k)) : NaN;
      const text = `${ch.label} ${Number.isFinite(v) ? v.toFixed(ch.digits) : '—'}${def.unit && def.unit !== '%' ? ' ' : ''}${def.unit}`;
      ctx.fillText(text, x, top + 11);
      x += ctx.measureText(text).width + 10;
    }
  }

  /** Puts the samples of `src` inside the time window in [kLo, kHi]; false if there are none. */
  private kRange(src: Source, tMin: number, tMax: number): boolean {
    if (!src.n || !src.dk) return false;
    const ka = (tMin - src.t0) / src.dk;
    const kb = (tMax - src.t0) / src.dk;
    this.kLo = Math.max(src.k0, Math.floor(Math.min(ka, kb)));
    this.kHi = Math.min(src.n - 1, Math.ceil(Math.max(ka, kb)));
    return this.kHi >= this.kLo;
  }

  /**
   * Strokes one channel of one source across the window, oldest first. Several
   * samples in one pixel column collapse to their min and max, so spikes
   * survive a 30 s window. Breaks at an epoch change (rebase, new world).
   */
  private plot(src: Source, c: number, ch: Channel, sign: number, tMin: number, tMax: number, x0: number, xs: number, hi: number, yTop: number, ys: number): void {
    if (!this.kRange(src, tMin, tMax)) return;
    const k0 = this.kLo;
    const k1 = this.kHi;
    const ctx = this.ctx;
    const ec = src.col('epoch');
    const fwd = src.dk > 0;
    let epoch = NaN;
    ctx.beginPath();
    this.bx = NaN;
    this.bOpen = false;
    for (let j = 0, count = k1 - k0 + 1; j < count; j++) {
      const k = fwd ? k0 + j : k1 - j;
      if (ec >= 0) {
        const e = src.at(ec, k);
        if (e !== epoch && j > 0) {
          this.flush(hi, yTop, ys);
          this.bx = NaN;
          this.bOpen = false;
        }
        epoch = e;
      }
      const v = sign * ch.tf(src.at(c, k));
      const px = Math.floor(x0 + (src.t0 + k * src.dk - tMin) * xs);
      if (px !== this.bx) {
        this.flush(hi, yTop, ys);
        this.bx = px;
        this.bFirst = this.bLast = this.bMin = this.bMax = v;
      } else {
        this.bLast = v;
        if (v < this.bMin) this.bMin = v;
        if (v > this.bMax) this.bMax = v;
      }
    }
    this.flush(hi, yTop, ys);
    ctx.stroke();
  }

  private flush(hi: number, yTop: number, ys: number): void {
    if (Number.isNaN(this.bx)) return;
    const ctx = this.ctx;
    const x = this.bx + 0.5;
    const y0 = yTop + hi * ys;
    if (!this.bOpen) ctx.moveTo(x, y0 - this.bFirst * ys);
    else ctx.lineTo(x, y0 - this.bFirst * ys);
    this.bOpen = true;
    if (this.bMin !== this.bMax) {
      ctx.lineTo(x, y0 - this.bMin * ys);
      ctx.lineTo(x, y0 - this.bMax * ys);
    }
    ctx.lineTo(x, y0 - this.bLast * ys);
    this.bx = NaN;
  }

  /** The ghosts' values at the cursor, for the lane under it. */
  private drawTooltip(hover: { x: number; y: number }, t: number, used: number, w: number): void {
    const li = Math.floor(hover.y / LANE_H);
    const lane = this.lanes[li];
    if (!lane) return;
    const ctx = this.ctx;
    const lineH = 12;
    const rows = used;
    let width = 0;
    const text = (src: Source, ch: Channel) => {
      const c = src.col(ch.col);
      const k = src.near(t);
      const v = k >= 0 && c >= 0 ? ch.tf(src.at(c, k)) : NaN;
      return Number.isFinite(v) ? v.toFixed(ch.digits) : '—';
    };
    for (let si = 0; si < used; si++) {
      let wRow = 14;
      for (const ch of lane.channels) wRow += ctx.measureText(text(this.pinSrc[si], ch)).width + 8;
      width = Math.max(width, wRow);
    }
    const bw = width + 8;
    const bh = rows * lineH + 6;
    let bx = hover.x + 12;
    if (bx + bw > w - 4) bx = hover.x - 12 - bw;
    const by = Math.min(li * LANE_H + LANE_HEAD, this.lanes.length * LANE_H - bh);
    ctx.fillStyle = 'rgba(10,12,16,0.88)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.textAlign = 'left';
    for (let si = 0; si < used; si++) {
      const src = this.pinSrc[si];
      const slot = slotOf(src.run!);
      let x = bx + 4;
      const y = by + 3 + (si + 1) * lineH - 2;
      ctx.fillStyle = PIN_COLORS[slot];
      ctx.fillText(PIN_LETTERS[slot], x, y);
      x += 14;
      for (const ch of lane.channels) {
        const s = text(src, ch);
        ctx.fillStyle = ch.color;
        ctx.fillText(s, x, y);
        x += ctx.measureText(s).width + 8;
      }
    }
  }

  /**
   * The handling diagram: road-wheel angle against lateral g. Ramp-steer
   * ghosts as curves with their linear fit and the neutral-steer line at their
   * speed; the live window as a faint scatter (left and right turns folded
   * together, so countersteer reads below the axis).
   */
  private drawHandling(w: number, hgt: number): void {
    const ctx = this.ctx;
    const L = 36;
    const B = 20;
    const T = 6;
    const R = 8;
    const pw = w - L - R;
    const ph = hgt - T - B;
    const car = this.h.physics.car;
    const ramps = this.pinned.filter((r) => r.on && r.manoeuvre === 'ramp-steer');

    // Ranges: what the ramps reached, at least 1 g and 0…5°.
    let gMax = 1;
    let dMin = 0;
    let dMax = 5;
    for (const r of ramps) {
      const { g, deg: a, from } = rampPoints(r);
      for (let i = from; i < r.n; i++) {
        gMax = Math.max(gMax, Math.abs(g[i]) / G);
        dMax = Math.max(dMax, a[i] * DEG);
        dMin = Math.min(dMin, a[i] * DEG);
      }
    }
    gMax = Math.min(2, niceCeil(gMax * 1.05));
    dMax = niceCeil(dMax * 1.05);
    dMin = dMin < -0.5 ? -niceCeil(-dMin * 1.05) : 0;
    const X = (gv: number) => L + (gv / gMax) * pw;
    const Y = (d: number) => T + ((dMax - d) / (dMax - dMin)) * ph;

    // Grid.
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = MUTED;
    ctx.beginPath();
    const gStep = niceStep(gMax / 5);
    ctx.textAlign = 'center';
    for (let v = 0; v <= gMax + 1e-9; v += gStep) {
      const x = Math.round(X(v)) + 0.5;
      ctx.moveTo(x, T);
      ctx.lineTo(x, T + ph);
      ctx.fillText(`${+v.toFixed(2)}`, x, T + ph + 12);
    }
    const dStep = niceStep((dMax - dMin) / 5);
    ctx.textAlign = 'right';
    for (let v = Math.ceil(dMin / dStep) * dStep; v <= dMax + 1e-9; v += dStep) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.moveTo(L, y);
      ctx.lineTo(L + pw, y);
      ctx.fillText(`${+v.toFixed(1)}°`, L - 4, y + 3);
    }
    ctx.stroke();
    ctx.save();
    ctx.translate(10, T + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('road-wheel angle', 0, 0);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T, pw, ph);
    ctx.clip();

    // Live window, folded to the first quadrant.
    const rec = this.h.recorder;
    const n = Math.min(rec.steps, Math.round(this.windowSec / dt));
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (let k = 0; k < n; k++) {
      if (rec.value(this.colSpeed, k) < 5) continue;
      const ay = rec.value(this.colLat, k) / G;
      const d = rec.value(this.colAngle, k) * DEG * (ay < 0 ? -1 : 1);
      ctx.fillRect(X(Math.abs(ay)) - 0.75, Y(d) - 0.75, 1.5, 1.5);
    }

    // Ramp-steer ghosts.
    let legendY = T + 12;
    for (const r of ramps) {
      const slot = slotOf(r);
      const color = PIN_COLORS[slot];
      const { g, deg: a, from } = rampPoints(r);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let i = from; i < r.n; i++) {
        const x = X(g[i] / G);
        const y = Y(a[i] * DEG);
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      const fit = understeerFit(r, car);
      if (fit) {
        ctx.setLineDash([5, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(X(0), Y(fit.intercept));
        ctx.lineTo(X(gMax), Y(fit.intercept + fit.slope * gMax));
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(X(0), Y(0));
        ctx.lineTo(X(gMax), Y(fit.neutral * gMax));
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      const K = fit ? `K ${fit.K >= 0 ? '+' : ''}${fit.K.toFixed(2)} °/g (${fit.K >= 0 ? 'understeer' : 'oversteer'})` : 'no linear range';
      ctx.fillText(`${PIN_LETTERS[slot]} ${K} · ${r.label}`, L + 6, legendY);
      legendY += 12;
    }
    ctx.setLineDash([]);
    ctx.restore();
    if (!ramps.length) {
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'left';
      ctx.fillText('Live window shown; run Ramp steer for the understeer gradient', L + 6, T + 12);
      ctx.textAlign = 'right';
      ctx.fillText('lateral g →', L + pw - 4, T + ph - 6);
    } else {
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'right';
      ctx.fillText('lateral g → · dashed: linear fit · dotted: neutral steer', L + pw - 4, T + ph - 6);
    }

    const hv = this.hover;
    if (hv && hv.x >= L && hv.x <= L + pw && hv.y >= T && hv.y <= T + ph) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.moveTo(Math.round(hv.x) + 0.5, T);
      ctx.lineTo(Math.round(hv.x) + 0.5, T + ph);
      ctx.moveTo(L, Math.round(hv.y) + 0.5);
      ctx.lineTo(L + pw, Math.round(hv.y) + 0.5);
      ctx.stroke();
      const gv = ((hv.x - L) / pw) * gMax;
      const dv = dMax - ((hv.y - T) / ph) * (dMax - dMin);
      ctx.fillStyle = '#fff';
      ctx.textAlign = hv.x > L + pw / 2 ? 'right' : 'left';
      ctx.fillText(`${gv.toFixed(2)} g · ${dv.toFixed(2)}°`, hv.x + (hv.x > L + pw / 2 ? -6 : 6), hv.y - 5);
    }
  }
}

// --- Helpers --------------------------------------------------------------------

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dbg-btn';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', () => {
    onClick();
    // Keep keyboard focus off the panel so Space/arrows keep driving.
    b.blur();
  });
  return b;
}

function sep(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'scope-sep';
  return s;
}

/** A short line in a ghost slot's dash, for the legend. */
function dashSwatch(slot: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '8');
  svg.classList.add('scope-dash');
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('x1', '0');
  line.setAttribute('y1', '4');
  line.setAttribute('x2', '22');
  line.setAttribute('y2', '4');
  line.setAttribute('stroke', PIN_COLORS[slot]);
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-dasharray', PIN_DASH[slot].join(' '));
  svg.append(line);
  return svg;
}

type Slotted = Run & { slot?: number };

function slotOf(r: Run): number {
  return (r as Slotted).slot ?? 0;
}

/** The lowest ghost slot (letter, dash, colour) the others aren't using. */
function setSlot(r: Run, others: readonly Run[]): void {
  const taken = new Set(others.filter((o) => o !== r).map((o) => (o as Slotted).slot));
  let s = 0;
  while (taken.has(s) && s < MAX_PINS - 1) s++;
  (r as Slotted).slot = s;
}

/** A pinned run from an older Scope, if it still looks like one. */
function isRun(r: unknown): r is Run {
  const o = r as Partial<Run> | null;
  return (
    !!o &&
    typeof o.id === 'number' &&
    typeof o.n === 'number' &&
    o.data instanceof Float32Array &&
    Array.isArray(o.columns) &&
    o.data.length >= o.n * o.columns.length &&
    typeof o.label === 'string'
  );
}

function flatMetrics(ms: readonly Metric[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of ms) out[m.unit ? `${m.label} (${m.unit})` : m.label] = typeof m.value === 'number' ? +m.value.toFixed(Math.max(m.digits, 3)) : m.value;
  return out;
}

function formatMetric(m: Metric): string {
  if (m.value === null) return '—';
  if (typeof m.value === 'string') return m.value;
  return `${m.value.toFixed(m.digits)}${m.unit ? (m.unit === '%' ? '%' : ` ${m.unit}`) : ''}`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** The 1-2-5 step at or above `v`. */
function niceStep(v: number): number {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * e >= v - 1e-12) return m * e;
  return 10 * e;
}

/** The 1-2-2.5-5 value at or above `v`, for axis ends. */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= v - 1e-12) return m * e;
  return 10 * e;
}

function axisLabel(v: number, unit: string): string {
  const a = Math.abs(v);
  const s = a >= 1000 ? `${+(v / 1000).toFixed(1)}k` : a >= 10 ? v.toFixed(0) : `${+v.toFixed(2)}`;
  return `${s}${unit === '%' || unit === '°' ? unit : ''}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
