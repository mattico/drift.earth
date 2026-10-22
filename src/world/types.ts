import type { Matrix4, Mesh, Object3D, PerspectiveCamera, Vector3 } from 'three';

export interface RebaseResult {
  /** Maps old world-space positions to new world-space positions. */
  matrix: Matrix4;
  /** Heading change (radians, about +Y) to apply to directions and headings. */
  yaw: number;
}

/** Geodetic position: degrees, and metres above the WGS84 ellipsoid. */
export interface Geo {
  lat: number;
  lon: number;
  height: number;
}

export interface WorldStatus {
  loading: boolean;
  progress: number;
  /** Set when the world can no longer load (bad key, quota, network). */
  fatal: string | null;
}

/**
 * Something the car can drive on. World space is a local tangent frame:
 * +X east, +Y up, −Z north.
 */
export interface World {
  readonly kind: 'tiles' | 'practice';
  readonly root: Object3D;
  /** Appends meshes whose world AABB overlaps the vertical column around (x, z). */
  collectColliders(x: number, z: number, radius: number, out: Mesh[]): void;
  /** True if collision geometry is loaded somewhere over (x, z). */
  hasCoverage(x: number, z: number): boolean;
  /** Per-frame update after the camera moved. `focus` is the point to keep detailed. */
  update(camera: PerspectiveCamera, focus: Vector3, velocity: Vector3): void;
  /** Re-centres the frame on `p` when it drifts far from the origin. */
  maybeRebase(p: Vector3): RebaseResult | null;
  attribution(): string;
  status(): WorldStatus;
  /** Optional debug readout. */
  debugInfo(): string;
  /** Numeric counters for traces (tile counts, load errors…). */
  stats(): Record<string, number>;
  /** Real-world position of a world-space point, if the world has one. */
  geo(p: Vector3): Geo | null;
  dispose(): void;
}
