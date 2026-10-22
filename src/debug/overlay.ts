import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  ShaderMaterial,
  Vector3,
  type Matrix4,
} from 'three';
import { PHYSICS as P } from '../config';
import { Probe, type CarPhysics, type OverpassDecision, type WallRayDebug } from '../car/physics';
import type { World } from '../world/types';

export type FillMode = 'off' | 'height' | 'slope';

export interface OverlayLayers {
  /** Height-coloured wireframe of the collision meshes around the car. */
  wire: boolean;
  /** Translucent fill: by height (with 1 m contours) or by surface class. */
  fill: FillMode;
  /** Draw the photo textures (off leaves only the overlay). */
  photo: boolean;
  /** Ground probes, wall rays and the car footprint for the last step. */
  probes: boolean;
  /** Where the car recently hit walls and edges. */
  history: boolean;
  /** Recent overpass-classifier samples. */
  overpass: boolean;
  /** Tyre forces at each axle, the front wheels' direction and the car's velocity. */
  tyres: boolean;
}

/** Colliders further than this from the car are left out of the overlay. */
const RADIUS = 140;
const MAX_SEGMENTS = 8192;
const MAX_CONTACTS = 400;
const MAX_DECISIONS = 24;
const DECISION_TTL = 30;

// Height bands relative to the car's ground, mirroring the physics thresholds.
// Shared by the shader and the legend.
export const HEIGHT_BANDS: Array<{ from: number; color: [number, number, number]; label: string }> = [
  { from: -Infinity, color: [0.15, 0.3, 1.0], label: `drop (< −${P.dropHeight} m)` },
  { from: -P.dropHeight, color: [0.2, 0.75, 1.0], label: 'below' },
  { from: -P.maxStep, color: [0.25, 0.95, 0.35], label: `drivable (±${P.maxStep} m)` },
  { from: P.maxStep, color: [1.0, 0.85, 0.2], label: `ledge (bumper height ${P.wallProbeHeight} m)` },
  { from: 2, color: [1.0, 0.3, 0.2], label: 'wall' },
  { from: P.overpassMinDeck, color: [0.95, 0.35, 1.0], label: `overpass deck band (${P.overpassMinDeck}–${P.overpassMaxDeck} m)` },
  { from: P.overpassMaxDeck, color: [0.85, 0.85, 0.9], label: 'above' },
];

const glslBands = () => {
  const lines = HEIGHT_BANDS.slice(1).map(
    (b) => `  if (h >= ${b.from.toFixed(3)}) c = vec3(${b.color.map((v) => v.toFixed(3)).join(', ')});`,
  );
  const c0 = HEIGHT_BANDS[0].color.map((v) => v.toFixed(3)).join(', ');
  return `vec3 bandColor(float h) {\n  vec3 c = vec3(${c0});\n${lines.join('\n')}\n  return c;\n}`;
};

const VERT = /* glsl */ `
uniform float uBias;
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  // Pull toward the camera so lines win the depth test against the textured
  // surface they sit on.
  gl_Position.z -= uBias * gl_Position.w;
}`;

const FRAG = /* glsl */ `
uniform float uRef;
uniform vec2 uCar;
uniform float uRadius;
uniform float uOpacity;
uniform int uMode; // 0 wire (height), 1 fill height + contours, 2 fill surface class
varying vec3 vWorld;
${glslBands()}
void main() {
  float h = vWorld.y - uRef;
  vec3 c;
  float a = uOpacity;
  if (uMode == 2) {
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    float ny = abs(n.y);
    c = ny >= ${P.minGroundNormalY.toFixed(3)} ? vec3(0.25, 0.9, 0.35)
      : ny <= ${P.wallMaxNormalY.toFixed(3)} ? vec3(1.0, 0.3, 0.2) : vec3(1.0, 0.85, 0.2);
    // Darken with height so stacked surfaces stay distinguishable.
    c *= 0.55 + 0.45 * clamp(1.0 - abs(h) / 12.0, 0.0, 1.0);
  } else {
    c = bandColor(h);
    if (uMode == 1) {
      float f = abs(fract(h + 0.5) - 0.5) / max(fwidth(h), 1e-4);
      c = mix(c * 0.35, c, smoothstep(0.0, 1.5, f));
    }
  }
  float d = distance(vWorld.xz, uCar);
  a *= 1.0 - smoothstep(uRadius * 0.75, uRadius, d);
  if (a < 0.01) discard;
  gl_FragColor = vec4(c, a);
}`;

function overlayMaterial(mode: 0 | 1 | 2, opts: { wireframe: boolean; bias: number; opacity: number }): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uBias: { value: opts.bias },
      uRef: { value: 0 },
      uCar: { value: [0, 0] },
      uRadius: { value: RADIUS },
      uOpacity: { value: opts.opacity },
      uMode: { value: mode },
    },
    wireframe: opts.wireframe,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
}

interface Shadow {
  wire: Mesh;
  fill: Mesh;
}

interface Decision extends OverpassDecision {
  age: number;
}

const PROBE_COLORS: Record<Probe, number> = {
  [Probe.Ground]: 0x40ff60,
  [Probe.Blocked]: 0xff3030,
  [Probe.Miss]: 0x909090,
  [Probe.Drop]: 0x3070ff,
};

export const RAY_COLORS: Record<WallRayDebug['verdict'], number> = {
  clear: 0xffffff,
  'steep-floor': 0x40e0ff,
  beyond: 0xa0a0a0,
  overpass: 0xff50ff,
  blob: 0x50ffd0,
  wall: 0xff2020,
  'wall-minor': 0xff9090,
};

/**
 * Collision debug view. Shadow meshes share the tile geometry but draw with
 * their own materials, so the photo materials (and their disposal) are untouched.
 */
export class DebugOverlay {
  readonly root = new Group();
  private readonly shadows = new Map<Mesh, Shadow>();
  private readonly wireMat = overlayMaterial(0, { wireframe: true, bias: 0.0004, opacity: 0.85 });
  private readonly fillHeight = overlayMaterial(1, { wireframe: false, bias: 0, opacity: 0.45 });
  private readonly fillSlope = overlayMaterial(2, { wireframe: false, bias: 0, opacity: 0.45 });
  private readonly lines: LineSegments;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private segs = 0;
  private readonly contacts: Array<{ p: Vector3; kind: 'wall' | 'blocked' | 'drop' }> = [];
  private readonly decisions: Decision[] = [];
  private readonly scratch: Mesh[] = [];
  private readonly seen = new Set<Mesh>();

  constructor() {
    const g = new BufferGeometry();
    this.positions = new Float32Array(MAX_SEGMENTS * 6);
    this.colors = new Float32Array(MAX_SEGMENTS * 6);
    g.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    g.setAttribute('color', new BufferAttribute(this.colors, 3).setUsage(DynamicDrawUsage));
    this.lines = new LineSegments(g, new LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1000;
    this.root.add(this.lines);
    this.root.renderOrder = 900;
  }

  /** Drops shadows and history (new world). */
  clear(): void {
    this.clearShadows();
    this.contacts.length = 0;
    this.decisions.length = 0;
  }

  private clearShadows(): void {
    for (const s of this.shadows.values()) this.root.remove(s.wire, s.fill);
    this.shadows.clear();
  }

  /** Records contacts from the step that just ran. */
  onStep(p: CarPhysics): void {
    if (p.wall.pen > 0) this.addContact(p.wall.point, 'wall');
    if (p.edge) this.addContact(p.pos, p.edge === 1 ? 'blocked' : 'drop');
  }

  onOverpass(d: OverpassDecision): void {
    // Own copies: applyMatrix rewrites `hit`, and the trace keeps the original.
    this.decisions.push({ ...d, hit: [...d.hit], age: 0 });
    if (this.decisions.length > MAX_DECISIONS) this.decisions.shift();
  }

  applyMatrix(m: Matrix4): void {
    for (const c of this.contacts) c.p.applyMatrix4(m);
    // Decisions are short-lived; shifting them by the rebase keeps them in place.
    const v = new Vector3();
    for (const d of this.decisions) {
      v.fromArray(d.hit).applyMatrix4(m).toArray(d.hit);
    }
  }

  update(dt: number, world: World | null, p: CarPhysics, layers: OverlayLayers, active: boolean): void {
    if (world) world.root.visible = !active || layers.photo;
    this.root.visible = active;
    if (!active || !world) {
      // Hidden shadows would still pin unloaded tiles' geometry.
      if (this.shadows.size) this.clearShadows();
      return;
    }
    for (const d of this.decisions) d.age += dt;
    while (this.decisions.length && this.decisions[0].age > DECISION_TTL) this.decisions.shift();

    this.updateShadows(world, p, layers);
    this.segs = 0;
    if (layers.probes) this.drawProbes(p);
    if (layers.history) this.drawHistory();
    if (layers.overpass) this.drawDecisions();
    if (layers.tyres) this.drawTyres(p);
    const g = this.lines.geometry;
    g.setDrawRange(0, this.segs * 2);
    (g.attributes.position as BufferAttribute).needsUpdate = true;
    (g.attributes.color as BufferAttribute).needsUpdate = true;
  }

  private updateShadows(world: World, p: CarPhysics, layers: OverlayLayers): void {
    const fillMat = layers.fill === 'slope' ? this.fillSlope : this.fillHeight;
    // Without photos there is nothing to sit on top of: make the fill solid and
    // depth-tested, or far faces would blend over near ones.
    const solid = !layers.photo;
    fillMat.uniforms.uOpacity.value = solid ? 1 : 0.45;
    if (fillMat.transparent === solid) {
      fillMat.transparent = !solid;
      fillMat.depthWrite = solid;
      fillMat.needsUpdate = true;
    }
    for (const m of [this.wireMat, this.fillHeight, this.fillSlope]) {
      m.uniforms.uRef.value = p.groundY;
      m.uniforms.uCar.value = [p.pos.x, p.pos.z];
    }
    const want = layers.wire || layers.fill !== 'off';
    this.scratch.length = 0;
    if (want) world.collectColliders(p.pos.x, p.pos.z, RADIUS, this.scratch);
    this.seen.clear();
    for (const src of this.scratch) {
      this.seen.add(src);
      let s = this.shadows.get(src);
      if (!s) {
        s = { wire: this.shadow(src, this.wireMat), fill: this.shadow(src, fillMat) };
        this.shadows.set(src, s);
        this.root.add(s.wire, s.fill);
      }
      s.wire.visible = layers.wire;
      s.fill.visible = layers.fill !== 'off';
      s.fill.material = fillMat;
    }
    // Tiles that unloaded (or moved out of range) take their geometry with them.
    for (const [src, s] of this.shadows) {
      if (this.seen.has(src)) continue;
      this.root.remove(s.wire, s.fill);
      this.shadows.delete(src);
    }
  }

  private shadow(src: Mesh, material: ShaderMaterial): Mesh {
    const m = new Mesh(src.geometry, material);
    m.matrixAutoUpdate = false;
    m.matrixWorldAutoUpdate = false;
    m.frustumCulled = false;
    m.renderOrder = material.wireframe ? 902 : 901;
    // Follow the source mesh, including rebases, at draw time.
    m.onBeforeRender = () => m.matrixWorld.copy(src.matrixWorld);
    m.raycast = () => {};
    return m;
  }

  // --- Lines ---------------------------------------------------------------

  private seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number): void {
    if (this.segs >= MAX_SEGMENTS) return;
    const i = this.segs++ * 6;
    const pos = this.positions;
    const col = this.colors;
    pos[i] = ax;
    pos[i + 1] = ay;
    pos[i + 2] = az;
    pos[i + 3] = bx;
    pos[i + 4] = by;
    pos[i + 5] = bz;
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    col[i] = col[i + 3] = r;
    col[i + 1] = col[i + 4] = g;
    col[i + 2] = col[i + 5] = b;
  }

  private cross(x: number, y: number, z: number, size: number, color: number): void {
    this.seg(x - size, y, z, x + size, y, z, color);
    this.seg(x, y, z - size, x, y, z + size, color);
  }

  private drawProbes(p: CarPhysics): void {
    // Footprint at ground height.
    const ch = p.car.chassis;
    const s = Math.sin(p.heading);
    const c = Math.cos(p.heading);
    const y = p.groundY + 0.05;
    const corner = (cx: number, cz: number): [number, number] => [p.pos.x + cx * c + cz * s, p.pos.z - cx * s + cz * c];
    const outline = [
      corner(-ch.halfWidth, -ch.halfLength),
      corner(ch.halfWidth, -ch.halfLength),
      corner(ch.halfWidth, ch.halfLength),
      corner(-ch.halfWidth, ch.halfLength),
    ];
    for (let i = 0; i < 4; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % 4];
      this.seg(a[0], y, a[1], b[0], y, b[1], p.contact ? 0xff5050 : 0xffffff);
    }

    for (const pr of p.probes) {
      const col = PROBE_COLORS[pr.state];
      const end = pr.hitY ?? pr.toY;
      this.seg(pr.x, pr.fromY, pr.z, pr.x, end, pr.z, col);
      if (pr.hitY !== null) this.cross(pr.x, pr.hitY, pr.z, 0.25, col);
    }

    for (const r of p.rays) {
      const [ox, oy, oz] = r.origin;
      const [dx, dz] = r.dir;
      const col = RAY_COLORS[r.verdict];
      const len = r.hit ? r.hit.distance : r.length;
      this.seg(ox, oy, oz, ox + dx * len, oy, oz + dz * len, col);
      // Tick where the car outline ends along this ray.
      const rx = ox + dx * r.reach;
      const rz = oz + dz * r.reach;
      this.seg(rx - dz * 0.15, oy, rz + dx * 0.15, rx + dz * 0.15, oy, rz - dx * 0.15, 0xffffff);
      if (r.hit) {
        const [hx, hy, hz] = r.hit.point;
        const [nx, ny, nz] = r.hit.normal;
        this.seg(hx, hy, hz, hx + nx * 0.8, hy + ny * 0.8, hz + nz * 0.8, col);
      }
    }
  }

  /**
   * Axle forces (1 m per kN; green gripping, orange sliding), the front wheels'
   * heading (cyan) and the velocity (white, 1 m per 2 m/s), just above the road.
   */
  private drawTyres(p: CarPhysics): void {
    const ch = p.car.chassis;
    const fx = -Math.sin(p.heading);
    const fz = -Math.cos(p.heading);
    const lx = -Math.cos(p.heading);
    const lz = Math.sin(p.heading);
    const y = p.groundY + 0.4;
    const t = p.tyre;
    const axle = (d: number, f: [number, number], sliding: boolean) => {
      const x = p.pos.x + fx * d;
      const z = p.pos.z + fz * d;
      const k = 1 / 1000;
      this.seg(x, y, z, x + (fx * f[0] + lx * f[1]) * k, y, z + (fz * f[0] + lz * f[1]) * k, sliding ? 0xffa020 : 0x40ff60);
      return [x, z] as const;
    };
    const [ax, az] = axle(ch.cgToFront, t.forceF, t.slideF > 0);
    axle(-(ch.wheelbase - ch.cgToFront), t.forceR, t.slideR > 0);
    const wx = fx * Math.cos(p.steer) + lx * Math.sin(p.steer);
    const wz = fz * Math.cos(p.steer) + lz * Math.sin(p.steer);
    this.seg(ax - wx * 0.8, y, az - wz * 0.8, ax + wx * 0.8, y, az + wz * 0.8, 0x40e0ff);
    this.seg(p.pos.x, y, p.pos.z, p.pos.x + p.vel.x / 2, y, p.pos.z + p.vel.z / 2, 0xffffff);
  }

  private drawHistory(): void {
    for (const c of this.contacts) {
      const { x, y, z } = c.p;
      if (c.kind === 'wall') this.seg(x, y - 0.4, z, x, y + 1.2, z, 0xff3030);
      else this.cross(x, y + 0.1, z, 0.6, c.kind === 'blocked' ? 0xffa020 : 0x3070ff);
    }
  }

  private drawDecisions(): void {
    for (const d of this.decisions) {
      const [hx, hy, hz] = d.hit;
      const [dx, dz] = d.dir;
      const g = d.groundY;
      const col = d.result ? (d.reason === 'blob' ? 0x50ffd0 : 0xff50ff) : 0xff3030;
      this.seg(hx, hy, hz, hx, g + 10, hz, col);
      const alongS = d.samples.filter((s) => s[2] !== 'side');
      const last = alongS.length ? alongS[alongS.length - 1][0] : 0;
      this.seg(hx, g + 0.1, hz, hx + dx * last, g + 0.1, hz + dz * last, 0x808080);
      const mid = d.mid ?? 0;
      for (const [dist, top, phase] of d.samples) {
        // Side samples run across the direction from `mid` metres along it.
        const x = phase === 'side' ? hx + dx * mid - dz * dist : hx + dx * dist;
        const z = phase === 'side' ? hz + dz * mid + dx * dist : hz + dz * dist;
        if (top === null) {
          this.cross(x, g + 0.1, z, 0.3, 0xff3030);
          continue;
        }
        const col = phase === 'skirt' || phase === 'along' ? 0xffd040 : 0x40e0ff;
        this.seg(x, g, z, x, g + top, z, col);
        this.cross(x, g + top, z, 0.3, col);
      }
      if (d.start >= 0) {
        const x = hx + dx * d.start;
        const z = hz + dz * d.start;
        this.cross(x, g + d.deck, z, 0.8, 0xffffff);
      }
    }
  }

  private addContact(p: Vector3, kind: 'wall' | 'blocked' | 'drop'): void {
    const last = this.contacts[this.contacts.length - 1];
    if (last && last.kind === kind && last.p.distanceToSquared(p) < 0.09) return;
    this.contacts.push({ p: p.clone(), kind });
    if (this.contacts.length > MAX_CONTACTS) this.contacts.shift();
  }

  dispose(): void {
    this.clear();
    this.wireMat.dispose();
    this.fillHeight.dispose();
    this.fillSlope.dispose();
    this.lines.geometry.dispose();
    (this.lines.material as LineBasicMaterial).dispose();
  }
}
