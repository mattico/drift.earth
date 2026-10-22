import { Box3, type Mesh } from 'three';

interface Entry {
  box: Box3;
  epoch: number;
}

const cache = new WeakMap<Mesh, Entry>();

/**
 * World-space AABB of a mesh, cached until `epoch` changes. Tile scenes never
 * move on their own; only a rebase moves them, so the caller bumps the epoch then.
 */
export function worldBox(mesh: Mesh, epoch: number): Box3 {
  let entry = cache.get(mesh);
  if (!entry) {
    entry = { box: new Box3(), epoch: -1 };
    cache.set(mesh, entry);
  }
  if (entry.epoch !== epoch) {
    const geom = mesh.geometry;
    if (!geom.boundingBox) geom.computeBoundingBox();
    mesh.updateWorldMatrix(true, false);
    entry.box.copy(geom.boundingBox!).applyMatrix4(mesh.matrixWorld);
    entry.epoch = epoch;
  }
  return entry.box;
}

export function overlapsColumn(box: Box3, x: number, z: number, radius: number): boolean {
  return x + radius >= box.min.x && x - radius <= box.max.x && z + radius >= box.min.z && z - radius <= box.max.z;
}
