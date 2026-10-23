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
  Shape,
  ShapeGeometry,
  type Object3D,
  type PerspectiveCamera,
  type Vector3,
} from 'three';
import type { SurfaceId } from '../car/surfaces';
import { overlapsColumn, worldBox } from './meshBounds';
import { RoadNetwork, type RoadWay } from './roads';
import type { Geo, RebaseResult, World, WorldStatus } from './types';

const SIZE = 3000;
const BLOCK = 60;
const ROAD = 22;
const CITY_EXTENT = 420;
const PLAZA = 110;

/**
 * A patch of ground painted on the plain: a rectangle, an ellipse, or an oval
 * track (a band `width` wide round a stadium with straights 2·`half` long and
 * ends of radius `r`).
 */
type Patch = { surface: SurfaceId } & (
  | { kind: 'rect'; x0: number; x1: number; z0: number; z1: number }
  | { kind: 'ellipse'; x: number; z: number; rx: number; rz: number }
  | { kind: 'oval'; x: number; z: number; half: number; r: number; width: number }
);

/**
 * Surface test ground east of the city. A gravel road carries on from the end
 * of the street at z = 31 (the plaza's southern main road) to a gravel oval
 * with an asphalt infield, crossing a stream (deep: a car sinks in it) at a
 * ford; around it a cobbled straight, a sand pit, a grass field and a pond
 * (deep too). They are only paint on the flat plain: surfaceAt() answers from
 * the same shapes. Later patches lie on top. Straight edges stay off the
 * plain's 20 m paint lines, which would show along them.
 */
const GRAVEL_ROAD = { surface: 'gravel', kind: 'rect', x0: 452, x1: 612, z0: 27, z1: 35 } as const;
const OVAL = { surface: 'gravel', kind: 'oval', x: 690, z: 31, half: 40, r: 32, width: 15 } as const;
const PATCHES: Patch[] = [
  GRAVEL_ROAD,
  OVAL,
  { surface: 'cobbles', kind: 'rect', x0: 470, x1: 775, z0: -45, z1: -33 },
  { surface: 'sand', kind: 'ellipse', x: 700, z: 130, rx: 45, rz: 30 },
  { surface: 'grass', kind: 'rect', x0: 805, x1: 955, z0: -15, z1: 75 },
  { surface: 'water', kind: 'ellipse', x: 880, z: 150, rx: 35, rz: 25 },
  // The stream, then the ford over it: a little wider than the road, so its edges stay shallow.
  { surface: 'water', kind: 'rect', x0: 556, x1: 564, z0: -25, z1: 95 },
  { surface: 'ford', kind: 'rect', x0: 556, x1: 564, z0: 25, z1: 37 },
];

function inPatch(p: Patch, x: number, z: number): boolean {
  switch (p.kind) {
    case 'rect':
      return x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1;
    case 'ellipse':
      return ((x - p.x) / p.rx) ** 2 + ((z - p.z) / p.rz) ** 2 <= 1;
    case 'oval':
      return Math.abs(Math.hypot(Math.max(Math.abs(x - p.x) - p.half, 0), z - p.z) - p.r) <= p.width / 2;
  }
}

/** Offline test track: an asphalt plain with city blocks and ramps. No API key needed. */
export class PracticeWorld implements World {
  readonly kind = 'practice' as const;
  readonly root: Object3D = new Group();
  private readonly colliders: Mesh[] = [];
  readonly roads = practiceRoads();

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

    // Surface patches: visual only (the plain is the collider), lying on it,
    // pulled forward in depth so they never flicker, and drawn after it without
    // writing depth, so what draws over the plain (the debug overlay's ground
    // layers) draws over them too.
    const mats = new Map<SurfaceId, MeshBasicMaterial>();
    for (const p of PATCHES) {
      let mat = mats.get(p.surface);
      if (!mat) {
        mat = new MeshBasicMaterial({
          map: surfaceTexture(p.surface),
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -4,
        });
        mats.set(p.surface, mat);
      }
      const patch = new Mesh(new ShapeGeometry(patchShape(p), 48).rotateX(-Math.PI / 2), mat);
      patch.renderOrder = 1;
      this.root.add(patch);
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

  surfaceAt(x: number, z: number): SurfaceId {
    for (let i = PATCHES.length - 1; i >= 0; i--) if (inPatch(PATCHES[i], x, z)) return PATCHES[i].surface;
    return 'asphalt';
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

/**
 * The streets between the blocks, as a road network, so the road teleport
 * works offline: one centreline down the middle of each gap, the two through
 * the plaza as main roads. The gravel road and oval are unpaved tracks.
 */
function practiceRoads(): RoadNetwork {
  const pitch = BLOCK + ROAD;
  const lines: number[] = [];
  for (let c = -CITY_EXTENT - pitch / 2; c <= CITY_EXTENT + pitch / 2; c += pitch) lines.push(c);
  const from = lines[0];
  const to = lines[lines.length - 1];
  const ways: RoadWay[] = [];
  for (const c of lines) {
    const cls = Math.abs(c) < PLAZA / 2 ? 'primary' : c === from || c === to ? 'secondary' : 'minor';
    const way = (xz: number[]): RoadWay => ({ xz: new Float64Array(xz), cls, bridge: false, layer: 0, paved: true, service: null });
    ways.push(way([c, from, c, to]), way([from, c, to, c]));
  }
  const track = (xz: number[]): RoadWay => ({ xz: new Float64Array(xz), cls: 'track', bridge: false, layer: 0, paved: false, service: null });
  ways.push(track([to, (GRAVEL_ROAD.z0 + GRAVEL_ROAD.z1) / 2, OVAL.x - OVAL.half - OVAL.r, OVAL.z]));
  // The oval's centreline, a point every 5° round each end.
  const loop: number[] = [];
  for (const end of [1, -1]) {
    for (let a = -90; a <= 90; a += 5) {
      const t = (a * Math.PI) / 180;
      loop.push(OVAL.x + end * (OVAL.half + OVAL.r * Math.cos(t)), OVAL.z + end * OVAL.r * Math.sin(t));
    }
  }
  loop.push(loop[0], loop[1]);
  ways.push(track(loop));
  return new RoadNetwork(ways);
}

/** A patch's outline in the XY plane with y = −z, so rotateX(−90°) lays it on the ground; its UVs are then metres. */
function patchShape(p: Patch): Shape {
  const s = new Shape();
  switch (p.kind) {
    case 'rect':
      s.moveTo(p.x0, -p.z0).lineTo(p.x1, -p.z0).lineTo(p.x1, -p.z1).lineTo(p.x0, -p.z1).closePath();
      break;
    case 'ellipse':
      s.absellipse(p.x, -p.z, p.rx, p.rz, 0, 2 * Math.PI, false, 0);
      break;
    case 'oval': {
      const stadium = (path: Shape, r: number) => {
        path.moveTo(p.x - p.half, -p.z - r);
        path.lineTo(p.x + p.half, -p.z - r);
        path.absarc(p.x + p.half, -p.z, r, -Math.PI / 2, Math.PI / 2, false);
        path.lineTo(p.x - p.half, -p.z + r);
        path.absarc(p.x - p.half, -p.z, r, Math.PI / 2, (3 * Math.PI) / 2, false);
        return path;
      };
      stadium(s, p.r + p.width / 2);
      s.holes.push(stadium(new Shape(), p.r - p.width / 2));
      break;
    }
  }
  return s;
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

/** Metres one repeat of each patch texture covers. */
const TEXTURE_METRES: Record<SurfaceId, number> = { asphalt: 40, gravel: 4, grass: 6, sand: 8, cobbles: 2, water: 12, ford: 6 };

/** A tiling texture for a surface patch, like asphaltTexture(): a base colour and random marks. */
function surfaceTexture(surface: SurfaceId): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const r = Math.random;
  const dots = (n: number, colour: () => string) => {
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = colour();
      ctx.fillRect(r() * 256, r() * 256, 2, 2);
    }
  };
  switch (surface) {
    case 'gravel':
      ctx.fillStyle = '#8f8573';
      ctx.fillRect(0, 0, 256, 256);
      dots(5000, () => {
        const v = 100 + r() * 90;
        return `rgb(${v + 10},${v},${v - 15})`;
      });
      break;
    case 'grass':
      ctx.fillStyle = '#4c7a2e';
      ctx.fillRect(0, 0, 256, 256);
      dots(6000, () => `rgb(${50 + r() * 40},${100 + r() * 60},${30 + r() * 25})`);
      break;
    case 'sand':
      ctx.fillStyle = '#d6c08a';
      ctx.fillRect(0, 0, 256, 256);
      dots(3000, () => `rgb(${200 + r() * 40},${180 + r() * 35},${120 + r() * 30})`);
      // Wind ripples.
      ctx.strokeStyle = 'rgba(150,120,70,0.25)';
      ctx.lineWidth = 2;
      for (let y = 8; y < 256; y += 16) {
        ctx.beginPath();
        for (let x = 0; x <= 256; x += 8) ctx.lineTo(x, y + 4 * Math.sin((x / 256) * 4 * Math.PI));
        ctx.stroke();
      }
      break;
    case 'cobbles': {
      // Setts in staggered rows, 25 cm each.
      ctx.fillStyle = '#3d3934';
      ctx.fillRect(0, 0, 256, 256);
      const w = 256 / 8;
      for (let row = 0; row < 8; row++) {
        for (let col = -1; col < 8; col++) {
          const v = 95 + r() * 45;
          ctx.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
          ctx.beginPath();
          ctx.roundRect(col * w + (row % 2) * (w / 2) + 2, row * w + 2, w - 4, w - 4, 6);
          ctx.fill();
        }
      }
      break;
    }
    case 'water':
    case 'ford':
      // A ford: the gravel bed showing through a shallow, lighter sheet of water.
      if (surface === 'ford') {
        ctx.fillStyle = '#8f8573';
        ctx.fillRect(0, 0, 256, 256);
        dots(3000, () => {
          const v = 100 + r() * 90;
          return `rgb(${v + 10},${v},${v - 15})`;
        });
        ctx.fillStyle = 'rgba(60,140,170,0.55)';
      } else ctx.fillStyle = '#2d6a86';
      ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = 'rgba(200,235,255,0.35)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 40; i++) {
        const x = r() * 256;
        const y = r() * 256;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + 10, y - 4, x + 20 + r() * 20, y);
        ctx.stroke();
      }
      break;
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(1 / TEXTURE_METRES[surface], 1 / TEXTURE_METRES[surface]);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
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
