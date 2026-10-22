// Road centrelines in world space and the queries the game needs of them. Pure
// data: no scene, no fetching, so it runs (and is checked) in node too.

/** OpenMapTiles `transportation` classes a car can be put on. */
export type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'minor' | 'service' | 'track' | 'raceway' | 'busway';

/**
 * Extra cost (m) of picking a road of this class over a main road the same
 * distance away: a stuck driver wants the street, not the alley behind it.
 */
const CLASS_PENALTY: Record<RoadClass, number> = {
  motorway: 0,
  trunk: 0,
  primary: 0,
  secondary: 0,
  tertiary: 1,
  minor: 2,
  raceway: 2,
  busway: 6,
  service: 8,
  track: 12,
};

/**
 * On top of the class's: OpenMapTiles `service` kinds no one wants to restart
 * on. A driveway or parking aisle beside a sidewalk is often nearer than the
 * centreline of the wide street the car was on.
 */
const SERVICE_PENALTY: Record<string, number> = {
  alley: 8,
  driveway: 30,
  parking_aisle: 30,
};

/** Footways, cycle paths, platforms and the like, mapped as subclasses of drivable-looking classes. */
const NOT_FOR_CARS = new Set(['pedestrian', 'footway', 'cycleway', 'steps', 'path', 'bridleway', 'corridor', 'platform']);

/** Spatial hash cell (m): a few segments each in a dense city. */
const CELL = 32;
/** Cell-key offset so negative cell indices pack into one non-negative number. */
const CELL_OFFSET = 2 ** 21;

/**
 * A drivable OpenMapTiles `transportation` feature's class, or null for
 * anything the car shouldn't be put on: paths, rail, ferries, construction,
 * and tunnels (the photogrammetry has no road inside them).
 */
export function drivableClass(props: Record<string, unknown>): RoadClass | null {
  const cls = props.class;
  if (typeof cls !== 'string' || !Object.hasOwn(CLASS_PENALTY, cls)) return null;
  if (props.brunnel === 'tunnel') return null;
  if (typeof props.subclass === 'string' && NOT_FOR_CARS.has(props.subclass)) return null;
  return cls as RoadClass;
}

/**
 * A road's vertical level: its OSM layer, bridges counting as at least 1 (the
 * layer OSM implies for one). Above 0 is elevated: its deck is the topmost surface.
 */
export function roadLevel(r: { bridge: boolean; layer: number }): number {
  return r.bridge ? Math.max(1, r.layer) : r.layer;
}

/** One road polyline with its OpenMapTiles attributes. */
export interface RoadWay {
  /** World x, z pairs: [x0, z0, x1, z1, …]. */
  xz: Float64Array;
  cls: RoadClass;
  /** brunnel=bridge: the deck is the topmost surface, not the lowest. */
  bridge: boolean;
  /** OSM layer (0 when untagged): above 0 is elevated even without a bridge tag. */
  layer: number;
  /** null when untagged. */
  paved: boolean | null;
  /** OpenMapTiles `service` (driveway, parking_aisle, alley…); null when untagged. */
  service: string | null;
}

/** How much worse than a main road the same distance away (m) a road is to be put on. */
function penalty(way: RoadWay): number {
  const extra = way.service !== null && Object.hasOwn(SERVICE_PENALTY, way.service) ? SERVICE_PENALTY[way.service] : 0;
  return CLASS_PENALTY[way.cls] + extra;
}

/** Segment `index` of `way` (point index → index + 1). */
export interface RoadSegment {
  way: RoadWay;
  index: number;
}

/** A point on a road centreline. */
export interface RoadPoint {
  x: number;
  z: number;
  /** Unit direction of the segment, from its first point to its second. */
  dirX: number;
  dirZ: number;
  cls: RoadClass;
  bridge: boolean;
  layer: number;
  /** Distance (m) from the query point. */
  distance: number;
  segment: RoadSegment;
  /** Position along the segment, 0…1. */
  t: number;
}

/** Road centrelines indexed in a uniform grid of CELL-metre cells. */
export class RoadNetwork {
  readonly segments: RoadSegment[] = [];
  private readonly grid = new Map<number, number[]>();
  /** Per-segment query stamp, so a segment spanning several cells is tested once. */
  private readonly seen: Uint32Array;
  private stamp = 0;

  constructor(readonly ways: readonly RoadWay[]) {
    for (const way of ways) {
      const p = way.xz;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const id = this.segments.length;
        this.segments.push({ way, index: i / 2 });
        const x0 = Math.floor(Math.min(p[i], p[i + 2]) / CELL);
        const x1 = Math.floor(Math.max(p[i], p[i + 2]) / CELL);
        const z0 = Math.floor(Math.min(p[i + 1], p[i + 3]) / CELL);
        const z1 = Math.floor(Math.max(p[i + 1], p[i + 3]) / CELL);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cz = z0; cz <= z1; cz++) {
            const key = cellKey(cx, cz);
            const list = this.grid.get(key);
            if (list) list.push(id);
            else this.grid.set(key, [id]);
          }
        }
      }
    }
    this.seen = new Uint32Array(this.segments.length);
  }

  /** Calls `fn` once for every segment with a cell within `radius` of (x, z). */
  forEachNear(x: number, z: number, radius: number, fn: (s: RoadSegment) => void): void {
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const x0 = Math.floor((x - radius) / CELL);
    const x1 = Math.floor((x + radius) / CELL);
    const z0 = Math.floor((z - radius) / CELL);
    const z1 = Math.floor((z + radius) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.grid.get(cellKey(cx, cz));
        if (!list) continue;
        for (const id of list) {
          if (this.seen[id] === this.stamp) continue;
          this.seen[id] = this.stamp;
          fn(this.segments[id]);
        }
      }
    }
  }

  /**
   * Closest points on roads within `radius` of (x, z), cheapest first (distance
   * plus a penalty for minor classes), one per segment, at most `max`. Points
   * that duplicate a better one (the shared vertex of two segments of a way,
   * or the same road clipped into two neighbouring tiles) are dropped; a road
   * on another level along the same line (a deck over a street) is not a duplicate.
   */
  nearest(x: number, z: number, radius: number, max = 16): RoadPoint[] {
    const found: Array<RoadPoint & { cost: number }> = [];
    this.forEachNear(x, z, radius, (s) => {
      const p = closestOnSegment(s, x, z);
      if (p.distance <= radius) found.push({ ...p, cost: p.distance + penalty(s.way) });
    });
    found.sort((a, b) => a.cost - b.cost);
    const out: RoadPoint[] = [];
    for (const { cost: _cost, ...p } of found) {
      const dup = out.some(
        (q) =>
          q.bridge === p.bridge &&
          q.layer === p.layer &&
          Math.hypot(q.x - p.x, q.z - p.z) < 1.5 &&
          Math.abs(q.dirX * p.dirX + q.dirZ * p.dirZ) > 0.95,
      );
      if (dup) continue;
      out.push(p);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * Whether a road on a higher (`sign` 1) or lower (−1) level than `p` passes
   * within `radius` of it: where roads are stacked, the top or bottom surface
   * of the mesh may belong to the other one.
   */
  levelNear(p: RoadPoint, radius: number, sign: 1 | -1): boolean {
    const level = roadLevel(p);
    let found = false;
    this.forEachNear(p.x, p.z, radius, (s) => {
      if (found || (roadLevel(s.way) - level) * sign <= 0) return;
      if (closestOnSegment(s, p.x, p.z).distance <= radius) found = true;
    });
    return found;
  }

  /**
   * The point `offset` metres further along `p`'s road (negative: back toward
   * its start), following the polyline through its bends; null past either end.
   */
  along(p: RoadPoint, offset: number): RoadPoint | null {
    const { way } = p.segment;
    const xz = way.xz;
    const last = xz.length / 2 - 2;
    let i = p.segment.index;
    // Distance left to travel from the segment's first point.
    let d = p.t * segLength(xz, i) + offset;
    while (d < 0) {
      if (--i < 0) return null;
      d += segLength(xz, i);
    }
    while (d > segLength(xz, i)) {
      d -= segLength(xz, i);
      if (++i > last) return null;
    }
    const len = segLength(xz, i);
    const t = len > 0 ? d / len : 0;
    const k = i * 2;
    const dx = xz[k + 2] - xz[k];
    const dz = xz[k + 3] - xz[k + 1];
    const x = xz[k] + dx * t;
    const z = xz[k + 1] + dz * t;
    return {
      x,
      z,
      dirX: len > 0 ? dx / len : p.dirX,
      dirZ: len > 0 ? dz / len : p.dirZ,
      cls: way.cls,
      bridge: way.bridge,
      layer: way.layer,
      distance: p.distance + Math.abs(offset),
      segment: { way, index: i },
      t,
    };
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + CELL_OFFSET) * 2 ** 22 + (cz + CELL_OFFSET);
}

function segLength(xz: Float64Array, i: number): number {
  return Math.hypot(xz[i * 2 + 2] - xz[i * 2], xz[i * 2 + 3] - xz[i * 2 + 1]);
}

function closestOnSegment(s: RoadSegment, x: number, z: number): RoadPoint {
  const xz = s.way.xz;
  const k = s.index * 2;
  const ax = xz[k];
  const az = xz[k + 1];
  const dx = xz[k + 2] - ax;
  const dz = xz[k + 3] - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
  const px = ax + dx * t;
  const pz = az + dz * t;
  const len = Math.sqrt(len2);
  return {
    x: px,
    z: pz,
    dirX: len > 0 ? dx / len : 1,
    dirZ: len > 0 ? dz / len : 0,
    cls: s.way.cls,
    bridge: s.way.bridge,
    layer: s.way.layer,
    distance: Math.hypot(x - px, z - pz),
    segment: s,
    t,
  };
}
