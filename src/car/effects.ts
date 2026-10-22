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

const SKID_SEGMENTS = 3000;
const SKID_WIDTH = 0.24;
const SKID_SPACING = 0.3;

/** Ring buffer of quads forming one ribbon per wheel. */
class SkidTrail {
  readonly mesh: Mesh;
  private readonly pos: Float32Array;
  private readonly attr: BufferAttribute;
  private head = 0;
  private count = 0;
  private hasLast = false;
  private readonly lastL = new Vector3();
  private readonly lastR = new Vector3();
  private readonly lastC = new Vector3();

  constructor(material: MeshBasicMaterial) {
    this.pos = new Float32Array(SKID_SEGMENTS * 6 * 3);
    this.attr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    const geom = new BufferGeometry();
    geom.setAttribute('position', this.attr);
    geom.setDrawRange(0, 0);
    this.mesh = new Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Extends the ribbon to `p` (ground point) heading along `dir`. */
  add(p: Vector3, dir: Vector3): void {
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

const SMOKE_MAX = 400;
const SMOKE_LIFE = 1.3;

const smokeVertex = /* glsl */ `
  attribute float aAge;
  attribute float aSize;
  varying float vAlpha;
  uniform float uScale;
  void main() {
    if (aAge < 0.0) {
      // Dead or unused slot: push it off-screen instead of rasterising a discarded sprite.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float t = clamp(aAge / ${SMOKE_LIFE.toFixed(2)}, 0.0, 1.0);
    vAlpha = (1.0 - t) * 0.55;
    gl_PointSize = aSize * (0.6 + 2.4 * t) * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const smokeFragment = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.0, length(d)) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(0.88), a);
  }
`;

class Smoke {
  readonly points: Points;
  private readonly pos = new Float32Array(SMOKE_MAX * 3);
  private readonly vel = new Float32Array(SMOKE_MAX * 3);
  private readonly age = new Float32Array(SMOKE_MAX).fill(-1);
  private readonly size = new Float32Array(SMOKE_MAX);
  private next = 0;
  readonly material: ShaderMaterial;

  constructor() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    g.setAttribute('aAge', new BufferAttribute(this.age, 1).setUsage(DynamicDrawUsage));
    g.setAttribute('aSize', new BufferAttribute(this.size, 1));
    this.material = new ShaderMaterial({
      vertexShader: smokeVertex,
      fragmentShader: smokeFragment,
      uniforms: { uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.points = new Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  emit(p: Vector3, v: Vector3): void {
    const i = this.next;
    this.next = (this.next + 1) % SMOKE_MAX;
    this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.3;
    this.pos[i * 3 + 1] = p.y + 0.2;
    this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.3;
    this.vel[i * 3] = v.x * 0.25 + (Math.random() - 0.5);
    this.vel[i * 3 + 1] = 0.8 + Math.random() * 0.6;
    this.vel[i * 3 + 2] = v.z * 0.25 + (Math.random() - 0.5);
    this.age[i] = 0;
    this.size[i] = 1.2 + Math.random() * 0.8;
    (this.points.geometry.attributes.aSize as BufferAttribute).needsUpdate = true;
  }

  update(dt: number): void {
    const drag = Math.exp(-dt * 1.5);
    for (let i = 0; i < SMOKE_MAX; i++) {
      if (this.age[i] < 0) continue;
      this.age[i] += dt;
      if (this.age[i] > SMOKE_LIFE) {
        this.age[i] = -1;
        continue;
      }
      for (let k = 0; k < 3; k++) {
        this.vel[i * 3 + k] *= drag;
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      }
    }
    const a = this.points.geometry.attributes;
    (a.position as BufferAttribute).needsUpdate = true;
    (a.aAge as BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.age.fill(-1);
    (this.points.geometry.attributes.aAge as BufferAttribute).needsUpdate = true;
  }

  applyMatrix(m: Matrix4): void {
    const v = new Vector3();
    for (let i = 0; i < SMOKE_MAX; i++) {
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
  sliding: number; // 0..1 how hard the tyre is sliding
}

/** Skid marks + tyre smoke, one trail per wheel (rear pair, then front). */
export class TyreEffects {
  readonly root = new Group();
  private readonly trails: SkidTrail[];
  private readonly smoke = new Smoke();
  private readonly skidMat = new MeshBasicMaterial({
    color: 0x0c0c0c,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private smokeAcc = [0, 0, 0, 0];

  constructor() {
    this.trails = this.smokeAcc.map(() => new SkidTrail(this.skidMat));
    for (const t of this.trails) this.root.add(t.mesh);
    this.root.add(this.smoke.points);
  }

  /** `dir` is the car's horizontal travel direction (unit). */
  update(dt: number, wheels: WheelSample[], dir: Vector3, velocity: Vector3, pixelScale: number): void {
    this.smoke.material.uniforms.uScale.value = pixelScale;
    wheels.forEach((w, i) => {
      const trail = this.trails[i];
      if (w.sliding > 0.15) {
        trail.add(w.point, dir);
        this.smokeAcc[i] += dt * 45 * w.sliding;
        while (this.smokeAcc[i] >= 1) {
          this.smokeAcc[i] -= 1;
          this.smoke.emit(w.point, velocity);
        }
      } else {
        trail.lift();
        this.smokeAcc[i] = 0;
      }
    });
    this.smoke.update(dt);
  }

  liftAll(): void {
    for (const t of this.trails) t.lift();
  }

  /** Removes all marks and smoke (switching worlds). */
  clear(): void {
    for (const t of this.trails) t.clear();
    this.smoke.clear();
    this.smokeAcc.fill(0);
  }

  applyMatrix(m: Matrix4): void {
    for (const t of this.trails) t.applyMatrix(m);
    this.smoke.applyMatrix(m);
  }

  dispose(): void {
    for (const t of this.trails) t.dispose();
    this.smoke.dispose();
    this.skidMat.dispose();
  }
}
