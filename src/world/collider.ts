import { BufferGeometry, Mesh, Raycaster, Vector3, type Intersection } from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { World } from './types';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

export interface RayHit {
  point: Vector3;
  /** World-space normal, flipped to face the ray origin. */
  normal: Vector3;
  distance: number;
  object: Mesh;
}

const MAX_SYNC_BUILDS = 3;
const DOWN = new Vector3(0, -1, 0);
const _origin = new Vector3();

/**
 * Raycasts against world meshes near the car. `prepare()` gathers candidate
 * meshes once per physics step so individual rays only test a handful.
 */
export class Collider {
  private readonly raycaster = new Raycaster();
  private readonly candidates: Mesh[] = [];
  private readonly scratch: Intersection[] = [];
  private readonly warmList: Mesh[] = [];
  private readonly column: Mesh[] = [];
  bvhBuilds = 0;
  bvhMs = 0;

  constructor(private readonly world: World) {}

  /** Gathers meshes around (x, z) and makes sure the closest ones have a BVH. */
  prepare(x: number, z: number, radius: number): void {
    this.candidates.length = 0;
    this.world.collectColliders(x, z, radius, this.candidates);
    let built = 0;
    for (const mesh of this.candidates) {
      if (!mesh.geometry.boundsTree && built < MAX_SYNC_BUILDS) {
        this.buildBVH(mesh);
        built++;
      }
    }
  }

  /** Builds at most one BVH per call for meshes in a wider ring, ahead of need. */
  warm(x: number, z: number, radius: number): void {
    this.warmList.length = 0;
    this.world.collectColliders(x, z, radius, this.warmList);
    for (const mesh of this.warmList) {
      if (!mesh.geometry.boundsTree) {
        this.buildBVH(mesh);
        return;
      }
    }
  }

  private buildBVH(mesh: Mesh): void {
    const t0 = performance.now();
    mesh.geometry.computeBoundsTree();
    this.bvhMs = performance.now() - t0;
    this.bvhBuilds++;
  }

  get candidateCount(): number {
    return this.candidates.length;
  }

  /** Nearest hit along the ray, or null. */
  cast(origin: Vector3, dir: Vector3, far: number, out?: RayHit): RayHit | null {
    const hits = this.intersect(origin, dir, far, true);
    if (hits.length === 0) return null;
    return toRayHit(hits[0], dir, out);
  }

  /** All hits along the ray, nearest first. */
  castAll(origin: Vector3, dir: Vector3, far: number): RayHit[] {
    return this.intersect(origin, dir, far, false).map((h) => toRayHit(h, dir));
  }

  /**
   * All hits straight down through (x, z) against any loaded mesh, not just the
   * prepared set — for looking a few tens of metres ahead.
   */
  castColumn(x: number, z: number, fromY: number, far: number): RayHit[] {
    this.column.length = 0;
    this.world.collectColliders(x, z, 0.5, this.column);
    for (const mesh of this.column) if (!mesh.geometry.boundsTree) this.buildBVH(mesh);
    _origin.set(x, fromY, z);
    return this.intersect(_origin, DOWN, far, false, this.column).map((h) => toRayHit(h, DOWN));
  }

  /**
   * Nearest hit along a ray against any loaded mesh near the segment, not just
   * the prepared set — for looking several metres ahead.
   */
  castWide(origin: Vector3, dir: Vector3, far: number): RayHit | null {
    this.column.length = 0;
    const mx = origin.x + dir.x * far * 0.5;
    const mz = origin.z + dir.z * far * 0.5;
    this.world.collectColliders(mx, mz, far * 0.5 + 0.5, this.column);
    for (const mesh of this.column) if (!mesh.geometry.boundsTree) this.buildBVH(mesh);
    const hits = this.intersect(origin, dir, far, true, this.column);
    return hits.length ? toRayHit(hits[0], dir) : null;
  }

  private intersect(origin: Vector3, dir: Vector3, far: number, firstOnly: boolean, meshes = this.candidates): Intersection[] {
    const rc = this.raycaster;
    rc.set(origin, dir);
    rc.near = 0;
    rc.far = far;
    rc.firstHitOnly = firstOnly;
    const hits = this.scratch;
    hits.length = 0;
    for (const mesh of meshes) mesh.raycast(rc, hits);
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }
}

function toRayHit(h: Intersection, dir: Vector3, out?: RayHit): RayHit {
  const hit = out ?? { point: new Vector3(), normal: new Vector3(), distance: 0, object: h.object as Mesh };
  hit.point.copy(h.point);
  hit.distance = h.distance;
  hit.object = h.object as Mesh;
  if (h.face) {
    hit.normal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    if (hit.normal.dot(dir) > 0) hit.normal.negate();
  } else {
    hit.normal.copy(dir).negate();
  }
  return hit;
}
