// What the ground is made of at real locations, from the same OpenStreetMap
// vector tiles as the roads (osmRoads.ts), never from Google's tiles. Each z14
// tile is rasterised once into a grid of surfaces in its own Web Mercator
// pixel space, so the geometry needs no projection; a lookup maps world x/z to
// a cell. Pure (no DOM or canvas), so tools/surfaces.mjs runs it in node.
//
// Never on screen for players: Google's terms forbid showing a non-Google map
// with their content, so only the debug overlay draws it.
import { SURFACE_IDS, type SurfaceId } from '../car/surfaces';
import { tileCoords, ZOOM, type DecodedTile, type OsmRoads } from './osmRoads';
import { drivableClass, type RoadClass } from './roads';

/**
 * Cells per tile side. A z14 tile is 2446 m × cos(lat) across, so a cell is
 * 1.2 m at the equator and 0.85 m at 45°: under a car's track width, and the
 * tile's own 4096-unit precision is 2 units a cell. 4 MB a tile.
 */
export const GRID = 2048;

/** Cell value of each surface: its index in SURFACE_IDS. */
export const SURFACE_CODE = Object.fromEntries(SURFACE_IDS.map((s, i) => [s, i])) as Record<SurfaceId, number>;

/**
 * Carriageway width (m) by class, a little generous: OSM centrelines and the
 * photogrammetry can disagree by a few metres. Each direction of a dual
 * carriageway is its own way.
 */
export const ROAD_WIDTH: Record<RoadClass, number> = {
  motorway: 14,
  trunk: 12,
  primary: 11,
  secondary: 10,
  tertiary: 8,
  // Park drives sit inside the park's polygon, so the paint is their only asphalt.
  minor: 8,
  service: 6,
  track: 3.5,
  raceway: 10,
  busway: 6,
};
/** Service kinds narrower than the class's width. A two-way parking aisle is 6–7 m, so it keeps service's. */
const SERVICE_WIDTH: Record<string, number> = { driveway: 3.5 };
/** Bridge decks carry footways and parapets: wider, so a deck's edge never reads as the water under it. */
const BRIDGE_EXTRA = 3;
/** Pedestrian streets (and car-free park drives, mapped as them) are full-width roads, not footpaths. */
const PEDESTRIAN_WIDTH = 8;
/** Decks of bridges and piers with no car road drawn on them: footbridges, piers mapped as lines, rail bridges. */
const DECK_WIDTH: Record<string, number> = { rail: 6, transit: 6 };
const PATH_DECK_WIDTH = 4;
/** Lines that are never a deck to stand on. */
const NO_DECK = new Set(['ferry', 'aerialway']);
/**
 * Footpaths through a park are paving or gravel, not lawn: OpenMapTiles `path`
 * subclasses drawn, a little wider than most paths are. Generic paths and
 * bridleways untagged are dirt; footways, cycleways and steps are paved.
 */
const PATH_WIDTH = 3;
const PATHS = new Set(['footway', 'cycleway', 'steps', 'path', 'bridleway']);
const LOOSE_PATHS = new Set(['path', 'bridleway']);

/**
 * OpenMapTiles landcover classes, every subclass: lawns, parks, gardens, golf,
 * meadows and scrub are `grass`. Ice stays hard ground (there's no ice
 * surface). Drawn in passes, not in the tile's order, so rock and sand mapped
 * inside a park or wood stay rock and sand.
 */
const LANDCOVER_PASSES: string[][] = [['grass', 'farmland', 'wood', 'wetland'], ['rock'], ['sand']];
/** Pitches up to this area (m²) are courts, often hard; bigger ones are turf fields. */
const COURT_AREA = 2500;
/** Running tracks up to this length (m) end to end are hard (a 400 m track is about 180 m); bigger ones are racecourses, mostly turf. */
const RUNNING_TRACK_SPAN = 250;
/** Transportation areas that are hard ground over whatever is under them: bridge outlines, piers, plazas. */
const HARD_AREAS = new Set(['bridge', 'pier']);

const EARTH_CIRCUMFERENCE = 40075016.686;
/** Metres between the points the world → tile mapping is measured from. */
const FRAME_STEP = 100;

/** The parts of a VectorTile the rasteriser reads (a mock fits too, for tests). */
export interface TileLayers {
  layers: Record<
    string,
    {
      length: number;
      feature(i: number): {
        type: number;
        extent: number;
        properties: Record<string, unknown>;
        loadGeometry(): Array<Array<{ x: number; y: number }>>;
      };
    }
  >;
}

type Feature = ReturnType<TileLayers['layers'][string]['feature']>;

/** One tile's surfaces: row-major cells of SURFACE_CODE, row 0 at the tile's north edge. */
export interface SurfaceGrid {
  x: number;
  y: number;
  cells: Uint8Array;
  /** Time spent rasterising (ms), across however many frames it took. */
  ms: number;
}

/** Fills cells of a square grid: polygons and thick lines, sampled at cell centres, no anti-aliasing. */
export class Painter {
  private xs = new Float64Array(64);
  /** Per edge: first row, last row, x at the current row's centre, x step per row. */
  private readonly edges: number[] = [];
  private readonly quad = new Float64Array(8);

  constructor(
    readonly cells: Uint8Array,
    readonly n: number,
  ) {}

  /**
   * Even-odd fill across every ring together, so MVT holes stay empty. Rings
   * are flat [x0, y0, x1, y1, …] in cells, closed implicitly; anything off the
   * grid is clipped.
   */
  fill(rings: ArrayLike<number>[], v: number): void {
    const n = this.n;
    const e = this.edges;
    e.length = 0;
    let top = n;
    let bottom = -1;
    for (const r of rings) {
      const m = r.length;
      for (let k = 0; k < m; k += 2) {
        let ax = r[k];
        let ay = r[k + 1];
        let bx = r[(k + 2) % m];
        let by = r[(k + 3) % m];
        if (ay === by) continue;
        if (ay > by) [ax, ay, bx, by] = [bx, by, ax, ay];
        // The rows whose centre lies in [ay, by).
        const j0 = Math.max(0, Math.ceil(ay - 0.5));
        const j1 = Math.min(n - 1, Math.ceil(by - 0.5) - 1);
        if (j0 > j1) continue;
        const dx = (bx - ax) / (by - ay);
        e.push(j0, j1, ax + (j0 + 0.5 - ay) * dx, dx);
        if (j0 < top) top = j0;
        if (j1 > bottom) bottom = j1;
      }
    }
    if (bottom < top) return;
    // Edges in order of first row, swept down the rows as an active list.
    const order: number[] = [];
    for (let i = 0; i < e.length; i += 4) order.push(i);
    order.sort((a, b) => e[a] - e[b]);
    const active: number[] = [];
    let next = 0;
    for (let j = top; j <= bottom; j++) {
      while (next < order.length && e[order[next]] === j) active.push(order[next++]);
      let k = 0;
      let w = 0;
      for (let q = 0; q < active.length; q++) {
        const id = active[q];
        if (e[id + 1] < j) continue;
        active[w++] = id;
        if (k === this.xs.length) {
          const grown = new Float64Array(k * 2);
          grown.set(this.xs);
          this.xs = grown;
        }
        this.xs[k++] = e[id + 2];
        e[id + 2] += e[id + 3];
      }
      active.length = w;
      const xs = this.xs.subarray(0, k).sort();
      for (let q = 0; q + 1 < k; q += 2) this.span(j, xs[q], xs[q + 1], v);
    }
  }

  /** A polyline (flat, in cells) `r` cells either side: a quad per segment, a disc at every vertex for the joins and ends. */
  line(pts: ArrayLike<number>, r: number, v: number): void {
    const q = this.quad;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const ax = pts[k];
      const ay = pts[k + 1];
      const bx = pts[k + 2];
      const by = pts[k + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len === 0) continue;
      const nx = (-(by - ay) / len) * r;
      const ny = ((bx - ax) / len) * r;
      q[0] = ax + nx;
      q[1] = ay + ny;
      q[2] = bx + nx;
      q[3] = by + ny;
      q[4] = bx - nx;
      q[5] = by - ny;
      q[6] = ax - nx;
      q[7] = ay - ny;
      this.fill([q], v);
    }
    for (let k = 0; k + 1 < pts.length; k += 2) this.disc(pts[k], pts[k + 1], r, v);
  }

  disc(cx: number, cy: number, r: number, v: number): void {
    const j0 = Math.max(0, Math.ceil(cy - r - 0.5));
    const j1 = Math.min(this.n - 1, Math.floor(cy + r - 0.5));
    for (let j = j0; j <= j1; j++) {
      const dy = j + 0.5 - cy;
      const h = Math.sqrt(Math.max(0, r * r - dy * dy));
      this.span(j, cx - h, cx + h, v);
    }
  }

  /** Cells of row j whose centre lies in [xa, xb). */
  private span(j: number, xa: number, xb: number, v: number): void {
    const i0 = Math.max(0, Math.ceil(xa - 0.5));
    const i1 = Math.min(this.n, Math.ceil(xb - 0.5));
    if (i0 < i1) this.cells.fill(v, j * this.n + i0, j * this.n + i1);
  }
}

function* features(tile: TileLayers, name: string): Generator<Feature> {
  const layer = tile.layers[name];
  for (let i = 0; layer && i < layer.length; i++) yield layer.feature(i);
}

/** A feature's rings or lines, flat, in cells. */
function cellsOf(f: Feature, n: number): Float64Array[] {
  const s = n / f.extent;
  return f.loadGeometry().map((ring) => {
    const out = new Float64Array(ring.length * 2);
    for (let k = 0; k < ring.length; k++) {
      out[k * 2] = ring[k].x * s;
      out[k * 2 + 1] = ring[k].y * s;
    }
    return out;
  });
}

/**
 * Rasterises tile `ty` (row, for its scale) at zoom `z`, one feature per step,
 * in priority order, later over earlier: hard ground everywhere, landcover
 * (vegetation, then rock, then sand), running tracks and pitches, road tunnels,
 * water, then hard transportation areas, unpaved lines and paved lines (roads,
 * pedestrian streets, bridge and pier decks). The generator returns the cells.
 */
export function* rasterSteps(tile: TileLayers, z: number, ty: number, n = GRID): Generator<void, Uint8Array> {
  const cells = new Uint8Array(n * n).fill(SURFACE_CODE.asphalt);
  const paint = new Painter(cells, n);
  // Road widths are in metres. The scale changes by under 0.1% across a z14 tile.
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 0.5)) / 2 ** z)));
  const cellMetres = (EARTH_CIRCUMFERENCE * Math.cos(lat)) / 2 ** z / n;

  for (const classes of LANDCOVER_PASSES) {
    for (const f of features(tile, 'landcover')) {
      const p = f.properties;
      if (f.type === 3 && classes.includes(String(p.class))) paint.fill(cellsOf(f, n), SURFACE_CODE[landcoverSurface(p)]);
      yield;
    }
  }
  // OpenMapTiles has no surface or sport for either, so size tells a court from
  // a field: running tracks first, so a turf pitch in a filled oval stays grass.
  for (const cls of ['track', 'pitch']) {
    for (const f of features(tile, 'landuse')) {
      if (f.type === 3 && f.properties.class === cls) {
        const rings = cellsOf(f, n);
        const hard = cls === 'track' ? spanOf(rings) * cellMetres <= RUNNING_TRACK_SPAN : areaOf(rings) * cellMetres ** 2 <= COURT_AREA;
        paint.fill(rings, hard ? SURFACE_CODE.asphalt : SURFACE_CODE.grass);
      }
      yield;
    }
  }
  // Road tunnels as asphalt over a park lid: a short underpass the mesh shows
  // under its cover isn't tunnel mode in physics, so it reads this. Water still
  // goes over, so a river over a long road tunnel stays water (in tunnel mode
  // physics reads asphalt anyway).
  for (const f of features(tile, 'transportation')) {
    const p = f.properties;
    const cls = f.type === 2 && p.brunnel === 'tunnel' ? drivableClass(p, true) : null;
    if (cls) for (const line of cellsOf(f, n)) paint.line(line, ROAD_WIDTH[cls] / 2 / cellMetres, SURFACE_CODE.asphalt);
    yield;
  }
  for (const f of features(tile, 'water')) {
    // Dry most of the year, or in a culvert: not water to drive into.
    const p = f.properties;
    if (f.type === 3 && Number(p.intermittent) !== 1 && p.brunnel !== 'tunnel') paint.fill(cellsOf(f, n), SURFACE_CODE.water);
    yield;
  }
  // Bridge outlines, piers and plazas (and the odd road mapped as an area).
  for (const f of features(tile, 'transportation')) {
    const p = f.properties;
    const hard = p.brunnel === 'bridge' || HARD_AREAS.has(String(p.class)) || p.subclass === 'pedestrian' || drivableClass(p);
    if (f.type === 3 && p.brunnel !== 'tunnel' && hard) paint.fill(cellsOf(f, n), SURFACE_CODE.asphalt);
    yield;
  }
  // Unpaved first, so a paved road wins where they meet. A step a line, not a
  // feature: the tiles merge every footway alike into one, ~900 lines in central London.
  for (const unpaved of [true, false]) {
    for (const f of features(tile, 'transportation')) {
      const style = f.type === 2 ? lineStyle(f.properties) : null;
      if (style && style.unpaved === unpaved) {
        const code = unpaved ? SURFACE_CODE.gravel : SURFACE_CODE.asphalt;
        for (const line of cellsOf(f, n)) {
          paint.line(line, style.width / 2 / cellMetres, code);
          yield;
        }
      }
      yield;
    }
  }
  return cells;
}

/** Scree is loose; bare rock is solid outcrop, hard and rough. */
function landcoverSurface(p: Record<string, unknown>): SurfaceId {
  if (p.class === 'sand') return 'sand';
  if (p.class === 'rock') return p.subclass === 'bare_rock' ? 'cobbles' : 'gravel';
  return 'grass';
}

/**
 * How a transportation line is drawn (width in m, gravel or not), or null if
 * it isn't: tunnels are drawn before the water, and indoor corridors not at
 * all. Any bridge or pier is a hard deck over the water, whatever runs on it.
 */
function lineStyle(p: Record<string, unknown>): { width: number; unpaved: boolean } | null {
  const bridge = p.brunnel === 'bridge';
  const extra = bridge ? BRIDGE_EXTRA : 0;
  const cls = drivableClass(p);
  if (cls) {
    const service = typeof p.service === 'string' && Object.hasOwn(SERVICE_WIDTH, p.service) ? SERVICE_WIDTH[p.service] : null;
    return { width: (service ?? ROAD_WIDTH[cls]) + extra, unpaved: isUnpaved(p) };
  }
  if (p.brunnel === 'tunnel') return null;
  if (p.subclass === 'pedestrian') return { width: PEDESTRIAN_WIDTH + extra, unpaved: isUnpaved(p) && !bridge };
  if ((bridge || p.class === 'pier') && !NO_DECK.has(String(p.class))) {
    const width = typeof p.class === 'string' && Object.hasOwn(DECK_WIDTH, p.class) ? DECK_WIDTH[p.class] : PATH_DECK_WIDTH;
    return { width: width + extra, unpaved: false };
  }
  const sub = String(p.subclass);
  if (p.class !== 'path' || !PATHS.has(sub) || Number(p.indoor) === 1) return null;
  return { width: PATH_WIDTH, unpaved: isUnpaved(p) || (LOOSE_PATHS.has(sub) && p.surface !== 'paved') };
}

/** OpenMapTiles folds OSM's surface tags into paved/unpaved; an untagged track is a dirt or gravel one. */
function isUnpaved(p: Record<string, unknown>): boolean {
  return p.surface === 'unpaved' || (p.class === 'track' && p.surface !== 'paved');
}

/** Area (cells²) of a feature's rings: MVT winds holes the other way, so they subtract. */
function areaOf(rings: Float64Array[]): number {
  let a = 0;
  for (const r of rings) {
    const m = r.length;
    for (let k = 0; k < m; k += 2) a += r[k] * r[(k + 3) % m] - r[(k + 2) % m] * r[k + 1];
  }
  return Math.abs(a) / 2;
}

/** The longer side (cells) of a feature's bounding box. */
function spanOf(rings: Float64Array[]): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rings) {
    for (let k = 0; k < r.length; k += 2) {
      x0 = Math.min(x0, r[k]);
      x1 = Math.max(x1, r[k]);
      y0 = Math.min(y0, r[k + 1]);
      y1 = Math.max(y1, r[k + 1]);
    }
  }
  return Math.max(x1 - x0, y1 - y0);
}

/** Rasterises a whole tile at once (tools, tests). */
export function rasterise(tile: TileLayers, z: number, ty: number, n = GRID): Uint8Array {
  const steps = rasterSteps(tile, z, ty, n);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** World x/z → degrees, around the point the mapping is measured at. */
export type Unproject = (x: number, z: number) => [number, number];

/**
 * The surface map of the OSM tiles around the car: rasterises the tiles
 * OsmRoads currently wants, a slice per frame, and answers lookups through a
 * local affine world → tile mapping (Web Mercator is linear to well under a
 * millimetre over the few hundred metres around the car).
 */
export class OsmSurface {
  /** Kept with the decoded tile: when OsmRoads drops a tile, its grid goes too. */
  private readonly grids = new WeakMap<DecodedTile, SurfaceGrid>();
  /** Grids of the tiles OsmRoads still holds. */
  private ready: SurfaceGrid[] = [];
  private last: SurfaceGrid | null = null;
  private job: { tile: DecodedTile; steps: Generator<void, Uint8Array>; ms: number; frames: number } | null = null;
  /** A wanted tile has no grid yet. */
  private waiting = false;
  /** World x/z → fractional tile x, y: [ax, bx, cx, ay, by, cy]. */
  private readonly frame = new Float64Array(6);
  private framed = false;
  private lastMs = 0;
  private lastFrames = 0;

  constructor(private readonly osm: Pick<OsmRoads, 'decoded' | 'current'>) {}

  /** Call after OsmRoads.update(): picks up tiles that arrived and lets go of evicted ones. */
  sync(): void {
    const held = this.osm.decoded();
    this.ready = held.flatMap((d) => this.grids.get(d) ?? []);
    this.last = null;
    if (this.job && !held.includes(this.job.tile)) this.job = null;
    this.waiting = this.osm.current().some((d) => !this.grids.has(d));
  }

  /** Rasterises wanted tiles for up to `budget` ms. */
  work(budget: number): void {
    if (!this.job && !this.waiting) return;
    const t0 = performance.now();
    const end = t0 + budget;
    while (performance.now() < end) {
      if (!this.job) {
        const tile = this.osm.current().find((d) => !this.grids.has(d));
        if (!tile) {
          this.waiting = false;
          return;
        }
        this.job = { tile, steps: rasterSteps(tile.tile, tile.z, tile.y), ms: 0, frames: 0 };
      }
      const job = this.job;
      const s0 = performance.now();
      job.frames++;
      let r = job.steps.next();
      while (!r.done && performance.now() < end) r = job.steps.next();
      job.ms += performance.now() - s0;
      if (!r.done) return;
      const grid: SurfaceGrid = { x: job.tile.x, y: job.tile.y, cells: r.value, ms: job.ms };
      this.grids.set(job.tile, grid);
      this.ready.push(grid);
      this.lastMs = job.ms;
      this.lastFrames = job.frames;
      this.job = null;
    }
  }

  /**
   * Measures the world → tile mapping around (x, z). Call when the focus has
   * moved and after a rebase: it holds to millimetres over a few hundred metres.
   */
  setFrame(x: number, z: number, unproject: Unproject): void {
    const n = 2 ** ZOOM;
    const at = (dx: number, dz: number) => {
      const [lat, lon] = unproject(x + dx, z + dz);
      return tileCoords(lat, lon);
    };
    const o = at(0, 0);
    const e = at(FRAME_STEP, 0);
    const s = at(0, FRAME_STEP);
    // Across the antimeridian the tile column wraps.
    const wrap = (d: number) => d - n * Math.round(d / n);
    const f = this.frame;
    f[0] = wrap(e.x - o.x) / FRAME_STEP;
    f[1] = wrap(s.x - o.x) / FRAME_STEP;
    f[2] = o.x - f[0] * x - f[1] * z;
    f[3] = (e.y - o.y) / FRAME_STEP;
    f[4] = (s.y - o.y) / FRAME_STEP;
    f[5] = o.y - f[3] * x - f[4] * z;
    this.framed = true;
  }

  /** The surface at world (x, z): asphalt until its tile has loaded and been rasterised. */
  surfaceAt(x: number, z: number): SurfaceId {
    if (!this.framed) return 'asphalt';
    const f = this.frame;
    const tx = f[0] * x + f[1] * z + f[2];
    const ty = f[3] * x + f[4] * z + f[5];
    const cx = Math.floor(tx);
    const cy = Math.floor(ty);
    const n = 2 ** ZOOM;
    const col = ((cx % n) + n) % n;
    let g = this.last;
    if (!g || g.x !== col || g.y !== cy) {
      g = null;
      for (const r of this.ready) if (r.x === col && r.y === cy) g = r;
      if (!g) return 'asphalt';
      this.last = g;
    }
    const i = Math.floor((tx - cx) * GRID);
    const j = Math.floor((ty - cy) * GRID);
    return SURFACE_IDS[g.cells[j * GRID + i]];
  }

  stats(): Record<string, number> {
    return {
      surfaceTiles: this.ready.length,
      surfaceRasterMs: Math.round(this.lastMs * 10) / 10,
      surfaceRasterFrames: this.lastFrames,
    };
  }
}
