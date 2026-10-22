import { HEIGHT_BANDS, RAY_COLORS, ROAD_COLORS, ROAD_VERDICT_COLORS, SURFACE_COLORS, type FillMode, type OverlayLayers } from './overlay';

export interface PanelHandlers {
  onLayers(l: Partial<OverlayLayers>): void;
  onTimeScale(s: number): void;
  onStep(): void;
  onSave(): void;
  onMark(): void;
  onCopyLink(): void;
  onTab(tab: PanelTab): void;
  onClose(): void;
}

/** The overlay and trace controls, the car's tuning (debug/tuning.ts), or telemetry (debug/scope.ts). */
export type PanelTab = 'view' | 'tuning' | 'scope';
export const PANEL_TABS: readonly PanelTab[] = ['view', 'tuning', 'scope'];
const TABS: Array<[PanelTab, string, string]> = [
  ['view', 'View', 'Overlay, time and trace controls'],
  ['tuning', 'Tuning', 'The car’s chassis and drivetrain numbers, and presets'],
  ['scope', 'Scope', 'Telemetry graphs, ghost runs to compare against, and scripted manoeuvres'],
];

const FILLS: FillMode[] = ['off', 'height', 'slope'];
const SCALES: Array<[number, string]> = [
  [1, '1×'],
  [0.25, '¼×'],
  [0.1, '⅒×'],
  [0, '❚❚'],
];

const css = (rgb: [number, number, number]) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(' ')})`;
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** The F3 panel. Plain DOM; all state lives in DebugTools. */
export class DebugPanel {
  private readonly root = document.createElement('div');
  private readonly stats = document.createElement('pre');
  private readonly noticeEl = document.createElement('div');
  private readonly toggles = new Map<keyof OverlayLayers, HTMLButtonElement>();
  private readonly scaleButtons: HTMLButtonElement[] = [];
  private readonly tabButtons = new Map<PanelTab, HTMLButtonElement>();
  /** Where the Tuning tab's editor builds itself. */
  readonly tuningHost = document.createElement('div');
  /** Where the Scope tab builds itself. */
  readonly scopeHost = document.createElement('div');
  private fill = document.createElement('button');
  private layers: OverlayLayers | null = null;
  private noticeTimer = 0;

  constructor(private readonly h: PanelHandlers) {
    const root = this.root;
    root.className = 'panel debug-panel';
    root.hidden = true;
    root.innerHTML = `
      <div class="dbg-head"><b>Debug</b><span class="dbg-tabs"></span><span>F3 · F8 mark · F9 save trace</span><button class="dbg-close" type="button" aria-label="Close">×</button></div>
      <div class="dbg-page" data-page="view">
        <div class="dbg-row" data-row="view"><span class="dbg-label">View</span></div>
        <div class="dbg-row" data-row="time"><span class="dbg-label">Time</span></div>
        <div class="dbg-row" data-row="trace"><span class="dbg-label">Trace</span></div>
        <details class="dbg-legend"><summary>Legend</summary><div class="dbg-legend-body"></div></details>
      </div>
      <div class="dbg-page" data-page="tuning"></div>
      <div class="dbg-page" data-page="scope"></div>`;
    const tabs = root.querySelector('.dbg-tabs')!;
    for (const [tab, label, title] of TABS) {
      const b = this.button(label, title, () => this.h.onTab(tab));
      b.classList.add('dbg-tab');
      this.tabButtons.set(tab, b);
      tabs.append(b);
    }
    root.querySelector('[data-page="tuning"]')!.append(this.tuningHost);
    root.querySelector('[data-page="scope"]')!.append(this.scopeHost);
    const row = (name: string) => root.querySelector<HTMLElement>(`[data-row="${name}"]`)!;

    const view = row('view');
    const toggle = (key: keyof OverlayLayers, label: string, title: string) => {
      const b = this.button(label, title, () => this.h.onLayers({ [key]: !this.layers?.[key] }));
      b.classList.add('dbg-toggle');
      this.toggles.set(key, b);
      view.append(b);
    };
    toggle('wire', 'Wireframe', 'Collision meshes as wireframe, coloured by height relative to the car');
    this.fill = this.button('Fill', 'Cycle the surface fill: off → height (1 m contours) → slope class', () => {
      const cur = this.layers?.fill ?? 'off';
      this.h.onLayers({ fill: FILLS[(FILLS.indexOf(cur) + 1) % FILLS.length] });
    });
    this.fill.classList.add('dbg-toggle');
    view.append(this.fill);
    toggle('photo', 'Photo', 'Draw the photorealistic textures');
    toggle('probes', 'Probes', 'Ground probes, wall rays and the car footprint');
    toggle('history', 'Contacts', 'Recent wall hits (red) and edge stops (orange ledge, blue drop)');
    toggle('overpass', 'Classifier', 'Recent overpass and car-blob test samples at wall hits');
    toggle(
      'tires',
      'Tires',
      'Axle forces (green grip, orange sliding), front wheel heading and velocity; slip wedges at each axle against the tire’s peak; axle load bars against static (weight transfer); the path arc and turn centre; the drift angle',
    );
    toggle(
      'trail',
      'Trail',
      'The car’s last 18 s of driving, coloured by the first that applied: airborne, stability control, ABS, traction control, sliding (both, rear, front), drifting, grip',
    );
    toggle('gauges', 'Gauges', 'Live gauges over the game view: friction circles, g-g, inputs, aids, drivetrain (stay up with the panel closed)');
    toggle('roads', 'Roads', 'OpenStreetMap road centrelines and the last road teleport’s tries');
    toggle('surfaces', 'Surfaces', 'What the tires read the ground as: the OpenStreetMap surface map on real tiles, the patches on the practice track');

    const time = row('time');
    for (const [s, label] of SCALES) {
      const b = this.button(label, s === 0 ? 'Freeze physics' : `Physics at ${label}`, () => this.h.onTimeScale(s));
      b.dataset.scale = String(s);
      this.scaleButtons.push(b);
      time.append(b);
    }
    time.append(this.button('Step', 'Advance one physics step (1/120 s)', () => this.h.onStep()));

    const trace = row('trace');
    trace.append(
      this.button('Save', 'Save the last 60 s of physics and events (F9)', () => this.h.onSave()),
      this.button('Mark', 'Drop a marker into the trace (F8)', () => this.h.onMark()),
      this.button('Copy link', 'Copy a deep link that respawns here', () => this.h.onCopyLink()),
    );

    root.querySelector('.dbg-close')!.addEventListener('click', () => this.h.onClose());
    root.querySelector('.dbg-legend-body')!.innerHTML = legend();
    this.stats.className = 'dbg-stats';
    root.querySelector('[data-page="view"]')!.append(this.stats);

    this.noticeEl.className = 'debug-notice';
    this.noticeEl.hidden = true;
    document.body.append(root, this.noticeEl);
  }

  show(open: boolean): void {
    this.root.hidden = !open;
  }

  setTab(tab: PanelTab): void {
    for (const [t, b] of this.tabButtons) b.classList.toggle('on', t === tab);
    // The tuning form wants a little more room for its sliders and number boxes.
    this.root.classList.toggle('dbg-wide', tab === 'tuning' || tab === 'scope');
    for (const page of this.root.querySelectorAll<HTMLElement>('.dbg-page')) page.hidden = page.dataset.page !== tab;
  }

  sync(layers: OverlayLayers, timeScale: number): void {
    this.layers = layers;
    for (const [key, b] of this.toggles) b.classList.toggle('on', !!layers[key]);
    this.fill.textContent = `Fill: ${layers.fill}`;
    this.fill.classList.toggle('on', layers.fill !== 'off');
    for (const b of this.scaleButtons) b.classList.toggle('on', Number(b.dataset.scale) === timeScale);
  }

  setStats(text: string): void {
    this.stats.textContent = text;
  }

  /** Short message near the bottom of the screen, shown even with the panel closed. */
  notice(text: string): void {
    this.noticeEl.textContent = text;
    this.noticeEl.hidden = false;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => (this.noticeEl.hidden = true), 4000);
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
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
}

function legend(): string {
  const swatch = (color: string, label: string) => `<span class="dbg-sw"><i style="background:${color}"></i>${label}</span>`;
  const heights = HEIGHT_BANDS.map((b) => swatch(css(b.color), b.label)).join('');
  const slope = [swatch('rgb(64 230 89)', 'ground'), swatch('rgb(255 217 51)', 'too steep to drive'), swatch('rgb(255 77 51)', 'wall')].join('');
  const probes = [
    swatch('#40ff60', 'ground'),
    swatch('#ff3030', 'blocked (ledge)'),
    swatch('#909090', 'miss'),
    swatch('#3070ff', 'drop'),
  ].join('');
  const rays = (Object.entries(RAY_COLORS) as Array<[string, number]>).map(([k, v]) => swatch(hex(v), k)).join('');
  const overpass = [
    swatch('#ff50ff', 'passed as overpass'),
    swatch('#50ffd0', 'passed as car blob'),
    swatch('#ff3030', 'judged a wall'),
    swatch('#ffd040', 'skirt / along sample'),
    swatch('#40e0ff', 'far-side / across sample'),
    swatch('#ffffff', 'deck start'),
  ].join('');
  const tires = [
    swatch('#40ff60', 'force, gripping'),
    swatch('#ffa020', 'force, sliding'),
    swatch('#40e0ff', 'front wheel heading'),
    swatch('#ffffff', 'velocity'),
    swatch('#9fb0ff', 'path arc (R = v / yaw rate) and turn centre'),
  ].join('');
  const slip = [swatch('#40ff60', 'under 70% of peak'), swatch('#ffc030', '70–100% of peak'), swatch('#ff3030', 'past the peak')].join('');
  const load = [swatch('#ffb060', 'above static'), swatch('#60a0ff', 'below static'), swatch('#ffffff', 'static load')].join('');
  const drift = [
    swatch('#ffffff', 'under 12°'),
    swatch('#b080ff', '12–35°'),
    swatch('#ff80c0', '35–60°'),
    swatch('#ff3030', 'over 60°'),
  ].join('');
  // In priority order, as TRAIL_STATES in overlay.ts.
  const trail = [
    swatch('#909090', 'airborne'),
    swatch('#ff40ff', 'stability control'),
    swatch('#3070ff', 'ABS'),
    swatch('#40e0ff', 'traction control'),
    swatch('#ff3030', 'both axles sliding'),
    swatch('#ffa020', 'rear sliding'),
    swatch('#ffe040', 'front sliding'),
    swatch('#b080ff', 'drifting, tires gripping'),
    swatch('#40ff60', 'grip'),
  ].join('');
  const roads = (Object.entries(ROAD_COLORS) as Array<[string, number]>).map(([k, v]) => swatch(hex(v), k)).join('');
  const surfaces = (Object.entries(SURFACE_COLORS) as Array<[string, number]>).map(([k, v]) => swatch(hex(v), k)).join('');
  const tries = (Object.entries(ROAD_VERDICT_COLORS) as Array<[string, number]>).map(([k, v]) => swatch(hex(v), k)).join('');
  return [
    `<div><b>Height above the car's ground</b>${heights}</div>`,
    `<div><b>Slope fill</b>${slope}</div>`,
    `<div><b>Ground probes</b>${probes}</div>`,
    `<div><b>Wall rays</b>${rays}</div>`,
    `<div><b>Overpass test</b>${overpass}</div>`,
    `<div><b>Tires</b>${tires}</div>`,
    `<div><b>Slip wedges (wheel heading to patch travel)</b>${slip}</div>`,
    `<div><b>Load bars (white tick = static)</b>${load}</div>`,
    `<div><b>Drift angle (heading to velocity, 10° ticks)</b>${drift}</div>`,
    `<div><b>Trail (first that applied)</b>${trail}</div>`,
    `<div><b>Roads (OSM)</b>${roads}</div>`,
    `<div><b>Road teleport tries</b>${tries}</div>`,
    `<div><b>Surfaces</b>${surfaces}</div>`,
  ].join('');
}
