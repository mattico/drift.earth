import { CAR_IDS, CARS, type CarId, type CarSpec, type DrivetrainSpec } from './car/cars';
import { powerHp, type ShiftMode } from './car/drivetrain';
import type { InputDevice } from './input';
import { parseCoordinates, SPOTS, type Spot } from './locations';
import { PlaceSearch } from './places';
import type { ScoreState } from './scoring';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const fmt = new Intl.NumberFormat('en-US');

const PAD_HINTS =
  '<b>RT/LT</b> gas · brake/reverse &nbsp; <b>L stick</b> steer &nbsp; <b>A</b> handbrake &nbsp; <b>LB/RB</b> shift (manual) &nbsp; <b>View</b> auto<br />' +
  '<b>R stick</b> look around (<b>R3</b> auto re-centre on/off) &nbsp; <b>D-pad ◀▶</b> camera angle &nbsp; <b>▲▼</b> zoom &nbsp; <b>Y</b> reset &nbsp; <b>Menu</b> pause';

/** m/s → mph, for everything the game displays. */
export const MPH = 2.236936;

/**
 * The car picker's spec line, e.g. "RWD · 395 hp · 7,250 rpm redline". Worked
 * out from the drivetrain, so it can't drift from the numbers the car drives on.
 */
function carSpecLine(car: CarSpec): string {
  const D = car.drivetrain;
  const lo = D.torque[0][0];
  const hi = D.torque[D.torque.length - 1][0];
  // Power peaks inside a segment of the torque curve, not only at its points.
  let hp = powerHp(D, hi);
  for (let rpm = lo; rpm < hi; rpm += 25) hp = Math.max(hp, powerHp(D, rpm));
  return `${car.drive.toUpperCase()} · ${Math.round(hp)} hp · ${fmt.format(D.redline)} rpm redline`;
}

export interface DriveDisplay {
  rpm: number;
  gear: number;
  mode: ShiftMode;
  limiting: boolean;
}

// Tach geometry: 0…max rpm (the limiter rounded up to the next 1000) over a
// 270° sweep, 0 at lower left.
const TACH_START = -135;
const TACH_SWEEP = 270;
const SVG_NS = 'http://www.w3.org/2000/svg';
const polar = (r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [100 + r * Math.sin(a), 100 - r * Math.cos(a)];
};

export class Hud {
  private readonly root = $('hud');
  private readonly total = $('score-total');
  private readonly best = $('score-best');
  private readonly combo = $('combo');
  private readonly comboPoints = $('combo-points');
  private readonly comboMult = $('combo-mult');
  private readonly comboAngle = $('combo-angle');
  private readonly speed = $('speed');
  private readonly status = $('status');
  private readonly toastEl = $('toast');
  private readonly attribution = $('attribution-text');
  private readonly logo = $('gmaps-logo');
  private readonly loading = $('loading');
  private readonly loadingTitle = $('loading-title');
  private readonly loadingFill = $('loading-fill');
  private readonly touch = $('touch');
  private readonly tach = $('tach');
  private readonly tachGear = $('tach-gear');
  private readonly gearbox = $('gearbox');
  private readonly gbMode = $('gb-mode');
  private readonly hints = $('hints');
  private readonly keyHints = this.hints.innerHTML;
  private device: InputDevice | null = null;
  private readonly gearEls = new Map<number, HTMLElement>();
  private needle!: SVGGElement;
  private lastAttribution = '';
  private lastStatus = '';
  private lastGear = NaN;
  private lastMode = '';
  private redline = 0;
  private tachMax = 1;

  /** Rebuilds the tach and gear selector for a car's engine and gearbox. */
  setDrivetrain(d: DrivetrainSpec): void {
    this.redline = d.redline;
    this.tachMax = Math.ceil((d.limiter + 1) / 1000) * 1000;
    this.buildTach();
    const gears = $('gb-gears');
    gears.replaceChildren();
    this.gearEls.clear();
    for (const g of [...d.gears.map((_, i) => d.gears.length - i), -1]) {
      const el = document.createElement('span');
      el.textContent = g < 0 ? 'R' : String(g);
      gears.append(el);
      this.gearEls.set(g, el);
    }
    this.lastGear = NaN;
  }

  private tachAngle(rpm: number): number {
    return TACH_START + (TACH_SWEEP * Math.min(rpm, this.tachMax + 200)) / this.tachMax;
  }

  /** Wires the gear selector's buttons (mode toggle, and ▼▲ on touch screens). */
  bindGearbox(request: (kind: 'up' | 'down' | 'mode') => void): void {
    const bind = (id: string, kind: 'up' | 'down' | 'mode') => {
      const el = $(id);
      el.addEventListener('click', () => {
        request(kind);
        // Keep focus off the button so Space stays the handbrake.
        el.blur();
      });
    };
    bind('gb-mode', 'mode');
    bind('gb-up', 'up');
    bind('gb-down', 'down');
  }

  setDrive(d: DriveDisplay): void {
    this.needle.setAttribute('transform', `rotate(${this.tachAngle(d.rpm).toFixed(1)} 100 100)`);
    this.tach.classList.toggle('shift', d.mode === 'manual' && d.rpm > this.redline - 500);
    this.tach.classList.toggle('limit', d.limiting);
    if (d.gear !== this.lastGear) {
      this.gearEls.get(this.lastGear)?.classList.remove('on');
      this.gearEls.get(d.gear)?.classList.add('on');
      this.tachGear.textContent = d.gear < 0 ? 'R' : String(d.gear);
      this.lastGear = d.gear;
    }
    if (d.mode !== this.lastMode) {
      this.gbMode.textContent = d.mode === 'auto' ? 'AUTO' : 'MANUAL';
      this.gearbox.classList.toggle('manual', d.mode === 'manual');
      this.lastMode = d.mode;
    }
  }

  private buildTach(): void {
    const svg = $('tach-dial') as unknown as SVGSVGElement;
    svg.replaceChildren();
    const tachAngle = (rpm: number) => this.tachAngle(rpm);
    const max = this.tachMax;
    const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
      const e = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      svg.append(e);
      return e;
    };
    const arc = (r: number, from: number, to: number) => {
      const [x0, y0] = polar(r, tachAngle(from));
      const [x1, y1] = polar(r, tachAngle(to));
      const large = tachAngle(to) - tachAngle(from) > 180 ? 1 : 0;
      return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    el('path', { d: arc(88, 0, max), class: 'tach-ring' });
    el('path', { d: arc(88, this.redline, max), class: 'tach-red' });
    for (let rpm = 0; rpm <= max; rpm += 500) {
      const major = rpm % 1000 === 0;
      const [x0, y0] = polar(major ? 74 : 79, tachAngle(rpm));
      const [x1, y1] = polar(84, tachAngle(rpm));
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: rpm >= this.redline ? 'tach-tick red' : 'tach-tick' });
      if (major) {
        const [tx, ty] = polar(60, tachAngle(rpm));
        el('text', { x: tx, y: ty + 4.5, class: 'tach-num' }).textContent = String(rpm / 1000);
      }
    }
    this.needle = el('g', { class: 'tach-needle' });
    const line = document.createElementNS(SVG_NS, 'line');
    for (const [k, v] of Object.entries({ x1: 100, y1: 112, x2: 100, y2: 20 })) line.setAttribute(k, String(v));
    const hub = document.createElementNS(SVG_NS, 'circle');
    for (const [k, v] of Object.entries({ cx: 100, cy: 100, r: 5 })) hub.setAttribute(k, String(v));
    this.needle.append(line, hub);
  }

  /** Shows the controls for the device in use. */
  setDevice(device: InputDevice): void {
    if (device === this.device) return;
    this.device = device;
    this.hints.innerHTML = device === 'gamepad' ? PAD_HINTS : this.keyHints;
    document.body.classList.toggle('gamepad', device === 'gamepad');
  }

  show(visible: boolean): void {
    this.root.hidden = !visible;
    this.touch.hidden = !visible || !matchMedia('(pointer: coarse)').matches;
  }

  setGoogleBranding(on: boolean): void {
    this.logo.hidden = !on;
  }

  /** `speed` in m/s. */
  update(speed: number, score: ScoreState): void {
    this.speed.textContent = String(Math.round(speed * MPH));
    this.total.textContent = fmt.format(score.total);
    this.best.textContent = fmt.format(score.best);
    this.combo.hidden = !score.drifting;
    if (score.drifting) {
      this.comboPoints.textContent = `+${fmt.format(score.combo)}`;
      this.comboMult.textContent = `×${score.multiplier}`;
      this.comboAngle.textContent = `${Math.round(score.angleDeg)}°`;
    }
  }

  setStatus(text: string): void {
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.status.hidden = !text;
    this.status.textContent = text;
  }

  setAttribution(text: string): void {
    if (text === this.lastAttribution) return;
    this.lastAttribution = text;
    this.attribution.textContent = text;
    this.attribution.title = text;
  }

  toast(text: string, kind: 'good' | 'bad'): void {
    const el = this.toastEl;
    el.hidden = false;
    el.className = `toast ${kind}`;
    el.textContent = text;
    // Restart the CSS animation.
    void el.offsetWidth;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }

  showLoading(title: string | null, progress = 0): void {
    this.loading.hidden = title === null;
    if (title !== null) {
      this.loadingTitle.textContent = title;
      this.loadingFill.style.width = `${Math.round(progress * 100)}%`;
    }
  }
}

export interface MenuHandlers {
  onPlace(lat: number, lon: number, bearing: number, name: string, top?: boolean, height?: number): void;
  onPractice(): void;
  onResume(): void;
  onRespawn(): void;
  onKey(key: string): void;
  onDebug(): void;
  onCar(id: CarId): void;
  /** The sound button: headphones (3D) or speakers. */
  onHeadphones(on: boolean): void;
}

export class Menu {
  private readonly h: MenuHandlers;
  private readonly root = $('menu');
  private readonly search = $<HTMLInputElement>('search');
  private readonly suggestions = $('suggestions');
  private readonly list = $<HTMLUListElement>('suggestion-list');
  private readonly searchError = $('search-error');
  private readonly error = $('menu-error');
  private readonly keyRow = $('key-row');
  private readonly keyInput = $<HTMLInputElement>('api-key');
  private readonly resumeRow = $('resume-row');
  private readonly audioOut = $('audio-out');
  private readonly carButtons = new Map<CarId, HTMLButtonElement>();
  private device: InputDevice | null = null;
  private places: PlaceSearch | null = null;
  private pending: AbortController | null = null;
  private debounce = 0;
  /** Bumped on every navigation or new query; stale async results compare against it. */
  private token = 0;

  constructor(handlers: MenuHandlers) {
    // Any navigation invalidates in-flight searches, so a late result can't teleport you.
    const bump = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
      this.token++;
      fn(...a);
    };
    const h: MenuHandlers = {
      onPlace: bump(handlers.onPlace),
      onPractice: bump(handlers.onPractice),
      onResume: bump(handlers.onResume),
      onRespawn: bump(handlers.onRespawn),
      onKey: handlers.onKey,
      onDebug: handlers.onDebug,
      onCar: handlers.onCar,
      onHeadphones: handlers.onHeadphones,
    };
    this.h = h;
    const cars = $('cars');
    for (const id of CAR_IDS) cars.append(this.carButton(CARS[id]));
    const spots = $('spots');
    for (const s of SPOTS) spots.append(this.spotButton(s));
    $('practice').addEventListener('click', () => h.onPractice());
    $('resume').addEventListener('click', () => h.onResume());
    $('respawn').addEventListener('click', () => h.onRespawn());
    $('debug-tools').addEventListener('click', () => h.onDebug());
    this.audioOut.addEventListener('click', () => h.onHeadphones(this.audioOut.getAttribute('aria-pressed') !== 'true'));
    $('save-key').addEventListener('click', () => {
      const key = this.keyInput.value.trim();
      if (key) h.onKey(key);
    });
    this.search.addEventListener('input', () => this.onSearchInput());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const coords = parseCoordinates(this.search.value);
        if (coords) h.onPlace(coords.lat, coords.lon, 0, `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`);
        else if (!this.suggestions.hidden) this.list.querySelector('li')?.dispatchEvent(new MouseEvent('click'));
      }
    });
  }

  setApiKey(key: string | null): void {
    this.places = key ? new PlaceSearch(key) : null;
    this.keyRow.hidden = !!key;
    this.search.placeholder = key
      ? 'Search a place, or paste “lat, lng” / a Google Maps link'
      : 'Paste “lat, lng” or a Google Maps link';
  }

  /** Marks the car the game is using in the picker. */
  setCar(id: CarId): void {
    for (const [car, b] of this.carButtons) b.setAttribute('aria-pressed', String(car === id));
  }

  /** Shows whether sound is set up for headphones (3D) or speakers. */
  setHeadphones(on: boolean): void {
    this.audioOut.setAttribute('aria-pressed', String(on));
    this.audioOut.textContent = on ? 'Sound: headphones (3D)' : 'Sound: speakers';
  }

  show(paused: boolean): void {
    this.root.hidden = false;
    this.resumeRow.hidden = !paused;
    this.root.classList.toggle('paused', paused);
    if (this.device === 'gamepad') this.focusDefault();
  }

  /** Gamepad users get a focused control to start from. */
  setDevice(device: InputDevice): void {
    if (device === this.device) return;
    this.device = device;
    if (device === 'gamepad' && this.visible && !this.root.contains(document.activeElement)) this.focusDefault();
  }

  /** Gamepad focus move: to the nearest visible control in that direction. */
  navigate(dir: { x: number; y: number }): void {
    const current = document.activeElement as HTMLElement | null;
    if (!current || !this.root.contains(current)) {
      this.focusDefault();
      return;
    }
    const from = current.getBoundingClientRect();
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of this.focusables()) {
      if (el === current) continue;
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - fx;
      const dy = r.top + r.height / 2 - fy;
      const along = dir.x ? dx * dir.x : dy * dir.y;
      const across = Math.abs(dir.x ? dy : dx);
      if (along <= 1) continue;
      // Only what lies wholly beyond the current control's edge: right of a half-width
      // card is the card beside it, not the full-width search box below.
      const ahead =
        dir.x > 0 ? r.left - from.right : dir.x < 0 ? from.left - r.right : dir.y > 0 ? r.top - from.bottom : from.top - r.bottom;
      if (ahead < -4) continue;
      // Off-axis distance counts mostly as the gap between the edges (0 when they
      // overlap), so a wide card straight below Resume beats a narrow spot further
      // down whose centre happens to line up; centres only break near-ties.
      const gap = dir.x
        ? Math.max(0, r.top - from.bottom, from.top - r.bottom)
        : Math.max(0, r.left - from.right, from.left - r.right);
      const score = along + 2 * gap + 0.5 * across;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) this.focus(best);
  }

  /** Gamepad A: activates the focused control. */
  select(): void {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !this.root.contains(el)) this.focusDefault();
    else if (el.tagName !== 'INPUT') el.click();
  }

  /** Gamepad B: closes the suggestion list; false if there was nothing to close. */
  back(): boolean {
    if (this.suggestions.hidden) return false;
    this.suggestions.hidden = true;
    this.focus(this.search);
    return true;
  }

  private focusables(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>('button, input, .suggestions li')].filter((el) => el.getClientRects().length > 0);
  }

  private focusDefault(): void {
    const target = this.resumeRow.hidden ? this.root.querySelector<HTMLElement>('.spot') : $('resume');
    if (target) this.focus(target);
  }

  private focus(el: HTMLElement): void {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }

  hide(): void {
    this.root.hidden = true;
    this.suggestions.hidden = true;
    // Don't leave a hidden button focused: Space (the handbrake) would press it.
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  showError(msg: string | null): void {
    this.error.hidden = !msg;
    this.error.textContent = msg ?? '';
  }

  private spotButton(s: Spot): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'spot';
    b.innerHTML = `<b></b><span></span>`;
    b.querySelector('b')!.textContent = s.name;
    b.querySelector('span')!.textContent = s.subtitle;
    b.addEventListener('click', () => this.h.onPlace(s.lat, s.lon, s.bearing, s.name, s.top, s.height));
    return b;
  }

  private carButton(car: CarSpec): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'car';
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<b></b><span class="car-spec"></span><span class="car-blurb"></span>`;
    b.querySelector('b')!.textContent = car.name;
    b.querySelector('.car-spec')!.textContent = carSpecLine(car);
    b.querySelector('.car-blurb')!.textContent = car.blurb;
    b.addEventListener('click', () => this.h.onCar(car.id));
    this.carButtons.set(car.id, b);
    return b;
  }

  private onSearchInput(): void {
    const q = this.search.value.trim();
    this.searchError.hidden = true;
    clearTimeout(this.debounce);
    // Old suggestions no longer match the text; Enter must not pick them.
    this.pending?.abort();
    this.token++;
    this.list.replaceChildren();
    this.suggestions.hidden = true;
    if (!q || parseCoordinates(q) || !this.places) return;
    this.debounce = window.setTimeout(() => void this.runSearch(q), 220);
  }

  private async runSearch(q: string): Promise<void> {
    const places = this.places;
    if (!places) return;
    const ctrl = new AbortController();
    this.pending = ctrl;
    const token = this.token;
    try {
      const results = await places.suggest(q, ctrl.signal);
      if (ctrl.signal.aborted || token !== this.token) return;
      this.list.replaceChildren(
        ...results.slice(0, 6).map((r) => {
          const li = document.createElement('li');
          li.textContent = r.text;
          // Focusable for gamepad navigation.
          li.tabIndex = -1;
          li.addEventListener('click', async () => {
            this.suggestions.hidden = true;
            const pick = ++this.token;
            try {
              const p = await places.locate(r.placeId);
              if (pick === this.token) this.h.onPlace(p.lat, p.lon, 0, r.name);
            } catch (err) {
              if (pick === this.token) this.showSearchError(err);
            }
          });
          return li;
        }),
      );
      this.suggestions.hidden = results.length === 0;
    } catch (err) {
      if ((err as Error).name !== 'AbortError') this.showSearchError(err);
    }
  }

  private showSearchError(err: unknown): void {
    this.searchError.hidden = false;
    this.searchError.textContent = (err as Error).message ?? String(err);
  }
}
