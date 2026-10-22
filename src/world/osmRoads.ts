// OpenStreetMap road data from OpenFreeMap's vector tiles (OpenMapTiles schema).
// Only OSM data: Google's Map Tiles policy forbids deriving geodata from its
// tiles, so roads never come from the photogrammetry. Runs in node too (the
// projection is injected), for tools/roads.mjs.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { drivableClass, RoadNetwork, type RoadClass, type RoadWay } from './roads';

/** Required wherever this data is used. */
export const OSM_ATTRIBUTION = '© OpenMapTiles © OpenStreetMap contributors';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
/** OpenFreeMap's max zoom: ~2.4 km × cos(lat) across, full street detail. */
export const ZOOM = 14;
/** Also load the neighbouring tile when the focus is this close (m) to its edge. */
const EDGE_MARGIN = 300;
const MAX_IN_FLIGHT = 2;
/** A request still going after this (ms) has stalled: give up and retry, so it doesn't hold a slot for minutes. */
const FETCH_TIMEOUT = 15000;
/** Decoded tiles kept (the 3×3 around the car), so driving back and forth doesn't refetch. */
const KEEP_TILES = 9;
const RETRY_BASE = 2000;
const RETRY_MAX = 60000;
const EARTH_CIRCUMFERENCE = 40075016.686;

/** Geodetic (degrees) → world x/z. Across the antimeridian from the focus, lon is on the far side of ±180. */
export type Projection = (lat: number, lon: number) => [number, number];

/** A drivable road as decoded, in degrees, so it can be re-projected after a rebase. */
export interface GeoRoad {
  /** [lat0, lon0, lat1, lon1, …]. */
  latLon: Float64Array;
  cls: RoadClass;
  bridge: boolean;
  layer: number;
  paved: boolean | null;
  service: string | null;
}

/**
 * One decoded z14 tile. The VectorTile stays around (it parses layers lazily)
 * so other consumers, such as a surface map from `landcover` and `landuse`,
 * can share the same download.
 */
export interface DecodedTile {
  x: number;
  y: number;
  z: number;
  tile: VectorTile;
  roads: GeoRoad[];
  /** Transportation features by class, drivable or not (for reports). */
  classes: Record<string, number>;
  bytes: number;
  decodeMs: number;
}

interface TileState {
  decoded: DecodedTile | null;
  abort: AbortController | null;
  failures: number;
  retryAt: number;
}

/** Fractional z14 tile coordinates of a point (Web Mercator). */
export function tileCoords(lat: number, lon: number, z = ZOOM): { x: number; y: number } {
  const n = 2 ** z;
  const r = lat * (Math.PI / 180);
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  };
}

/** Tile pixel (extent units) → degrees: inverse Web Mercator. */
function toLatLon(z: number, tx: number, ty: number, px: number, py: number, extent: number): [number, number] {
  const n = 2 ** z;
  const lon = ((tx + px / extent) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n))) * (180 / Math.PI);
  return [lat, lon];
}

/** Parses a tile and keeps its drivable roads' line geometry. */
export function decodeTile(buf: Uint8Array, z: number, x: number, y: number): DecodedTile {
  const t0 = performance.now();
  const tile = new VectorTile(new PbfReader(buf));
  const roads: GeoRoad[] = [];
  const classes: Record<string, number> = {};
  const layer = tile.layers.transportation;
  for (let i = 0; layer && i < layer.length; i++) {
    const f = layer.feature(i);
    const props = f.properties;
    classes[String(props.class)] = (classes[String(props.class)] ?? 0) + 1;
    // Polygons (pedestrian areas, bridge outlines) have no centreline.
    if (f.type !== 2) continue;
    const cls = drivableClass(props);
    if (!cls) continue;
    const meta = {
      cls,
      bridge: props.brunnel === 'bridge',
      layer: Number(props.layer) || 0,
      paved: props.surface === 'paved' ? true : props.surface === 'unpaved' ? false : null,
      service: typeof props.service === 'string' ? props.service : null,
    };
    for (const line of f.loadGeometry()) {
      if (line.length < 2) continue;
      const latLon = new Float64Array(line.length * 2);
      line.forEach((p, k) => latLon.set(toLatLon(z, x, y, p.x, p.y, f.extent), k * 2));
      roads.push({ latLon, ...meta });
    }
  }
  return { x, y, z, tile, roads, classes, bytes: buf.byteLength, decodeMs: performance.now() - t0 };
}

/**
 * Streams the z14 tiles around a focus point and keeps a RoadNetwork of their
 * drivable roads in world space. Never fatal: failures retry with back-off and
 * the network is simply null (or partial) until something loads.
 */
export class OsmRoads {
  /** Roads of the tiles around the focus, projected; null until one has loaded. */
  network: RoadNetwork | null = null;
  private template: string | null = null;
  private templateLoad: { abort: AbortController; retryAt: number; failures: number; busy: boolean } = {
    abort: new AbortController(),
    retryAt: 0,
    failures: 0,
    busy: false,
  };
  /** Insertion order is recency: the first entry is evicted first. */
  private readonly tiles = new Map<string, TileState>();
  private wanted: string[] = [];
  private inFlight = 0;
  private dirty = false;
  private disposed = false;
  private errors = 0;
  private decodeMs = 0;

  constructor(
    private readonly project: Projection,
    private readonly tileJson = TILEJSON,
  ) {}

  /** Call often with the focus position (degrees); loads what's missing and rebuilds the network when tiles arrive. */
  update(lat: number, lon: number): void {
    if (this.disposed) return;
    const n = 2 ** ZOOM;
    const { x, y } = tileCoords(lat, lon);
    // In tiles, from metres here, so the margin is the same on the ground
    // everywhere. Toward the poles tiles shrink below it: then every tile the
    // margin reaches, capped at the 3×3 KEEP_TILES holds.
    const margin = Math.min(1, EDGE_MARGIN / ((EARTH_CIRCUMFERENCE * Math.cos(lat * (Math.PI / 180))) / n));
    const wanted: string[] = [];
    // Rows beyond Web Mercator's ±85° don't exist.
    for (let ty = Math.max(0, Math.floor(y - margin)); ty <= Math.min(n - 1, Math.floor(y + margin)); ty++) {
      for (let tx = Math.floor(x - margin); tx <= Math.floor(x + margin); tx++) {
        // Columns wrap at the antimeridian.
        const k = key(((tx % n) + n) % n, ty);
        // The tile under the focus first, so it loads first.
        if (tx === Math.floor(x) && ty === Math.floor(y)) wanted.unshift(k);
        else wanted.push(k);
      }
    }
    if (wanted.join() !== this.wanted.join()) {
      this.wanted = wanted;
      this.dirty = true;
      // Free the slots of tiles no longer wanted; unfinished, they load again if wanted again.
      for (const [k, s] of this.tiles) if (!wanted.includes(k)) s.abort?.abort();
      for (const k of wanted) this.touch(k);
      this.evict();
    }
    this.pump();
    if (this.dirty) this.rebuild();
  }

  /** Re-projects every road (after the world frame moved). */
  reproject(): void {
    if (!this.disposed) this.rebuild();
  }

  /** True once road data is on screen or in use: its attribution must show. */
  get inUse(): boolean {
    return this.network !== null;
  }

  /** Decoded tiles currently held, most recently wanted last. */
  decoded(): DecodedTile[] {
    return [...this.tiles.values()].flatMap((s) => (s.decoded ? [s.decoded] : []));
  }

  stats(): Record<string, number> {
    return {
      roadTiles: this.decoded().length,
      roadLoading: this.inFlight,
      roadErrors: this.errors,
      roadSegments: this.network?.segments.length ?? 0,
      roadDecodeMs: Math.round(this.decodeMs * 10) / 10,
    };
  }

  /** The wanted tiles (around the focus) that have decoded, the one under it first. */
  current(): DecodedTile[] {
    return this.wanted.flatMap((k) => this.tiles.get(k)?.decoded ?? []);
  }

  /** Wanted tiles not yet decoded (still loading or waiting to retry). */
  get pending(): number {
    return this.wanted.filter((k) => !this.tiles.get(k)?.decoded).length;
  }

  dispose(): void {
    this.disposed = true;
    this.templateLoad.abort.abort();
    for (const s of this.tiles.values()) s.abort?.abort();
    this.tiles.clear();
    this.network = null;
  }

  private touch(k: string): void {
    const s = this.tiles.get(k) ?? { decoded: null, abort: null, failures: 0, retryAt: 0 };
    this.tiles.delete(k);
    this.tiles.set(k, s);
  }

  private evict(): void {
    for (const [k, s] of this.tiles) {
      if (this.tiles.size <= KEEP_TILES) break;
      if (this.wanted.includes(k)) continue;
      s.abort?.abort();
      this.tiles.delete(k);
    }
  }

  private pump(): void {
    const now = performance.now();
    if (!this.template) {
      const t = this.templateLoad;
      if (!t.busy && now >= t.retryAt) void this.loadTemplate();
      return;
    }
    for (const k of this.wanted) {
      if (this.inFlight >= MAX_IN_FLIGHT) return;
      const s = this.tiles.get(k);
      if (!s || s.decoded || s.abort || now < s.retryAt) continue;
      void this.loadTile(k, s);
    }
  }

  private async loadTemplate(): Promise<void> {
    const t = this.templateLoad;
    t.busy = true;
    try {
      const res = await fetch(this.tileJson, { signal: AbortSignal.any([t.abort.signal, AbortSignal.timeout(FETCH_TIMEOUT)]) });
      if (!res.ok) throw new Error(`TileJSON HTTP ${res.status}`);
      const json = (await res.json()) as { tiles?: string[] };
      if (!json.tiles?.[0]) throw new Error('TileJSON has no tile URL');
      this.template = json.tiles[0];
    } catch (err) {
      if (this.disposed) return;
      this.errors++;
      t.retryAt = performance.now() + Math.min(RETRY_MAX, RETRY_BASE * 2 ** t.failures++);
      console.warn('[roads] TileJSON failed', err);
    } finally {
      t.busy = false;
    }
  }

  private async loadTile(k: string, s: TileState): Promise<void> {
    const [x, y] = k.split('/').map(Number);
    s.abort = new AbortController();
    this.inFlight++;
    try {
      const url = this.template!.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y));
      // A timeout leaves s.abort un-aborted, so it fails (and backs off) like any error.
      const res = await fetch(url, { signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(FETCH_TIMEOUT)]) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for tile ${ZOOM}/${k}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (this.disposed || this.tiles.get(k) !== s) return;
      s.decoded = decodeTile(buf, ZOOM, x, y);
      this.decodeMs = s.decoded.decodeMs;
      if (this.wanted.includes(k)) this.dirty = true;
    } catch (err) {
      if (this.disposed || s.abort?.signal.aborted) return;
      this.errors++;
      s.retryAt = performance.now() + Math.min(RETRY_MAX, RETRY_BASE * 2 ** s.failures++);
      console.warn('[roads] tile failed', err);
    } finally {
      s.abort = null;
      this.inFlight--;
    }
  }

  private rebuild(): void {
    this.dirty = false;
    let tiles = this.current();
    // While the tiles around a new focus load, the ones held from before are better than nothing.
    if (!tiles.length) tiles = this.decoded();
    const ways: RoadWay[] = [];
    for (const d of tiles) {
      for (const r of d.roads) {
        const xz = new Float64Array(r.latLon.length);
        for (let i = 0; i < r.latLon.length; i += 2) xz.set(this.project(r.latLon[i], r.latLon[i + 1]), i);
        ways.push({ xz, cls: r.cls, bridge: r.bridge, layer: r.layer, paved: r.paved, service: r.service });
      }
    }
    this.network = tiles.length ? new RoadNetwork(ways) : null;
  }
}

function key(x: number, y: number): string {
  return `${x}/${y}`;
}
