import { parseCoordinates, SPOTS, type Spot } from './locations';
import { PlaceSearch } from './places';
import type { ScoreState } from './scoring';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const fmt = new Intl.NumberFormat('en-US');

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
  private lastAttribution = '';
  private lastStatus = '';

  show(visible: boolean): void {
    this.root.hidden = !visible;
    this.touch.hidden = !visible || !matchMedia('(pointer: coarse)').matches;
  }

  setGoogleBranding(on: boolean): void {
    this.logo.hidden = !on;
  }

  update(kmh: number, score: ScoreState): void {
    this.speed.textContent = String(Math.round(kmh));
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
  onPlace(lat: number, lon: number, bearing: number, name: string, top?: boolean): void;
  onPractice(): void;
  onResume(): void;
  onRespawn(): void;
  onKey(key: string): void;
  onDebug(): void;
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
    };
    this.h = h;
    const spots = $('spots');
    for (const s of SPOTS) spots.append(this.spotButton(s));
    $('practice').addEventListener('click', () => h.onPractice());
    $('resume').addEventListener('click', () => h.onResume());
    $('respawn').addEventListener('click', () => h.onRespawn());
    $('debug-tools').addEventListener('click', () => h.onDebug());
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

  show(paused: boolean): void {
    this.root.hidden = false;
    this.resumeRow.hidden = !paused;
  }

  hide(): void {
    this.root.hidden = true;
    this.suggestions.hidden = true;
    this.search.blur();
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
    b.addEventListener('click', () => this.h.onPlace(s.lat, s.lon, s.bearing, s.name, s.top));
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
