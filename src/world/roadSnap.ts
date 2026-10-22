// Finds somewhere on a real road to put the car: OSM says where the street
// is, the collision mesh says where its surface is and whether the spot is clear.
import { Vector3 } from 'three';
import type { ChassisSpec } from '../car/cars';
import type { Collider, RayHit } from './collider';
import { roadLevel, type RoadClass, type RoadNetwork, type RoadPoint } from './roads';

/** Search radii (m), tried in turn: the wider one only if nothing near works. */
const RADII = [120, 250];
/** Candidates per radius. */
const MAX_CANDIDATES = 16;
/**
 * Offsets (m) along the road from each candidate point: absorbs the few metres
 * OSM and the photogrammetry can disagree by, and parked cars and kerbs.
 */
const OFFSETS = [0, 4, -4, 8, -8];
/** Ground must be at least this flat (normal y) to land on. */
const FLAT_Y = 0.9;
/** The surface search runs from this far above the car's height (m)… */
const LOOK_ABOVE = 100;
/** …down this far (m). */
const LOOK_DEPTH = 300;
/** Each wheel needs ground within this (m) of the height at the centre. */
const WHEEL_TOLERANCE = 0.6;
/**
 * Nothing may stand in the car's footprint between these heights (m) above the
 * road: parked cars baked into the mesh, bollards, kerb-side walls. Below is
 * kerbs and mesh noise; above is awnings and canopy the car fits under.
 */
const CLEAR_FROM = 0.25;
const CLEAR_TO = 2.2;
/** Heights (m) of the horizontal wall rays from the centre toward the corners. */
const WALL_HEIGHTS = [0.6, 1.3];
/** A ray hit steeper than this (normal y) is a wall. */
const WALL_Y = 0.7;
/**
 * A road on another level within this (m) of a spot makes its surface
 * ambiguous: a deck's half-width plus the car's.
 */
const STACK_RADIUS = 7;
/**
 * Just beside the car (m from the centreline, past the roof of a bus under
 * it), ground this much (m) lower on both sides means the spot is on top of
 * something narrow: a van, bus or lorry baked into the mesh, a strut. The mesh
 * has no surface under them, so even the lowest hit can be a roof.
 */
const PERCH_SIDE = 2.5;
const PERCH_DROP = 1.5;
/** How far below the spot (m) the perch check looks for ground. */
const PERCH_DEPTH = 12;
/**
 * Further out (m), ground this much (m) lower on both sides, behind a wall,
 * means a road at ground level is on a roof: an arcade or canopy over the
 * mapped road, filled in down to the ground. Walls, not slopes, so an
 * embankment isn't a roof.
 */
const ROOF_SIDE = 8;
const ROOF_DROP = 3;
/** How far below the spot (m) the roof check looks for ground. */
const ROOF_DEPTH = 50;

export type RoadVerdict =
  | 'ok'
  /** The offset ran past the end of the mapped road. */
  | 'off the end'
  /** No collision mesh at all: tiles not loaded there. */
  | 'not loaded'
  /** A road on another level crosses here: which surface is this one's is a guess. */
  | 'stacked'
  | 'no flat ground'
  /** On a vehicle or other narrow thing, with the road well below on both sides. */
  | 'perched'
  /** A ground-level road whose only surface here is a roof. */
  | 'roof'
  /** A wheel corner has no ground near the centre's height. */
  | 'uneven'
  /** Something in the footprint between CLEAR_FROM and CLEAR_TO. */
  | 'obstacle'
  | 'wall';

/** One spot tried, for traces and the debug overlay. */
export interface RoadTry {
  x: number;
  /** Road surface height found, if any. */
  y: number | null;
  z: number;
  cls: RoadClass;
  bridge: boolean;
  /** Metres along the road from the candidate point. */
  offset: number;
  /** Distance (m) from the car to the candidate point. */
  distance: number;
  verdict: RoadVerdict;
}

export interface RoadSpot {
  /** On the road surface. */
  pos: Vector3;
  heading: number;
  road: RoadPoint;
}

export interface RoadSearch {
  spot: RoadSpot | null;
  /** Every spot tried, in order; the last is the spot when one was found. */
  tried: RoadTry[];
}

type Rays = Pick<Collider, 'castColumn' | 'castWide'>;
type Footprint = Pick<ChassisSpec, 'cornerX' | 'cornerZ' | 'halfWidth' | 'halfLength'>;

const _origin = new Vector3();
const _dir = new Vector3();

/**
 * The nearest clear spot on a drivable road to `from`, facing along the road
 * in the direction closest to `heading`, or null if none within RADII checks out.
 */
export function findRoadSpot(roads: RoadNetwork, collider: Rays, from: Vector3, heading: number, car: Footprint): RoadSearch {
  const tried: RoadTry[] = [];
  const done = new Set<string>();
  for (const radius of RADII) {
    for (const c of roads.nearest(from.x, from.z, radius, MAX_CANDIDATES)) {
      // The wider search returns the near candidates again. Stacked roads share x, z.
      const id = `${c.x.toFixed(1)},${c.z.toFixed(1)},${roadLevel(c)}`;
      if (done.has(id)) continue;
      done.add(id);
      for (const offset of OFFSETS) {
        const p = offset ? roads.along(c, offset) : c;
        const t: RoadTry = { x: p?.x ?? c.x, y: null, z: p?.z ?? c.z, cls: c.cls, bridge: c.bridge, offset, distance: c.distance, verdict: 'off the end' };
        tried.push(t);
        if (!p) continue;
        const h = roadHeading(p, heading);
        t.verdict = checkSpot(roads, collider, p, h, from.y, car, t);
        if (t.verdict === 'ok') return { spot: { pos: new Vector3(p.x, t.y!, p.z), heading: h, road: p }, tried };
      }
    }
  }
  return { spot: null, tried };
}

/** The heading (ψ, 0 = −Z) along the road closest to `heading`. */
function roadHeading(p: RoadPoint, heading: number): number {
  const h = Math.atan2(-p.dirX, -p.dirZ);
  const d = h - heading;
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) <= Math.PI / 2 ? h : Math.atan2(p.dirX, p.dirZ);
}

function checkSpot(
  roads: RoadNetwork,
  collider: Rays,
  p: RoadPoint,
  heading: number,
  carY: number,
  car: Footprint,
  t: RoadTry,
): RoadVerdict {
  // A bridge (or anything mapped above ground level) is the topmost deck;
  // anything else is the lowest surface, under overpasses, trees and roofs.
  // Neither holds where a third level crosses: a deck above this one's, a
  // sunken road below this street.
  const elevated = roadLevel(p) > 0;
  if (roads.levelNear(p, STACK_RADIUS, elevated ? 1 : -1)) return 'stacked';
  const hits = collider.castColumn(p.x, p.z, carY + LOOK_ABOVE, LOOK_DEPTH);
  if (!hits.length) return 'not loaded';
  const flat = hits.filter((h) => h.normal.y > FLAT_Y);
  if (!flat.length) return 'no flat ground';
  const y = (elevated ? flat[0] : flat[flat.length - 1]).point.y;
  t.y = y;

  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  // Car space → world, as in CarPhysics.solveGround.
  const wx = (cx: number, cz: number) => p.x + cx * cos + cz * sin;
  const wz = (cx: number, cz: number) => p.z - cx * sin + cz * cos;

  // The other checks are all relative to y, so they can't tell a vehicle's
  // roof or a building's from the road: look at the ground beside it.
  const perched = [-PERCH_SIDE, PERCH_SIDE].every((cx) => {
    const g = nearestFlat(collider.castColumn(wx(cx, 0), wz(cx, 0), y + CLEAR_TO, CLEAR_TO + PERCH_DEPTH), y);
    // No surface at all is inside a building beside a narrow street, not a drop.
    return g !== null && g < y - PERCH_DROP;
  });
  if (perched) return 'perched';
  if (!elevated && [-ROOF_SIDE, ROOF_SIDE].every((cx) => droppedBehindWall(collider, wx(cx, 0), wz(cx, 0), p, y))) return 'roof';

  // Wheels, in CarPhysics' corner order: front left, front right, rear left, rear right.
  const { cornerX: kx, cornerZ: kz } = car;
  const wheels: Array<[number, number]> = [
    [-kx, -kz],
    [kx, -kz],
    [-kx, kz],
    [kx, kz],
  ];
  const wheelY: number[] = [];
  for (const [cx, cz] of wheels) {
    const ground = nearestFlat(collider.castColumn(wx(cx, cz), wz(cx, cz), y + CLEAR_TO, CLEAR_TO + WHEEL_TOLERANCE + 1), y);
    if (ground === null || Math.abs(ground - y) > WHEEL_TOLERANCE) return 'uneven';
    wheelY.push(ground);
  }
  // The road's plane under the car, from the wheels, so a hill isn't an obstacle.
  const mean = (wheelY[0] + wheelY[1] + wheelY[2] + wheelY[3]) / 4;
  const slopeX = (wheelY[1] + wheelY[3] - wheelY[0] - wheelY[2]) / (4 * kx);
  const slopeZ = (wheelY[2] + wheelY[3] - wheelY[0] - wheelY[1]) / (4 * kz);
  const plane = (cx: number, cz: number) => mean + slopeX * cx + slopeZ * cz;

  const { halfWidth: hw, halfLength: hl } = car;
  for (const cx of [-hw, 0, hw]) {
    for (const cz of [-hl, 0, hl]) {
      const g = plane(cx, cz);
      if (collider.castColumn(wx(cx, cz), wz(cx, cz), g + CLEAR_TO, CLEAR_TO - CLEAR_FROM).length) return 'obstacle';
    }
  }

  for (const lift of WALL_HEIGHTS) {
    _origin.set(p.x, plane(0, 0) + lift, p.z);
    for (const [cx, cz] of [
      [-hw, -hl],
      [hw, -hl],
      [-hw, hl],
      [hw, hl],
    ]) {
      const dx = wx(cx, cz) - p.x;
      const dz = wz(cx, cz) - p.z;
      const len = Math.hypot(dx, dz);
      _dir.set(dx / len, 0, dz / len);
      const hit = collider.castWide(_origin, _dir, len + 0.2);
      if (hit && Math.abs(hit.normal.y) < WALL_Y) return 'wall';
    }
  }
  return 'ok';
}

/**
 * Whether the ground at (x, z) is more than ROOF_DROP below `y` with a wall
 * between it and the spot `p`, facing it.
 */
function droppedBehindWall(collider: Rays, x: number, z: number, p: RoadPoint, y: number): boolean {
  const ground = collider.castColumn(x, z, y + CLEAR_TO, CLEAR_TO + ROOF_DEPTH).filter((h) => h.normal.y > FLAT_Y);
  const low = ground.length ? ground[ground.length - 1].point.y : null;
  if (low === null || low > y - ROOF_DROP) return false;
  const dx = p.x - x;
  const dz = p.z - z;
  const len = Math.hypot(dx, dz);
  _origin.set(x, low + 1, z);
  _dir.set(dx / len, 0, dz / len);
  const hit = collider.castWide(_origin, _dir, len);
  return !!hit && Math.abs(hit.normal.y) < WALL_Y;
}

/** Height of the flat-enough hit closest to `y`, or null. */
function nearestFlat(hits: RayHit[], y: number): number | null {
  let best: number | null = null;
  for (const h of hits) {
    if (h.normal.y < 0.8) continue;
    if (best === null || Math.abs(h.point.y - y) < Math.abs(best - y)) best = h.point.y;
  }
  return best;
}
