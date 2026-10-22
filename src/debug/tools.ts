import { MathUtils, type Matrix4, type Scene, type WebGLRenderer } from 'three';
import { PHYSICS } from '../config';
import type { CarSpec } from '../car/cars';
import type { CarInput, CarPhysics, OverpassDecision } from '../car/physics';
import type { Collider } from '../world/collider';
import type { World } from '../world/types';
import { DebugOverlay, type OverlayLayers } from './overlay';
import { DebugPanel, type PanelTab } from './panel';
import { redact, TraceRecorder, type Trace, type TraceEvent } from './trace';
import { TuningEditor } from './tuning';

export interface DebugContext {
  physics: CarPhysics;
  renderer: WebGLRenderer;
  world(): World | null;
  collider(): Collider | null;
  phase(): string;
  /** The multi-line stats readout (only requested while the panel is open). */
  statsText(): string;
  /** The Tuning tab changed the car's numbers (see TuningHandlers.apply). */
  onTuned(spec: CarSpec, path: readonly string[] | null): void;
}

interface Saved {
  open: boolean;
  layers: OverlayLayers;
  tab?: PanelTab;
}

const STORAGE = 'drift.earth:debug';
const SAMPLE_EVERY = 0.5;
export const TIME_SCALES = [1, 0.25, 0.1, 0];

const DEFAULT_LAYERS: OverlayLayers = { wire: true, fill: 'off', photo: true, probes: true, history: true, overpass: true, tyres: true };

/**
 * Debug panel, collision overlay and the always-on trace recorder. Also the
 * scripting surface for automated runs: `window.__drift.debug`.
 */
export class DebugTools {
  readonly recorder = new TraceRecorder();
  readonly overlay = new DebugOverlay();
  private readonly panel: DebugPanel;
  /** The Tuning tab: the car's live numbers and presets. */
  readonly tuning: TuningEditor;
  open = false;
  tab: PanelTab = 'view';
  layers: OverlayLayers = { ...DEFAULT_LAYERS };
  timeScale = 1;
  private pendingSteps = 0;
  private sampleTimer = 0;
  private perf = { frames: 0, frameMs: 0, frameMax: 0, physMs: 0, renderMs: 0 };
  private lastLog: TraceEvent | null = null;
  private lastLogText = '';

  constructor(
    private readonly ctx: DebugContext,
    scene: Scene,
  ) {
    scene.add(this.overlay.root);
    this.panel = new DebugPanel({
      onLayers: (l) => this.set(l),
      onTimeScale: (s) => (this.timeScale = s),
      onStep: () => this.stepOnce(),
      onSave: () => void this.save(),
      onMark: () => this.mark(),
      onCopyLink: () => void this.copyLink(),
      onTab: (t) => this.setTab(t),
      onClose: () => this.toggle(false),
    });
    this.tuning = new TuningEditor(this.panel.tuningHost, {
      apply: (spec, path) => ctx.onTuned(spec, path),
      notice: (text) => this.panel.notice(text),
      event: (kind, data) => this.recorder.event(kind, data),
    });
    this.load();
    this.panel.setTab(this.tab);
    this.panel.sync(this.layers, this.timeScale);
    this.panel.show(this.open);
    this.captureConsole();
  }

  // --- Scripting surface ----------------------------------------------------

  /** Opens/closes the panel (and with it the overlay). */
  toggle(open = !this.open): void {
    this.open = open;
    // A frozen or slowed car with the panel closed looks like a hang.
    if (!open && this.timeScale !== 1) this.setTimeScale(1);
    this.panel.show(open);
    this.persist();
  }

  /** Changes overlay layers, e.g. `set({ wire: true, fill: 'slope' })`. */
  set(layers: Partial<OverlayLayers> & { open?: boolean }): void {
    const { open, ...rest } = layers;
    this.layers = { ...this.layers, ...rest };
    if (open !== undefined) this.open = open;
    this.panel.sync(this.layers, this.timeScale);
    this.panel.show(this.open);
    this.persist();
  }

  /**
   * Applies a `?debug=` URL value: a comma list of layers to turn on
   * (wire, height, slope, nophoto, probes, history, overpass), or empty for the
   * saved defaults.
   */
  applyParam(value: string): void {
    const on = new Set(value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    if (on.size) {
      this.layers = {
        wire: on.has('wire'),
        fill: on.has('slope') ? 'slope' : on.has('height') ? 'height' : 'off',
        photo: !on.has('nophoto'),
        probes: on.has('probes'),
        history: on.has('history'),
        overpass: on.has('overpass'),
        tyres: on.has('tyres'),
      };
    }
    this.open = true;
    this.panel.sync(this.layers, this.timeScale);
    this.panel.show(true);
  }

  /** Shows the View or Tuning tab. */
  setTab(tab: PanelTab): void {
    this.tab = tab;
    this.panel.setTab(tab);
    this.persist();
  }

  setTimeScale(s: number): void {
    this.timeScale = s;
    this.panel.sync(this.layers, s);
  }

  /** Advances one physics step while time is frozen. */
  stepOnce(n = 1): void {
    if (this.timeScale !== 0) this.setTimeScale(0);
    this.pendingSteps += n;
  }

  /** Up to `max` physics steps requested by `stepOnce`; the rest wait for later frames. */
  takeSteps(max: number): number {
    const n = Math.min(this.pendingSteps, max);
    this.pendingSteps -= n;
    return n;
  }

  /** Adds a labelled marker to the trace ("the wall was here"). */
  mark(label = 'mark'): void {
    const p = this.ctx.physics;
    this.recorder.event('mark', { label, pos: p.pos.toArray(), geo: this.ctx.world()?.geo(p.pos) ?? null });
    this.panel.notice(`Marked “${label}” at ${p.pos.x.toFixed(1)}, ${p.pos.z.toFixed(1)}`);
  }

  log(message: string, data: Record<string, unknown> = {}): void {
    this.recorder.event('log', { level: 'info', message: redact(message), ...data });
  }

  exportTrace(opts: { label?: string; seconds?: number } = {}): Trace {
    return this.recorder.export(this.meta(opts.label), opts.seconds);
  }

  /**
   * Saves the trace. In `pnpm dev` it goes to the dev server, which writes it
   * under `traces/`; otherwise the browser downloads it.
   */
  async save(label = ''): Promise<string> {
    const json = JSON.stringify(this.exportTrace({ label }));
    const name = traceName(label);
    if (import.meta.env.DEV) {
      try {
        const res = await fetch(`/__trace?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: json,
        });
        if (res.ok) {
          const { file } = (await res.json()) as { file: string };
          const copied = await copyText(file);
          this.panel.notice(`Trace saved → ${file}${copied ? ' (path copied)' : ''}`);
          return file;
        }
      } catch {
        // Fall through to a download.
      }
    }
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const copied = await copyText(`${name}.json`);
    this.panel.notice(`Trace downloaded: ${name}.json${copied ? ' (name copied)' : ''}`);
    return `${name}.json`;
  }

  /** Deep link that respawns the same car at its current spot, height and heading. */
  reproLink(): string {
    const p = this.ctx.physics;
    const world = this.ctx.world();
    const bearing = Math.round(MathUtils.euclideanModulo(-p.heading * MathUtils.RAD2DEG, 360));
    const geo = world?.geo(p.pos);
    const base = `${location.origin}${location.pathname}`;
    if (!geo) return `${base}?practice&car=${p.car.id}`;
    const q = new URLSearchParams({
      lat: geo.lat.toFixed(7),
      lon: geo.lon.toFixed(7),
      bearing: String(bearing),
      h: (geo.height - (p.pos.y - p.groundY)).toFixed(2),
      car: p.car.id,
    });
    return `${base}?${q}`;
  }

  // --- Game hooks -------------------------------------------------------------

  onStep(p: CarPhysics, inp: CarInput, colliders: number): void {
    this.recorder.step(p, inp, colliders);
    this.overlay.onStep(p);
  }

  onOverpass(d: OverpassDecision): void {
    this.recorder.event('overpass', { ...d });
    this.overlay.onOverpass(d);
  }

  event(kind: string, data?: Record<string, unknown>): void {
    this.recorder.event(kind, data);
  }

  onRebase(m: Matrix4, yaw: number): void {
    this.recorder.epoch++;
    const geo = this.ctx.world()?.geo(this.ctx.physics.pos) ?? null;
    this.recorder.event('rebase', { matrix: m.toArray(), yaw, epoch: this.recorder.epoch, geo });
    this.overlay.applyMatrix(m);
  }

  onWorld(world: World): void {
    this.overlay.clear();
    // A new world is a new coordinate frame, like a rebase.
    this.recorder.epoch++;
    this.recorder.event('world', { world: world.kind, epoch: this.recorder.epoch });
    this.pendingSteps = 0;
    this.setTimeScale(1);
  }

  /** Once per rendered frame, after the world update and before rendering. */
  frame(dt: number, time: number): void {
    this.recorder.now = time;
    const p = this.ctx.physics;
    p.debugRays = this.open && this.layers.probes;
    this.overlay.update(dt, this.ctx.world(), p, this.layers, this.open);
    if (this.open && this.tab === 'view') {
      const r = this.recorder;
      this.panel.setStats(
        `${this.ctx.statsText()}\ntrace ${r.steps} steps (${(r.steps * PHYSICS.dt).toFixed(0)} s)  events ${r.eventList().length}  epoch ${r.epoch}`,
      );
    }
  }

  /** Frame timings, for the 2 Hz `sample` events. */
  timing(frameMs: number, physMs: number, renderMs: number): void {
    const f = this.perf;
    f.frames++;
    f.frameMs += frameMs;
    f.frameMax = Math.max(f.frameMax, frameMs);
    f.physMs += physMs;
    f.renderMs += renderMs;
    this.sampleTimer += frameMs / 1000;
    if (this.sampleTimer < SAMPLE_EVERY) return;
    this.sampleTimer = 0;
    const n = f.frames;
    const info = this.ctx.renderer.info;
    const p = this.ctx.physics;
    const world = this.ctx.world();
    const c = this.ctx.collider();
    this.recorder.event('sample', {
      phase: this.ctx.phase(),
      fps: round((1000 * n) / f.frameMs),
      frameMs: round(f.frameMs / n),
      frameMaxMs: round(f.frameMax),
      physMs: round(f.physMs / n),
      renderMs: round(f.renderMs / n),
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      colliders: c?.candidateCount ?? 0,
      bvhBuilds: c?.bvhBuilds ?? 0,
      heapMB: heapMB(),
      tiles: world?.stats() ?? {},
      pos: p.pos.toArray().map(round),
      groundY: round(p.groundY),
      heading: round(p.heading),
      geo: world?.geo(p.pos) ?? null,
    });
    this.perf = { frames: 0, frameMs: 0, frameMax: 0, physMs: 0, renderMs: 0 };
  }

  // --- Internals --------------------------------------------------------------

  private meta(label?: string): Record<string, unknown> {
    const p = this.ctx.physics;
    const world = this.ctx.world();
    return {
      label: label || null,
      createdAt: new Date().toISOString(),
      url: redact(location.href),
      mode: import.meta.env.MODE,
      userAgent: navigator.userAgent,
      gpu: gpuName(this.ctx.renderer),
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      world: world?.kind ?? null,
      phase: this.ctx.phase(),
      car: {
        id: p.car.id,
        pos: p.pos.toArray(),
        heading: p.heading,
        speed: p.speed,
        groundY: p.groundY,
        geo: world?.geo(p.pos) ?? null,
      },
      repro: this.reproLink(),
      epoch: this.recorder.epoch,
      capacitySteps: this.recorder.capacity,
      physics: { ...PHYSICS },
      // The numbers the car was driving on (tuning included), and the preset they came from.
      carSpec: p.car,
      preset: this.tuning.describe(),
      layers: this.layers,
      timeScale: this.timeScale,
    };
  }

  private async copyLink(): Promise<void> {
    const link = this.reproLink();
    this.panel.notice((await copyText(link)) ? 'Repro link copied' : link);
  }

  private captureConsole(): void {
    const record = (level: string, args: unknown[]) => {
      const text = redact(args.map(describe).join(' ')).slice(0, 2000);
      // Collapse repeats (tile errors arrive in bursts), but only recent ones:
      // an old event may already have left the ring.
      const recent = this.lastLog && this.recorder.now - this.lastLog.t < 2;
      if (recent && text === this.lastLogText) {
        this.lastLog!.repeat = ((this.lastLog!.repeat as number) ?? 1) + 1;
        return;
      }
      this.lastLogText = text;
      this.lastLog = this.recorder.event('log', { level, message: text });
    };
    for (const level of ['warn', 'error'] as const) {
      const orig = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        record(level, args);
        orig(...args);
      };
    }
    window.addEventListener('error', (e) => record('uncaught', [e.error ?? e.message]));
    window.addEventListener('unhandledrejection', (e) => record('unhandled-rejection', [e.reason]));
  }

  private load(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as Saved | null;
      if (saved) {
        this.open = !!saved.open;
        this.layers = { ...DEFAULT_LAYERS, ...saved.layers };
        if (saved.tab === 'view' || saved.tab === 'tuning') this.tab = saved.tab;
      }
    } catch {
      // Defaults.
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ open: this.open, layers: this.layers, tab: this.tab } satisfies Saved));
    } catch {
      // Not persisted.
    }
  }
}

/** Clipboard write that never throws (it needs focus and, off localhost, HTTPS). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function describe(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack.split('\n').slice(1, 4).join('\n')}` : ''}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a)?.slice(0, 500) ?? String(a);
  } catch {
    return String(a);
  }
}

function traceName(label: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `drift-${stamp}${slug ? `-${slug}` : ''}`;
}

function gpuName(renderer: WebGLRenderer): string | null {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
}

function heapMB(): number | null {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return m ? round(m.usedJSHeapSize / 2 ** 20) : null;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
