import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Matrix4,
} from 'three';
import { SPEED_FX } from '../config';
import type { ChassisSpec } from './cars';

const F = SPEED_FX.streaks;
const MAX = 96;

interface Streak {
  /** Where on the car it comes off (car frame: x right, y up from the road, z back). */
  local: Vector3;
  head: Vector3;
  tail: Vector3;
  /** Sideways drift (m/s, world) once it's let go of the car: air pushed out from the body. */
  drift: Vector3;
  age: number;
  attach: number;
  length: number;
  alive: boolean;
}

/** The car's render pose: where it is (on the road) and which way it faces. */
export interface StreakPose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

const _side = new Vector3();
const _toCam = new Vector3();
const _dir = new Vector3();

/**
 * Speed lines coming off the car: thin white streaks that peel off its flanks
 * and the corners of its tail. Each follows its point on the car for a moment,
 * drawing a line back along the way the car came, then is left in the air,
 * sliding back and outward as the car pulls away, and fades. Ribbons turned
 * to face the camera, brightest at the head.
 */
export class SpeedStreaks {
  readonly root: Mesh;
  private readonly streaks: Streak[] = [];
  private readonly pos = new Float32Array(MAX * 4 * 3);
  private readonly color = new Float32Array(MAX * 4 * 4);
  private readonly posAttr: BufferAttribute;
  private readonly colorAttr: BufferAttribute;
  private acc = 0;

  constructor() {
    const g = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.colorAttr = new BufferAttribute(this.color, 4).setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('color', this.colorAttr);
    const index: number[] = [];
    for (let i = 0; i < MAX; i++) {
      const v = i * 4;
      index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
    }
    g.setIndex(index);
    this.root = new Mesh(g, new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.root.frustumCulled = false;
    // After the skid marks and smoke.
    this.root.renderOrder = 4;
    for (let i = 0; i < MAX; i++) {
      this.streaks.push({ local: new Vector3(), head: new Vector3(), tail: new Vector3(), drift: new Vector3(), age: 0, attach: 0, length: 0, alive: false });
    }
  }

  /**
   * `frac`: speed as a share of top speed (0 when the effects are off).
   * `dt` is game time, so streaks stop with the physics.
   */
  update(dt: number, pose: StreakPose, chassis: ChassisSpec, speed: number, frac: number, camera: Vector3, camDistance: number): void {
    const strength = MathUtils.smoothstep(frac, F.from, F.to);
    this.acc += dt * F.rate * strength;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.spawn(pose, chassis, speed);
    }

    const cos = Math.cos(pose.heading);
    const sin = Math.sin(pose.heading);
    const half = (F.width * camDistance) / 2;
    for (const [i, s] of this.streaks.entries()) {
      if (s.alive) {
        s.age += dt;
        if (s.age > F.life) s.alive = false;
      }
      if (!s.alive) {
        this.write(i, s, 0, 0);
        continue;
      }
      if (s.age < s.attach) {
        // Following its point on the car; the tail no further back than its length.
        const { x, y, z } = s.local;
        s.head.set(pose.x + x * cos + z * sin, pose.y + y, pose.z - x * sin + z * cos);
        if (s.head.distanceTo(s.tail) > s.length) s.tail.sub(s.head).setLength(s.length).add(s.head);
      } else {
        s.head.addScaledVector(s.drift, dt);
        s.tail.addScaledVector(s.drift, dt);
      }
      // Quick in, slow out; dimmer in a weak wind, so they thin out rather than vanish at the threshold.
      const fade = MathUtils.smoothstep(s.age, 0, 0.04) * (1 - s.age / F.life) ** 1.5;
      this.write(i, s, F.opacity * fade * (0.4 + 0.6 * strength), half, camera);
    }
    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  private spawn(pose: StreakPose, chassis: ChassisSpec, speed: number): void {
    const s = this.streaks.find((s) => !s.alive);
    if (!s) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    const w = chassis.halfWidth;
    const l = chassis.halfLength;
    // Mostly the flanks, from the front wheels back; now and then the corners of the tail.
    if (Math.random() < 0.7) s.local.set(side * (w + 0.05), MathUtils.randFloat(0.35, 1.1), MathUtils.randFloat(-0.3 * l, 0.9 * l));
    else s.local.set(side * w * MathUtils.randFloat(0.6, 0.95), MathUtils.randFloat(0.5, 1.2), l);
    const cos = Math.cos(pose.heading);
    const sin = Math.sin(pose.heading);
    const { x, y, z } = s.local;
    s.head.set(pose.x + x * cos + z * sin, pose.y + y, pose.z - x * sin + z * cos);
    s.tail.copy(s.head);
    // Outward from the side it came off.
    const out = side * MathUtils.randFloat(0.8, 2.5);
    s.drift.set(out * cos, 0, -out * sin);
    s.age = 0;
    s.attach = F.attach * MathUtils.randFloat(0.5, 1.5);
    s.length = Math.max(1, speed * F.length * MathUtils.randFloat(0.6, 1.4));
    s.alive = true;
  }

  /** Streak `i`'s quad: `half` wide each side of its line, turned to face the camera; alpha fading to 0 at the tail. */
  private write(i: number, s: Streak, alpha: number, half: number, camera?: Vector3): void {
    const p = this.pos;
    const o = i * 12;
    if (!camera || alpha <= 0) {
      p.fill(0, o, o + 12);
      this.color.fill(0, i * 16, i * 16 + 16);
      return;
    }
    _dir.subVectors(s.head, s.tail);
    _toCam.subVectors(camera, s.head);
    _side.crossVectors(_dir, _toCam);
    if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0);
    _side.setLength(half);
    const put = (k: number, v: Vector3, sign: number) => {
      p[o + k * 3] = v.x + _side.x * sign;
      p[o + k * 3 + 1] = v.y + _side.y * sign;
      p[o + k * 3 + 2] = v.z + _side.z * sign;
    };
    put(0, s.head, 1);
    put(1, s.head, -1);
    put(2, s.tail, 1);
    put(3, s.tail, -1);
    const c = this.color;
    const co = i * 16;
    for (let k = 0; k < 4; k++) {
      c[co + k * 4] = c[co + k * 4 + 1] = c[co + k * 4 + 2] = 1;
      c[co + k * 4 + 3] = k < 2 ? alpha : 0;
    }
  }

  /** Clears them all (reset, teleport, new world). */
  clear(): void {
    for (const s of this.streaks) s.alive = false;
    this.acc = 0;
  }

  applyMatrix(m: Matrix4): void {
    for (const s of this.streaks) {
      s.head.applyMatrix4(m);
      s.tail.applyMatrix4(m);
      const len = s.drift.length();
      s.drift.transformDirection(m).multiplyScalar(len);
    }
  }

  dispose(): void {
    this.root.geometry.dispose();
    (this.root.material as MeshBasicMaterial).dispose();
  }
}
