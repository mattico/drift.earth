import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Points,
  ShaderMaterial,
  Vector3,
  type Matrix4,
} from 'three';
import { LOOSE, type SurfaceId } from './surfaces';

const SKID_SEGMENTS = 3000;
const SKID_WIDTH = 0.24;
const SKID_SPACING = 0.3;

/**
 * What a sliding tire leaves on each surface (RGBA): rubber on hard ground,
 * churned stones, sand and torn turf on soft; nothing in water.
 */
const MARKS: Record<SurfaceId, readonly [number, number, number, number] | null> = {
  asphalt: [0.047, 0.047, 0.047, 0.5],
  cobbles: [0.047, 0.047, 0.047, 0.4],
  gravel: [0.3, 0.26, 0.2, 0.45],
  grass: [0.2, 0.16, 0.1, 0.55],
  sand: [0.55, 0.45, 0.3, 0.5],
  water: null,
  ford: null,
};

/** Ring buffer of quads forming one ribbon per wheel. */
class SkidTrail {
  readonly mesh: Mesh;
  private readonly pos: Float32Array;
  private readonly attr: BufferAttribute;
  private readonly col: Float32Array;
  private readonly colAttr: BufferAttribute;
  private head = 0;
  private count = 0;
  private hasLast = false;
  private readonly lastL = new Vector3();
  private readonly lastR = new Vector3();
  private readonly lastC = new Vector3();

  constructor(material: MeshBasicMaterial) {
    this.pos = new Float32Array(SKID_SEGMENTS * 6 * 3);
    this.attr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.col = new Float32Array(SKID_SEGMENTS * 6 * 4);
    this.colAttr = new BufferAttribute(this.col, 4).setUsage(DynamicDrawUsage);
    const geom = new BufferGeometry();
    geom.setAttribute('position', this.attr);
    geom.setAttribute('color', this.colAttr);
    geom.setDrawRange(0, 0);
    this.mesh = new Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Extends the ribbon to `p` (ground point) heading along `dir`, in colour `rgba`. */
  add(p: Vector3, dir: Vector3, rgba: readonly number[]): void {
    const sx = -dir.z * (SKID_WIDTH / 2);
    const sz = dir.x * (SKID_WIDTH / 2);
    if (!this.hasLast) {
      this.lastC.copy(p);
      this.lastL.set(p.x - sx, p.y, p.z - sz);
      this.lastR.set(p.x + sx, p.y, p.z + sz);
      this.hasLast = true;
      return;
    }
    if (p.distanceToSquared(this.lastC) < SKID_SPACING * SKID_SPACING) return;
    const l = new Vector3(p.x - sx, p.y, p.z - sz);
    const r = new Vector3(p.x + sx, p.y, p.z + sz);
    const o = this.head * 18;
    const a = this.pos;
    const put = (i: number, v: Vector3) => {
      a[o + i * 3] = v.x;
      a[o + i * 3 + 1] = v.y;
      a[o + i * 3 + 2] = v.z;
    };
    put(0, this.lastL);
    put(1, this.lastR);
    put(2, r);
    put(3, this.lastL);
    put(4, r);
    put(5, l);
    this.attr.clearUpdateRanges();
    this.attr.addUpdateRange(o, 18);
    this.attr.needsUpdate = true;
    const oc = this.head * 24;
    for (let i = 0; i < 6; i++) this.col.set(rgba, oc + i * 4);
    this.colAttr.clearUpdateRanges();
    this.colAttr.addUpdateRange(oc, 24);
    this.colAttr.needsUpdate = true;
    this.head = (this.head + 1) % SKID_SEGMENTS;
    this.count = Math.min(SKID_SEGMENTS, this.count + 1);
    this.mesh.geometry.setDrawRange(0, this.count * 6);
    this.lastL.copy(l);
    this.lastR.copy(r);
    this.lastC.copy(p);
  }

  lift(): void {
    this.hasLast = false;
  }

  clear(): void {
    this.head = this.count = 0;
    this.hasLast = false;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  applyMatrix(m: Matrix4): void {
    const v = new Vector3();
    for (let i = 0; i < this.count * 6; i++) {
      v.fromArray(this.pos, i * 3).applyMatrix4(m);
      v.toArray(this.pos, i * 3);
    }
    this.lastL.applyMatrix4(m);
    this.lastR.applyMatrix4(m);
    this.lastC.applyMatrix4(m);
    this.attr.clearUpdateRanges();
    this.attr.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

/** What the tires throw up: rubber smoke, dust (stones, sand), turf clods, spray. */
export type PuffKind = 'smoke' | 'dust' | 'sand' | 'turf' | 'spray';
const PUFF_KINDS: PuffKind[] = ['smoke', 'dust', 'sand', 'turf', 'spray'];

interface Puff {
  color: [number, number, number];
  alpha: number;
  /** Sprite size (m): base and random extra, and how much it grows over its life (× base). */
  size: number;
  sizeJitter: number;
  grow: number;
  life: number;
  /** Launch: upward speed and random extra, the share of the car's velocity it keeps, sideways scatter. */
  rise: number;
  riseJitter: number;
  carry: number;
  scatter: number;
  gravity: number;
  /** Air drag (1/s). */
  drag: number;
}

const PUFFS: Record<PuffKind, Puff> = {
  smoke: { color: [0.88, 0.88, 0.88], alpha: 0.55, size: 1.2, sizeJitter: 0.8, grow: 2.4, life: 1.3, rise: 0.8, riseJitter: 0.6, carry: 0.25, scatter: 1, gravity: 0, drag: 1.5 },
  // A gravel road's dust hangs in the air behind the car: paler than the
  // stones, or it vanishes against them.
  dust: { color: [0.84, 0.78, 0.66], alpha: 0.55, size: 1.6, sizeJitter: 1.2, grow: 3.5, life: 2.4, rise: 0.4, riseJitter: 0.6, carry: 0.15, scatter: 1.4, gravity: 0, drag: 1 },
  sand: { color: [0.84, 0.74, 0.54], alpha: 0.45, size: 1.2, sizeJitter: 0.8, grow: 2.5, life: 1.8, rise: 0.6, riseJitter: 0.8, carry: 0.2, scatter: 1.4, gravity: 1.5, drag: 1.2 },
  // Clods of turf and mud: small, solid, thrown up and falling back.
  turf: { color: [0.25, 0.3, 0.14], alpha: 0.95, size: 0.22, sizeJitter: 0.2, grow: 0, life: 0.9, rise: 2, riseJitter: 1.8, carry: 0.35, scatter: 1.6, gravity: 9.8, drag: 0.5 },
  spray: { color: [0.86, 0.92, 0.96], alpha: 0.6, size: 0.35, sizeJitter: 0.4, grow: 1.8, life: 0.8, rise: 1.6, riseJitter: 1.6, carry: 0.3, scatter: 1.8, gravity: 9.8, drag: 0.8 },
};

const PUFF_MAX = 900;

const puffVertex = /* glsl */ `
  attribute float aAge;
  attribute float aLife;
  attribute float aSize;
  attribute float aGrow;
  attribute vec4 aColor;
  varying vec4 vColor;
  uniform float uScale;
  void main() {
    if (aAge < 0.0) {
      // Dead or unused slot: push it off-screen instead of rasterising a discarded sprite.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float t = clamp(aAge / aLife, 0.0, 1.0);
    vColor = vec4(aColor.rgb, (1.0 - t) * aColor.a);
    gl_PointSize = aSize * (0.6 + aGrow * t) * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const puffFragment = /* glsl */ `
  varying vec4 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.0, length(d)) * vColor.a;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor.rgb, a);
  }
`;

/** One pool of sprites for every kind of puff: each slot carries its own look and motion. */
class Puffs {
  readonly points: Points;
  private readonly pos = new Float32Array(PUFF_MAX * 3);
  private readonly vel = new Float32Array(PUFF_MAX * 3);
  private readonly age = new Float32Array(PUFF_MAX).fill(-1);
  private readonly life = new Float32Array(PUFF_MAX).fill(1);
  private readonly size = new Float32Array(PUFF_MAX);
  private readonly grow = new Float32Array(PUFF_MAX);
  private readonly color = new Float32Array(PUFF_MAX * 4);
  private readonly kind = new Uint8Array(PUFF_MAX);
  private next = 0;
  readonly material: ShaderMaterial;

  constructor() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    g.setAttribute('aAge', new BufferAttribute(this.age, 1).setUsage(DynamicDrawUsage));
    for (const [name, a, n] of [
      ['aLife', this.life, 1],
      ['aSize', this.size, 1],
      ['aGrow', this.grow, 1],
      ['aColor', this.color, 4],
    ] as const) {
      g.setAttribute(name, new BufferAttribute(a, n).setUsage(DynamicDrawUsage));
    }
    this.material = new ShaderMaterial({
      vertexShader: puffVertex,
      fragmentShader: puffFragment,
      uniforms: { uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.points = new Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  emit(kind: PuffKind, p: Vector3, v: Vector3): void {
    const k = PUFFS[kind];
    const i = this.next;
    this.next = (this.next + 1) % PUFF_MAX;
    const r = Math.random;
    this.pos[i * 3] = p.x + (r() - 0.5) * 0.3;
    this.pos[i * 3 + 1] = p.y + 0.15;
    this.pos[i * 3 + 2] = p.z + (r() - 0.5) * 0.3;
    this.vel[i * 3] = v.x * k.carry + (r() - 0.5) * k.scatter;
    this.vel[i * 3 + 1] = k.rise + r() * k.riseJitter;
    this.vel[i * 3 + 2] = v.z * k.carry + (r() - 0.5) * k.scatter;
    this.age[i] = 0;
    this.life[i] = k.life * (0.8 + 0.4 * r());
    this.size[i] = k.size + r() * k.sizeJitter;
    this.grow[i] = k.grow;
    this.color.set([...k.color, k.alpha], i * 4);
    this.kind[i] = PUFF_KINDS.indexOf(kind);
    const a = this.points.geometry.attributes;
    for (const n of ['aLife', 'aSize', 'aGrow', 'aColor']) (a[n] as BufferAttribute).needsUpdate = true;
  }

  update(dt: number): void {
    for (let i = 0; i < PUFF_MAX; i++) {
      if (this.age[i] < 0) continue;
      this.age[i] += dt;
      if (this.age[i] > this.life[i]) {
        this.age[i] = -1;
        continue;
      }
      const k = PUFFS[PUFF_KINDS[this.kind[i]]];
      const drag = Math.exp(-dt * k.drag);
      this.vel[i * 3 + 1] -= k.gravity * dt;
      for (let c = 0; c < 3; c++) {
        this.vel[i * 3 + c] *= drag;
        this.pos[i * 3 + c] += this.vel[i * 3 + c] * dt;
      }
    }
    const a = this.points.geometry.attributes;
    (a.position as BufferAttribute).needsUpdate = true;
    (a.aAge as BufferAttribute).needsUpdate = true;
  }

  /** Live puffs of each kind (scenario checks). */
  counts(): Record<PuffKind, number> {
    const out = Object.fromEntries(PUFF_KINDS.map((k) => [k, 0])) as Record<PuffKind, number>;
    for (let i = 0; i < PUFF_MAX; i++) if (this.age[i] >= 0) out[PUFF_KINDS[this.kind[i]]]++;
    return out;
  }

  clear(): void {
    this.age.fill(-1);
    (this.points.geometry.attributes.aAge as BufferAttribute).needsUpdate = true;
  }

  applyMatrix(m: Matrix4): void {
    const v = new Vector3();
    for (let i = 0; i < PUFF_MAX; i++) {
      v.fromArray(this.pos, i * 3).applyMatrix4(m);
      v.toArray(this.pos, i * 3);
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

export interface WheelSample {
  point: Vector3; // ground contact point, world
  sliding: number; // 0..1 how hard the tire is sliding
  surface: SurfaceId;
  /** A driven or rear wheel: the one whose wake trails dust and spray behind a rolling car. */
  trailing: boolean;
}

/** Puffs a second per wheel just rolling at `speed` (m/s) over a surface, before any sliding. */
function rollingRate(surface: SurfaceId, speed: number): number {
  if (LOOSE.has(surface)) return speed > 3 ? 6 + speed * 0.9 : 0;
  if (surface === 'water' || surface === 'ford') return speed > 1 ? 8 + speed * 2.5 : 0;
  return 0;
}

/** What a wheel throws up on `surface`. */
function puffOn(surface: SurfaceId): PuffKind {
  switch (surface) {
    case 'gravel':
      return 'dust';
    case 'sand':
      return 'sand';
    case 'grass':
      return 'turf';
    case 'water':
    case 'ford':
      return 'spray';
    default:
      return 'smoke';
  }
}

/**
 * Skid marks and what the tires throw up, one trail per wheel (rear pair, then
 * front): rubber smoke and black marks on hard ground; dust, sand, clods or
 * spray and ruts the colour of the ground on soft. Loose ground and water throw
 * some up just rolling, more sliding.
 */
export class TireEffects {
  readonly root = new Group();
  private readonly trails: SkidTrail[];
  private readonly puffs = new Puffs();
  private readonly skidMat = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private puffAcc = [0, 0, 0, 0];

  constructor() {
    this.trails = this.puffAcc.map(() => new SkidTrail(this.skidMat));
    for (const t of this.trails) this.root.add(t.mesh);
    this.root.add(this.puffs.points);
  }

  /** `dir` is the car's horizontal travel direction (unit). */
  update(dt: number, wheels: WheelSample[], dir: Vector3, velocity: Vector3, pixelScale: number): void {
    this.puffs.material.uniforms.uScale.value = pixelScale;
    const speed = Math.hypot(velocity.x, velocity.z);
    wheels.forEach((w, i) => {
      const trail = this.trails[i];
      const mark = MARKS[w.surface];
      if (w.sliding > 0.15 && mark) trail.add(w.point, dir, mark);
      else trail.lift();
      const rate = (w.sliding > 0.15 ? 45 * w.sliding : 0) + (w.trailing ? rollingRate(w.surface, speed) : 0);
      if (rate > 0) {
        this.puffAcc[i] += dt * rate;
        const kind = puffOn(w.surface);
        while (this.puffAcc[i] >= 1) {
          this.puffAcc[i] -= 1;
          this.puffs.emit(kind, w.point, velocity);
        }
      } else this.puffAcc[i] = 0;
    });
    this.puffs.update(dt);
  }

  /** A burst of `n` sprays around `p`: the car going into deep water. */
  splash(p: Vector3, velocity: Vector3, n: number): void {
    const at = new Vector3();
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1 + Math.random() * 1.5;
      this.puffs.emit('spray', at.set(p.x + Math.cos(a) * r, p.y, p.z + Math.sin(a) * r), velocity);
    }
  }

  /** Live puffs of each kind (scenario checks). */
  counts(): Record<PuffKind, number> {
    return this.puffs.counts();
  }

  liftAll(): void {
    for (const t of this.trails) t.lift();
  }

  /** Removes all marks and puffs (switching worlds). */
  clear(): void {
    for (const t of this.trails) t.clear();
    this.puffs.clear();
    this.puffAcc.fill(0);
  }

  applyMatrix(m: Matrix4): void {
    for (const t of this.trails) t.applyMatrix(m);
    this.puffs.applyMatrix(m);
  }

  dispose(): void {
    for (const t of this.trails) t.dispose();
    this.puffs.dispose();
    this.skidMat.dispose();
  }
}
