import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  type Object3D,
  type PerspectiveCamera,
  type Vector3,
} from 'three';
import { overlapsColumn, worldBox } from './meshBounds';
import type { Geo, RebaseResult, World, WorldStatus } from './types';

const SIZE = 3000;
const BLOCK = 60;
const ROAD = 22;
const CITY_EXTENT = 420;
const PLAZA = 110;

/** Offline test track: an asphalt plain with city blocks and ramps. No API key needed. */
export class PracticeWorld implements World {
  readonly kind = 'practice' as const;
  readonly root: Object3D = new Group();
  private readonly colliders: Mesh[] = [];

  constructor() {
    const ground = new Mesh(new PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), new MeshBasicMaterial({ map: asphaltTexture() }));
    this.add(ground);

    const buildingMat = new MeshLambertMaterial({ color: 0xb8b2a7 });
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pitch = BLOCK + ROAD;
    for (let bx = -CITY_EXTENT; bx <= CITY_EXTENT; bx += pitch) {
      for (let bz = -CITY_EXTENT; bz <= CITY_EXTENT; bz += pitch) {
        if (Math.abs(bx) < PLAZA && Math.abs(bz) < PLAZA) continue;
        const h = 8 + rand() * 50;
        const b = new Mesh(new BoxGeometry(BLOCK, h, BLOCK), buildingMat);
        b.position.set(bx, h / 2, bz);
        // Known solid: skip the overpass test.
        b.userData.solid = true;
        this.add(b);
      }
    }

    const rampMat = new MeshLambertMaterial({ color: 0xe0a030 });
    const ramps: Array<[number, number, number]> = [
      [0, -60, 0],
      [55, 30, Math.PI / 2],
      [-55, 30, -Math.PI / 2],
    ];
    for (const [x, z, rot] of ramps) {
      const r = new Mesh(rampGeometry(8, 14, 2.2), rampMat);
      r.userData.solid = true;
      r.position.set(x, 0, z);
      r.rotation.y = rot;
      this.add(r);
    }
    this.root.updateMatrixWorld(true);
  }

  private add(mesh: Mesh): void {
    this.root.add(mesh);
    this.colliders.push(mesh);
  }

  collectColliders(x: number, z: number, radius: number, out: Mesh[]): void {
    for (const mesh of this.colliders) if (overlapsColumn(worldBox(mesh, 0), x, z, radius)) out.push(mesh);
  }

  hasCoverage(x: number, z: number): boolean {
    return Math.abs(x) < SIZE / 2 && Math.abs(z) < SIZE / 2;
  }

  update(camera: PerspectiveCamera, _focus: Vector3, _velocity: Vector3): void {
    camera.updateMatrixWorld();
  }

  maybeRebase(): RebaseResult | null {
    return null;
  }

  attribution(): string {
    return 'Practice track (offline)';
  }

  status(): WorldStatus {
    return { loading: false, progress: 1, fatal: null };
  }

  debugInfo(): string {
    return `practice colliders ${this.colliders.length}`;
  }

  stats(): Record<string, number> {
    return { colliders: this.colliders.length };
  }

  geo(): Geo | null {
    return null;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const m = mesh.material as MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
    });
  }
}

/** Wedge rising toward −Z in local space: `width` across, `length` long, `height` tall. */
function rampGeometry(width: number, length: number, height: number): BufferGeometry {
  const w = width / 2;
  const l = length / 2;
  // prettier-ignore
  const p = [
    -w, 0, l,   w, 0, l,   w, height, -l,
    -w, 0, l,   w, height, -l,   -w, height, -l,   // slope
    -w, 0, -l,  -w, height, -l,   w, height, -l,
    -w, 0, -l,   w, height, -l,   w, 0, -l,        // back wall
    -w, 0, l,  -w, height, -l,  -w, 0, -l,          // left side
     w, 0, l,   w, 0, -l,   w, height, -l,          // right side
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

function asphaltTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 50 + Math.random() * 30;
    ctx.fillStyle = `rgb(${v},${v},${v + 4})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 512, 512);
  ctx.setLineDash([24, 24]);
  ctx.strokeStyle = 'rgba(255,214,90,0.5)';
  ctx.beginPath();
  ctx.moveTo(256, 0);
  ctx.lineTo(256, 512);
  ctx.moveTo(0, 256);
  ctx.lineTo(512, 256);
  ctx.stroke();
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(SIZE / 40, SIZE / 40);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
