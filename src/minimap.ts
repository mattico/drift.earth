import { copyright, dropSession, mapSession, metresPerPixel, project, TILE, tileUrl, type MapSession } from './world/mapTiles';

/**
 * Heading-up road map in the corner, from the Map Tiles API's 2D roadmap
 * tiles. Tiles are drawn on a canvas around the car; ones still loading fall
 * back to a coarser tile already in memory.
 */

const MAX_TILES = 300;
const MAX_IN_FLIGHT = 8;
/** Metres from the car to the edge of the map: more at speed. */
const VIEW_MIN = 110;
const VIEW_MAX = 420;
const VIEW_PER_MS = 4;
/** Copyright lookups: at most this often (ms), and only when the view moved to new tiles; sooner after a failure. */
const COPYRIGHT_EVERY = 15000;
const COPYRIGHT_RETRY = 3000;
/** A failed tile is asked for again after this long (ms). */
const TILE_RETRY = 5000;
/** This many tile failures in a row with none loading: the session has likely expired. */
const SESSION_FAILURES = 8;

interface TileImage {
  img: HTMLImageElement;
  state: 'loading' | 'ready' | 'failed';
  failedAt: number;
}

export class Minimap {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly copyEl: HTMLElement;
  private key: string | null = null;
  private session: MapSession | null = null;
  private failed = false;
  private readonly tiles = new Map<string, TileImage>();
  private inFlight = 0;
  private viewM = VIEW_MIN;
  private zoom = 17;
  private copyrightAt = -Infinity;
  private copyrightView = '';
  private copyrightBusy = false;
  private failStreak = 0;

  constructor() {
    this.root = document.getElementById('minimap')!;
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.copyEl = this.root.querySelector('.minimap-copy')!;
  }

  /**
   * Starts the map for a new run with this key, or hides it (`null`: no
   * real-world position, e.g. practice).
   */
  setKey(key: string | null): void {
    this.root.hidden = !key;
    // A new place: its copyright, and the view zoomed in again.
    this.copyrightView = '';
    this.copyrightAt = -Infinity;
    this.copyEl.textContent = '';
    this.viewM = VIEW_MIN;
    // Same key and a working session: keep the session and the tiles.
    if (key === this.key && !this.failed) return;
    this.key = key;
    this.session = null;
    this.failed = false;
    this.failStreak = 0;
    this.tiles.clear();
    if (!key) return;
    mapSession(key).then(
      (s) => {
        if (this.key === key) this.session = s;
      },
      (err) => {
        // Without a session there's nothing to draw; the game is fine without the map.
        if (this.key !== key) return;
        this.failed = true;
        this.root.hidden = true;
        console.warn('Minimap unavailable:', (err as Error).message);
      },
    );
  }

  /**
   * Draws the map around `lat`/`lon`. `viewBearing` (radians clockwise from
   * north) points up; the car arrow points along `carBearing`; `speed` in m/s
   * zooms out.
   */
  update(dt: number, lat: number, lon: number, viewBearing: number, carBearing: number, speed: number): void {
    if (!this.key || this.failed || this.root.hidden) return;
    const css = this.canvas.clientWidth;
    if (!css) return;
    const dpr = Math.min(devicePixelRatio, 2);
    const px = Math.round(css * dpr);
    if (this.canvas.width !== px) this.canvas.width = this.canvas.height = px;

    const target = Math.min(VIEW_MAX, VIEW_MIN + speed * VIEW_PER_MS);
    this.viewM += (target - this.viewM) * (1 - Math.exp(-dt * 1.5));
    // Metres per CSS pixel on screen, and the zoom whose tiles are at least that sharp.
    const mpp = this.viewM / (css / 2);
    const ideal = Math.log2(metresPerPixel(lat, 0) / mpp);
    // Hysteresis: keep the current zoom while it's within about 1.1× of the ideal scale.
    if (ideal > this.zoom + 0.15 || ideal < this.zoom - 1.05) this.zoom = Math.min(20, Math.max(3, Math.ceil(ideal - 0.15)));
    const z = this.zoom;
    const scale = metresPerPixel(lat, z) / mpp; // screen CSS px per tile px

    const ctx = this.ctx;
    const r = css / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#1c1f25';
    ctx.fillRect(0, 0, css, css);

    const s = this.session;
    if (s) {
      const [cx, cy] = project(lat, lon, z);
      ctx.translate(r, r);
      ctx.rotate(-viewBearing);
      ctx.scale(scale, scale);
      // The map is round: tiles within its radius.
      const reach = r / scale;
      const n = 2 ** z;
      const x0 = Math.floor((cx - reach) / TILE);
      const x1 = Math.floor((cx + reach) / TILE);
      const y0 = Math.max(0, Math.floor((cy - reach) / TILE));
      const y1 = Math.min(n - 1, Math.floor((cy + reach) / TILE));
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          // Skip corner tiles the circle doesn't reach.
          const nx = Math.max(tx * TILE, Math.min(cx, (tx + 1) * TILE)) - cx;
          const ny = Math.max(ty * TILE, Math.min(cy, (ty + 1) * TILE)) - cy;
          if (nx * nx + ny * ny > reach * reach) continue;
          this.drawTile(s, z, ((tx % n) + n) % n, ty, tx * TILE - cx, ty * TILE - cy);
        }
      }
      this.maybeCopyright(s, lat, lon, z, `${z}/${x0}/${y0}/${x1}/${y1}`, reach * metresPerPixel(lat, z));
    }
    ctx.restore();

    // The car, at the centre.
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(carBearing - viewBearing);
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fillStyle = '#ff4d3d';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawTile(s: MapSession, z: number, x: number, y: number, dx: number, dy: number): void {
    const t = this.tile(s, z, x, y, true);
    const ctx = this.ctx;
    // Each tile overlaps its neighbours by a hair so seams don't show once rotated.
    if (t?.state === 'ready') {
      ctx.drawImage(t.img, dx - 0.25, dy - 0.25, TILE + 0.5, TILE + 0.5);
      return;
    }
    // Still loading: the matching part of a coarser tile, if one is in memory.
    for (let k = 1; k <= 4 && z - k >= 0; k++) {
      const p = this.tile(s, z - k, x >> k, y >> k, false);
      if (p?.state !== 'ready') continue;
      const w = p.img.naturalWidth / 2 ** k;
      const sx = (x - ((x >> k) << k)) * w;
      const sy = (y - ((y >> k) << k)) * w;
      ctx.drawImage(p.img, sx, sy, w, w, dx - 0.25, dy - 0.25, TILE + 0.5, TILE + 0.5);
      return;
    }
  }

  private tile(s: MapSession, z: number, x: number, y: number, request: boolean): TileImage | null {
    const id = `${z}/${x}/${y}`;
    const t = this.tiles.get(id);
    if (t && !(request && t.state === 'failed' && performance.now() - t.failedAt > TILE_RETRY)) {
      // Most recently used last, so eviction drops the oldest.
      this.tiles.delete(id);
      this.tiles.set(id, t);
      return t;
    }
    if (!request || this.inFlight >= MAX_IN_FLIGHT) return t ?? null;
    this.tiles.delete(id);
    const img = new Image();
    const entry: TileImage = { img, state: 'loading', failedAt: 0 };
    this.inFlight++;
    img.onload = () => {
      entry.state = 'ready';
      this.inFlight--;
      this.failStreak = 0;
    };
    img.onerror = () => {
      entry.state = 'failed';
      entry.failedAt = performance.now();
      this.inFlight--;
      // Sessions expire (after about two weeks): start a new one.
      if (++this.failStreak >= SESSION_FAILURES && this.key && s === this.session) {
        dropSession(this.key);
        this.failed = true;
        this.setKey(this.key);
      }
    };
    img.src = tileUrl(s, z, x, y);
    this.tiles.set(id, entry);
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value!);
    return entry;
  }

  /** Google requires the map data copyright for the area shown; it comes from the viewport API. */
  private maybeCopyright(s: MapSession, lat: number, lon: number, z: number, view: string, radiusM: number): void {
    const now = performance.now();
    if (this.copyrightBusy || view === this.copyrightView || now - this.copyrightAt < COPYRIGHT_EVERY) return;
    this.copyrightBusy = true;
    this.copyrightAt = now;
    const dLat = radiusM / 111320;
    const dLon = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const key = this.key;
    copyright(s, z, lat + dLat, lat - dLat, lon + dLon, lon - dLon)
      .then((text) => {
        if (this.key !== key) return;
        this.copyrightView = view;
        this.copyEl.textContent = text;
      })
      // Try again soon rather than show tiles without their copyright for long.
      .catch(() => (this.copyrightAt = now - COPYRIGHT_EVERY + COPYRIGHT_RETRY))
      .finally(() => (this.copyrightBusy = false));
  }
}
