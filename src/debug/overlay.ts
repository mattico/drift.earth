import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
  type Matrix4,
} from 'three';
import { PHYSICS as P } from '../config';
import { Probe, type CarPhysics, type OverpassDecision, type WallRayDebug } from '../car/physics';
import type { SurfaceId } from '../car/surfaces';
import type { RoadClass } from '../world/roads';
import type { RoadSearch, RoadVerdict } from '../world/roadSnap';
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
  /** Tire forces at each axle, the front wheels' direction and the car's velocity. */
  tires: boolean;
  /** The car's recent path on the ground, coloured by what the tires and aids were doing. */
  trail: boolean;
  /** The live gauges over the game view (debug/gauges.ts; shown with the panel closed too). */
  gauges: boolean;
  /** OSM road centrelines around the car and the last road teleport's tries. */
  roads: boolean;
  /** What the world says each patch of ground is made of (World.surfaceAt), draped over the meshes. */
  surfaces: boolean;
}

/** Colliders further than this from the car are left out of the overlay. */
const RADIUS = 140;
const MAX_SEGMENTS = 8192;
const MAX_CONTACTS = 400;
const MAX_DECISIONS = 24;
const DECISION_TTL = 30;
/** Translucent fills (slip wedges, load bars, the drift band, the trail ribbon). */
const MAX_TRIS = 4096;

/** Slip wedges' radius (m): long enough to read a few degrees at chase distance. */
const WEDGE_RADIUS = 2.2;
/** Drift-angle band round the CG: inner radius (past the front wedge's tip) and width (m). */
const DRIFT_RADIUS = 3.8;
const DRIFT_WIDTH = 0.6;
/** Load bars: height per static axle load (m), cap (× static) and where they start above the road (m). */
const LOAD_SCALE = 1;
const LOAD_MAX = 2.5;
const LOAD_BASE = 1.6;
/** Path arc length ahead of the car (m), and the furthest turn centre still marked (m). */
const PATH_LENGTH = 18;
const CENTRE_MAX = 60;
/** Trail: points kept, physics steps per point (3 at 120 Hz is 40 Hz, so 18 s) and ribbon width (m). */
const TRAIL_POINTS = 720;
const TRAIL_EVERY = 3;
const TRAIL_WIDTH = 0.45;
/** A jump longer than this between two trail points (m) is a respawn, not driving. */
const TRAIL_BREAK = 6;
const DEG = Math.PI / 180;

/**
 * Trail colours in priority order: a segment takes the first that applied on
 * any physics step since the previous point, so a one-step ABS pulse still
 * shows. Airborne beats everything (the tires do nothing then); the aids come
 * next because they explain the sliding they act on; then which axle slid,
 * then a drift held on gripping tires; otherwise plain grip.
 */
export const TRAIL_STATES: ReadonlyArray<{ color: number; label: string }> = [
  { color: 0x909090, label: 'airborne' },
  { color: 0xff40ff, label: 'stability control' },
  { color: 0x3070ff, label: 'ABS' },
  { color: 0x40e0ff, label: 'traction control' },
  { color: 0xff3030, label: 'both axles sliding' },
  { color: 0xffa020, label: 'rear sliding' },
  { color: 0xffe040, label: 'front sliding' },
  { color: 0xb080ff, label: 'drifting (tires gripping)' },
  { color: 0x40ff60, label: 'grip' },
];
const TRAIL_GRIP = TRAIL_STATES.length - 1;

/** Slip wedge colour by slip angle as a share of the tire's peak (past 1 the grip falls away). */
const slipColor = (share: number) => (share < 0.7 ? 0x40ff60 : share <= 1 ? 0xffc030 : 0xff3030);
/** Drift band colour by body slip: under the drift threshold, a drift, a big one, near a spin. */
const driftColor = (a: number) => (a < P.driftEnterSlip ? 0xffffff : a < 35 * DEG ? 0xb080ff : a < 60 * DEG ? 0xff80c0 : 0xff3030);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const _v = new Vector3();
/** The surfaces layer samples World.surfaceAt into a texture this wide (m) around the car… */
const SURFACE_SPAN = 300;
/** …this many texels across: about a metre, like the OSM surface map's cells. */
const SURFACE_TEXELS = 320;
/** Re-sampled this often (s), so tiles rasterised meanwhile show up, or once the car is this far (m) off its centre. */
const SURFACE_REFRESH = 1;
const SURFACE_RECENTRE = 30;

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

const SURFACE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec2 uOrigin;
uniform float uSpan;
uniform vec2 uCar;
uniform float uRadius;
varying vec3 vWorld;
void main() {
  vec2 uv = (vWorld.xz - uOrigin) / uSpan;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  vec4 c = texture2D(uMap, uv);
  c.a *= 1.0 - smoothstep(uRadius * 0.85, uRadius, distance(vWorld.xz, uCar));
  if (c.a < 0.01) discard;
  gl_FragColor = c;
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
  surface: Mesh;
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

/** Surfaces layer and tools/surfaces.mjs. Asphalt draws faint, so everything else stands out. */
export const SURFACE_COLORS: Record<SurfaceId, number> = {
  asphalt: 0x707078,
  cobbles: 0xc06040,
  gravel: 0xe0a040,
  grass: 0x40d040,
  sand: 0xfff080,
  water: 0x3080ff,
};
const SURFACE_ALPHA: Record<SurfaceId, number> = { asphalt: 60, cobbles: 160, gravel: 160, grass: 150, sand: 170, water: 170 };

/** Main roads bright, minor ones dimmer, bridges violet. */
export const ROAD_COLORS: Record<RoadClass | 'bridge', number> = {
  motorway: 0xff9040,
  trunk: 0xffb040,
  primary: 0xffe060,
  secondary: 0xfff0a0,
  tertiary: 0xffffff,
  minor: 0xd0d0d0,
  raceway: 0xff60a0,
  busway: 0x80c0ff,
  service: 0x909090,
  track: 0xa08060,
  bridge: 0xb080ff,
};

export const ROAD_VERDICT_COLORS: Record<RoadVerdict, number> = {
  ok: 0x40ff60,
  'off the end': 0x606060,
  'not loaded': 0x3070ff,
  stacked: 0xa060ff,
  'no flat ground': 0x40e0ff,
  perched: 0xffe040,
  roof: 0xc08040,
  uneven: 0xffa020,
  obstacle: 0xff50ff,
  wall: 0xff3030,
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
  /** Surfaces around the car: texel (c, r) is the ground at uOrigin + (c + ½, r + ½) texels in x, z. Nearest-filtered, as DataTextures are. */
  private readonly surfaceTex = new DataTexture(new Uint8Array(SURFACE_TEXELS * SURFACE_TEXELS * 4), SURFACE_TEXELS, SURFACE_TEXELS, RGBAFormat);
  private readonly surfaceMat = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: SURFACE_FRAG,
    uniforms: {
      uBias: { value: 0 },
      uMap: { value: this.surfaceTex },
      uOrigin: { value: [0, 0] },
      uSpan: { value: SURFACE_SPAN },
      uCar: { value: [0, 0] },
      uRadius: { value: RADIUS },
    },
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  /** Where the surface texture was last sampled, and how long ago (s). */
  private readonly sampled = { x: 0, z: 0, age: Infinity };
  private readonly lines: LineSegments;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private segs = 0;
  private readonly contacts: Array<{ p: Vector3; kind: 'wall' | 'blocked' | 'drop' }> = [];
  private readonly decisions: Decision[] = [];
  private readonly scratch: Mesh[] = [];
  private readonly seen = new Set<Mesh>();
  private readonly fills: Mesh;
  private readonly triPositions: Float32Array;
  private readonly triColors: Float32Array;
  private tris = 0;
  /** The car's forward (fx, fz) and left (lx, lz) on the ground, for the frame being drawn. */
  private fx = 0;
  private fz = -1;
  private lx = -1;
  private lz = 0;
  // Trail ring: x, y (the road), z per point; its colour (a TRAIL_STATES
  // index); whether it starts a new run (not joined to the point before).
  private readonly trailPos = new Float32Array(TRAIL_POINTS * 3);
  private readonly trailState = new Uint8Array(TRAIL_POINTS);
  private readonly trailBreak = new Uint8Array(TRAIL_POINTS);
  private trailHead = 0;
  private trailCount = 0;
  private trailSteps = 0;
  /** Highest-priority trail state seen since the last point. */
  private trailPending = TRAIL_GRIP;
  /** The last road teleport: where from, every spot tried, and where it went. */
  private road: { from: Vector3; tries: Array<{ p: Vector3; found: boolean; verdict: RoadVerdict }>; to: Vector3 | null; heading: number } | null =
    null;

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

    const f = new BufferGeometry();
    this.triPositions = new Float32Array(MAX_TRIS * 9);
    this.triColors = new Float32Array(MAX_TRIS * 12);
    f.setAttribute('position', new BufferAttribute(this.triPositions, 3).setUsage(DynamicDrawUsage));
    // RGBA, so the trail can fade with age while the wedges stay see-through.
    f.setAttribute('color', new BufferAttribute(this.triColors, 4).setUsage(DynamicDrawUsage));
    this.fills = new Mesh(
      f,
      new MeshBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide }),
    );
    this.fills.frustumCulled = false;
    this.fills.renderOrder = 999;
    this.fills.raycast = () => {};
    this.root.add(this.fills);
    this.root.renderOrder = 900;
  }

  /** Drops shadows and history (new world). */
  clear(): void {
    this.clearShadows();
    this.contacts.length = 0;
    this.decisions.length = 0;
    this.trailCount = 0;
    this.trailSteps = 0;
    this.trailPending = TRAIL_GRIP;
    this.road = null;
    this.sampled.age = Infinity;
  }

  private clearShadows(): void {
    for (const s of this.shadows.values()) this.root.remove(s.wire, s.fill, s.surface);
    this.shadows.clear();
  }

  /** Records contacts from the step that just ran. */
  onStep(p: CarPhysics): void {
    if (p.wall.pen > 0) this.addContact(p.wall.point, 'wall');
    if (p.edge) this.addContact(p.pos, p.edge === 1 ? 'blocked' : 'drop');
    this.recordTrail(p);
  }

  /**
   * Adds a trail point every TRAIL_EVERY steps, coloured by the most important
   * thing that happened in between (TRAIL_STATES). Runs with the panel closed
   * too, so opening it shows the stretch just driven.
   */
  private recordTrail(p: CarPhysics): void {
    const t = p.tire;
    const a = p.aids;
    let state = TRAIL_GRIP;
    if (p.airborne) state = 0;
    else if (a.stability !== 0) state = 1;
    else if (a.abs > 0) state = 2;
    else if (a.tc > 0) state = 3;
    else if (t.slideF > 0 && t.slideR > 0) state = 4;
    else if (t.slideR > 0) state = 5;
    else if (t.slideF > 0) state = 6;
    else if (p.drifting) state = 7;
    if (state < this.trailPending) this.trailPending = state;
    if (++this.trailSteps < TRAIL_EVERY) return;
    this.trailSteps = 0;
    const pending = this.trailPending;
    this.trailPending = TRAIL_GRIP;
    let gap = this.trailCount === 0;
    if (this.trailCount) {
      const j = ((this.trailHead + TRAIL_POINTS - 1) % TRAIL_POINTS) * 3;
      const d = Math.hypot(p.pos.x - this.trailPos[j], p.pos.z - this.trailPos[j + 2]);
      // Parked: keep the old points rather than piling new ones on one spot.
      if (d < 0.05) return;
      gap = d > TRAIL_BREAK;
    }
    const i = this.trailHead;
    this.trailPos[i * 3] = p.pos.x;
    this.trailPos[i * 3 + 1] = p.groundY;
    this.trailPos[i * 3 + 2] = p.pos.z;
    this.trailState[i] = pending;
    this.trailBreak[i] = gap ? 1 : 0;
    this.trailHead = (i + 1) % TRAIL_POINTS;
    if (this.trailCount < TRAIL_POINTS) this.trailCount++;
  }

  onOverpass(d: OverpassDecision): void {
    // Own copies: applyMatrix rewrites `hit`, and the trace keeps the original.
    this.decisions.push({ ...d, hit: [...d.hit], age: 0 });
    if (this.decisions.length > MAX_DECISIONS) this.decisions.shift();
  }

  /** Keeps a road teleport's tries for the `roads` layer, until the next one. */
  onRoadSearch(from: Vector3, search: RoadSearch, groundY: number): void {
    const s = search.spot;
    this.road = {
      from: from.clone(),
      // Spots without a surface height sit at the car's ground, so they still show.
      tries: search.tried.map((t) => ({ p: new Vector3(t.x, t.y ?? groundY, t.z), found: t.y !== null, verdict: t.verdict })),
      to: s ? s.pos.clone() : null,
      heading: s?.heading ?? 0,
    };
  }

  applyMatrix(m: Matrix4): void {
    this.sampled.age = Infinity;
    for (const c of this.contacts) c.p.applyMatrix4(m);
    if (this.road) {
      this.road.from.applyMatrix4(m);
      this.road.to?.applyMatrix4(m);
      for (const t of this.road.tries) t.p.applyMatrix4(m);
    }
    // Decisions are short-lived; shifting them by the rebase keeps them in place.
    for (const d of this.decisions) {
      _v.fromArray(d.hit).applyMatrix4(m).toArray(d.hit);
    }
    // Every ring slot in use moves alike, whichever end of the trail it holds.
    for (let i = 0; i < this.trailCount; i++) {
      _v.fromArray(this.trailPos, i * 3)
        .applyMatrix4(m)
        .toArray(this.trailPos, i * 3);
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

    if (layers.surfaces) this.sampleSurfaces(dt, world, p);
    this.updateShadows(world, p, layers);
    this.segs = 0;
    this.tris = 0;
    this.basis(p.heading);
    if (layers.trail) this.drawTrail(p);
    if (layers.probes) this.drawProbes(p);
    if (layers.history) this.drawHistory();
    if (layers.overpass) this.drawDecisions();
    if (layers.tires) this.drawTires(p);
    if (layers.roads) this.drawRoads(world, p);
    const g = this.lines.geometry;
    g.setDrawRange(0, this.segs * 2);
    (g.attributes.position as BufferAttribute).needsUpdate = true;
    (g.attributes.color as BufferAttribute).needsUpdate = true;
    const f = this.fills.geometry;
    f.setDrawRange(0, this.tris * 3);
    (f.attributes.position as BufferAttribute).needsUpdate = true;
    (f.attributes.color as BufferAttribute).needsUpdate = true;
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
    this.surfaceMat.uniforms.uCar.value = [p.pos.x, p.pos.z];
    const want = layers.wire || layers.fill !== 'off' || layers.surfaces;
    this.scratch.length = 0;
    if (want) world.collectColliders(p.pos.x, p.pos.z, RADIUS, this.scratch);
    this.seen.clear();
    for (const src of this.scratch) {
      this.seen.add(src);
      let s = this.shadows.get(src);
      if (!s) {
        s = { wire: this.shadow(src, this.wireMat), fill: this.shadow(src, fillMat), surface: this.shadow(src, this.surfaceMat) };
        this.shadows.set(src, s);
        this.root.add(s.wire, s.fill, s.surface);
      }
      s.wire.visible = layers.wire;
      s.fill.visible = layers.fill !== 'off';
      s.fill.material = fillMat;
      s.surface.visible = layers.surfaces;
    }
    // Tiles that unloaded (or moved out of range) take their geometry with them.
    for (const [src, s] of this.shadows) {
      if (this.seen.has(src)) continue;
      this.root.remove(s.wire, s.fill, s.surface);
      this.shadows.delete(src);
    }
  }

  private shadow(src: Mesh, material: ShaderMaterial): Mesh {
    const m = new Mesh(src.geometry, material);
    m.matrixAutoUpdate = false;
    m.matrixWorldAutoUpdate = false;
    m.frustumCulled = false;
    m.renderOrder = material.wireframe ? 902 : material === this.surfaceMat ? 903 : 901;
    // Follow the source mesh, including rebases, at draw time.
    m.onBeforeRender = () => m.matrixWorld.copy(src.matrixWorld);
    m.raycast = () => {};
    return m;
  }

  /**
   * Samples the world's surfaces into the texture the `surfaces` layer drapes
   * over the meshes, at points fixed to the world (whole texels), so the
   * pattern doesn't crawl as the car moves. On real tiles this is the OSM
   * surface map, which may only ever show here, never in the game's own view.
   */
  private sampleSurfaces(dt: number, world: World, p: CarPhysics): void {
    const s = this.sampled;
    s.age += dt;
    if (s.age < SURFACE_REFRESH && Math.hypot(p.pos.x - s.x, p.pos.z - s.z) < SURFACE_RECENTRE) return;
    s.age = 0;
    s.x = p.pos.x;
    s.z = p.pos.z;
    const texel = SURFACE_SPAN / SURFACE_TEXELS;
    const x0 = Math.round((p.pos.x - SURFACE_SPAN / 2) / texel) * texel;
    const z0 = Math.round((p.pos.z - SURFACE_SPAN / 2) / texel) * texel;
    const data = this.surfaceTex.image.data as Uint8Array;
    for (let r = 0; r < SURFACE_TEXELS; r++) {
      for (let c = 0; c < SURFACE_TEXELS; c++) {
        const id = world.surfaceAt(x0 + (c + 0.5) * texel, z0 + (r + 0.5) * texel);
        const col = SURFACE_COLORS[id];
        const k = (r * SURFACE_TEXELS + c) * 4;
        data[k] = (col >> 16) & 255;
        data[k + 1] = (col >> 8) & 255;
        data[k + 2] = col & 255;
        data[k + 3] = SURFACE_ALPHA[id];
      }
    }
    this.surfaceTex.needsUpdate = true;
    this.surfaceMat.uniforms.uOrigin.value = [x0, z0];
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

  private tri(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    color: number,
    alpha: number,
  ): void {
    if (this.tris >= MAX_TRIS) return;
    const i = this.tris * 9;
    const j = this.tris++ * 12;
    const pos = this.triPositions;
    const col = this.triColors;
    pos[i] = ax;
    pos[i + 1] = ay;
    pos[i + 2] = az;
    pos[i + 3] = bx;
    pos[i + 4] = by;
    pos[i + 5] = bz;
    pos[i + 6] = cx;
    pos[i + 7] = cy;
    pos[i + 8] = cz;
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    for (let k = j; k < j + 12; k += 4) {
      col[k] = r;
      col[k + 1] = g;
      col[k + 2] = b;
      col[k + 3] = alpha;
    }
  }

  private basis(heading: number): void {
    this.fx = -Math.sin(heading);
    this.fz = -Math.cos(heading);
    this.lx = -Math.cos(heading);
    this.lz = Math.sin(heading);
  }

  /** World x and z of the body-frame direction `a` (rad from forward, left +), scaled by `r`. */
  private dx(a: number, r: number): number {
    return (this.fx * Math.cos(a) + this.lx * Math.sin(a)) * r;
  }

  private dz(a: number, r: number): number {
    return (this.fz * Math.cos(a) + this.lz * Math.sin(a)) * r;
  }

  /**
   * Flat filled fan at (x, y, z) from body-frame angle `from` through `sweep`
   * (rad), outlined in its colour so it still reads where the fill is faint.
   */
  private fan(x: number, y: number, z: number, from: number, sweep: number, radius: number, color: number, alpha: number): void {
    const n = Math.min(32, Math.max(2, Math.ceil(Math.abs(sweep) / (4 * DEG))));
    let px = x + this.dx(from, radius);
    let pz = z + this.dz(from, radius);
    this.seg(x, y, z, px, y, pz, color);
    for (let i = 1; i <= n; i++) {
      const a = from + (sweep * i) / n;
      const qx = x + this.dx(a, radius);
      const qz = z + this.dz(a, radius);
      this.tri(x, y, z, px, y, pz, qx, y, qz, color, alpha);
      this.seg(px, y, pz, qx, y, qz, color);
      px = qx;
      pz = qz;
    }
    this.seg(x, y, z, px, y, pz, color);
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
   * The tires layer (`layers.tires`), just above the road:
   * - axle forces (1 m per kN; green gripping, orange sliding), the front
   *   wheels' heading (cyan) and the velocity (white, 1 m per 2 m/s);
   * - a slip wedge at each axle, from where its wheels point to where the
   *   contact patch travels, coloured by slip against the tire's peak (the
   *   rear one is mirrored behind the car, so the body doesn't hide it);
   * - load bars above each axle (1 m = the static load, white tick): weight
   *   transfer under brakes and throttle;
   * - the arc the car is on (R = v / yaw rate) and its centre when it's close;
   * - the drift band round the CG, from body heading to velocity.
   */
  private drawTires(p: CarPhysics): void {
    const ch = p.car.chassis;
    const { fx, fz, lx, lz } = this;
    const y = p.groundY + 0.4;
    const t = p.tire;
    const a = ch.cgToFront;
    const b = ch.wheelbase - a;
    const k = 1 / 1000;
    const frontX = p.pos.x + fx * a;
    const frontZ = p.pos.z + fz * a;
    const rearX = p.pos.x - fx * b;
    const rearZ = p.pos.z - fz * b;
    const [ff, fl] = t.forceF;
    const [rf, rl] = t.forceR;
    this.seg(frontX, y, frontZ, frontX + (fx * ff + lx * fl) * k, y, frontZ + (fz * ff + lz * fl) * k, t.slideF > 0 ? 0xffa020 : 0x40ff60);
    this.seg(rearX, y, rearZ, rearX + (fx * rf + lx * rl) * k, y, rearZ + (fz * rf + lz * rl) * k, t.slideR > 0 ? 0xffa020 : 0x40ff60);
    const wx = this.dx(p.steer, 0.8);
    const wz = this.dz(p.steer, 0.8);
    this.seg(frontX - wx, y, frontZ - wz, frontX + wx, y, frontZ + wz, 0x40e0ff);
    this.seg(p.pos.x, y, p.pos.z, p.pos.x + p.vel.x / 2, y, p.pos.z + p.vel.z / 2, 0xffffff);

    // Body-frame velocity, then each contact patch's (as integrateChassis: vyF = vL + a·r, vyR = vL − b·r).
    const vF = p.vel.x * fx + p.vel.z * fz;
    const vL = p.vel.x * lx + p.vel.z * lz;
    const r = p.yawRate;
    // Each axle's peak on the ground under it, as axleTire scales it: tan(peak) × the surface's peakSlip.
    const tanPeak = Math.tan(ch.peakSlipAngle);
    const [gF, gR] = p.axleSurface;
    this.slipWedge(frontX, y - 0.05, frontZ, p.steer, vF, vL + a * r, Math.atan(tanPeak * gF.peakSlip), false);
    this.slipWedge(rearX, y - 0.05, rearZ, 0, vF, vL - b * r, Math.atan(tanPeak * gR.peakSlip), true);

    const weight = 9.81 * ch.mass;
    this.loadBar(frontX, frontZ, p.groundY + LOAD_BASE, t.loadF / ((weight * b) / ch.wheelbase));
    this.loadBar(rearX, rearZ, p.groundY + LOAD_BASE, t.loadR / ((weight * a) / ch.wheelbase));

    this.drawPath(p);

    // Drift angle, measured from whichever end of the car leads (as `p.slip` is).
    if (p.speed > 2) {
      const base = vF < 0 ? Math.PI : 0;
      const beta = Math.atan2(vL, Math.abs(vF));
      this.driftBand(p.pos.x, p.groundY + 0.3, p.pos.z, base, vF < 0 ? -beta : beta);
    }
  }

  /**
   * Drift angle as a band round the CG past the front slip wedge (a full fan
   * would cover it), from a heading line to the velocity, ticked every 10°
   * (longer every 30°).
   */
  private driftBand(x: number, y: number, z: number, from: number, sweep: number): void {
    const col = driftColor(Math.abs(sweep));
    const r0 = DRIFT_RADIUS;
    const r1 = DRIFT_RADIUS + DRIFT_WIDTH;
    this.seg(x, y, z, x + this.dx(from, r1), y, z + this.dz(from, r1), col);
    const n = Math.min(32, Math.max(1, Math.ceil(Math.abs(sweep) / (4 * DEG))));
    for (let i = 0; i < n; i++) {
      const a = from + (sweep * i) / n;
      const b = from + (sweep * (i + 1)) / n;
      const ax0 = x + this.dx(a, r0);
      const az0 = z + this.dz(a, r0);
      const ax1 = x + this.dx(a, r1);
      const az1 = z + this.dz(a, r1);
      const bx0 = x + this.dx(b, r0);
      const bz0 = z + this.dz(b, r0);
      const bx1 = x + this.dx(b, r1);
      const bz1 = z + this.dz(b, r1);
      this.tri(ax0, y, az0, ax1, y, az1, bx1, y, bz1, col, 0.35);
      this.tri(ax0, y, az0, bx1, y, bz1, bx0, y, bz0, col, 0.35);
      this.seg(ax1, y, az1, bx1, y, bz1, col);
    }
    const s = Math.sign(sweep);
    for (let i = 1; i * 10 * DEG < Math.abs(sweep); i++) {
      const a = from + s * i * 10 * DEG;
      const out = i % 3 === 0 ? 0.6 : 0.3;
      this.seg(x + this.dx(a, r1), y, z + this.dz(a, r1), x + this.dx(a, r1 + out), y, z + this.dz(a, r1 + out), col);
    }
  }

  /**
   * Slip wedge at an axle: from the wheels' heading (`wheel`, body frame) to
   * the contact patch's velocity (`vx` forward, `vy` left). Rolling backwards
   * it's measured from the wheels' rear, as the tire sees it.
   */
  private slipWedge(x: number, y: number, z: number, wheel: number, vx: number, vy: number, peak: number, behind: boolean): void {
    // Below walking pace the angle is noise.
    if (Math.hypot(vx, vy) < 1) return;
    const rolling = vx * Math.cos(wheel) + vy * Math.sin(wheel);
    let from = wheel + (rolling < 0 ? Math.PI : 0);
    const sweep = wrapAngle(Math.atan2(vy, vx) - from);
    if (behind) from += Math.PI;
    this.fan(x, y, z, from, sweep, WEDGE_RADIUS, slipColor(Math.abs(sweep) / peak), 0.4);
  }

  /** Upright bar across the car: `ratio` × the static axle load tall, with the static level ticked. */
  private loadBar(x: number, z: number, base: number, ratio: number): void {
    const { lx, lz } = this;
    const w = 0.22;
    const top = base + Math.min(ratio, LOAD_MAX) * LOAD_SCALE;
    const col = ratio >= 1 ? 0xffb060 : 0x60a0ff;
    const ax = x - lx * w;
    const az = z - lz * w;
    const bx = x + lx * w;
    const bz = z + lz * w;
    this.tri(ax, base, az, bx, base, bz, bx, top, bz, col, 0.55);
    this.tri(ax, base, az, bx, top, bz, ax, top, az, col, 0.55);
    this.seg(ax, base, az, ax, top, az, col);
    this.seg(bx, base, bz, bx, top, bz, col);
    this.seg(ax, top, az, bx, top, bz, col);
    this.seg(ax, base, az, bx, base, bz, 0x808080);
    const s = base + LOAD_SCALE;
    this.seg(x - lx * w * 1.8, s, z - lz * w * 1.8, x + lx * w * 1.8, s, z + lz * w * 1.8, 0xffffff);
  }

  /**
   * The circle the CG is on (radius v / r, its centre to the left of the
   * velocity in a left turn): a dashed arc PATH_LENGTH ahead, plus the centre
   * and a radius line while it's within CENTRE_MAX.
   */
  private drawPath(p: CarPhysics): void {
    const v = p.speed;
    if (v < 1) return;
    const y = p.groundY + 0.12;
    const col = 0x9fb0ff;
    const r = p.yawRate;
    const radius = v / Math.max(Math.abs(r), 1e-6);
    const n = 36;
    if (PATH_LENGTH / radius < 0.01) {
      // Under a degree of turn along the whole arc: straight.
      const k = PATH_LENGTH / v / n;
      for (let i = 0; i < n; i += 2) {
        this.seg(
          p.pos.x + p.vel.x * k * i,
          y,
          p.pos.z + p.vel.z * k * i,
          p.pos.x + p.vel.x * k * (i + 1),
          y,
          p.pos.z + p.vel.z * k * (i + 1),
          col,
        );
      }
      return;
    }
    const cx = p.pos.x + p.vel.z / r;
    const cz = p.pos.z - p.vel.x / r;
    const ox = p.pos.x - cx;
    const oz = p.pos.z - cz;
    // Every point turns about the centre at the yaw rate; three quarters of a lap at most.
    const span = Math.sign(r) * Math.min(PATH_LENGTH / radius, 1.5 * Math.PI);
    let px = p.pos.x;
    let pz = p.pos.z;
    for (let i = 1; i <= n; i++) {
      const ang = (span * i) / n;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const qx = cx + ox * c + oz * s;
      const qz = cz + oz * c - ox * s;
      // Dashed, so it doesn't read as the trail.
      if (i % 2) this.seg(px, y, pz, qx, y, qz, col);
      px = qx;
      pz = qz;
    }
    if (radius < CENTRE_MAX) {
      this.cross(cx, y, cz, 0.6, col);
      this.seg(cx, y, cz, p.pos.x, y, p.pos.z, 0x506080);
    }
  }

  /**
   * The trail ribbon, fading with age. Segments under the car are left out:
   * the overlay draws over everything, so they would stripe the body.
   */
  private drawTrail(p: CarPhysics): void {
    const n = this.trailCount;
    if (n < 2) return;
    const pos = this.trailPos;
    const first = (this.trailHead - n + TRAIL_POINTS) % TRAIL_POINTS;
    const hide = p.car.chassis.halfLength ** 2;
    const half = TRAIL_WIDTH / 2;
    for (let k = 1; k < n; k++) {
      const j = (first + k) % TRAIL_POINTS;
      if (this.trailBreak[j]) continue;
      const i = (j + TRAIL_POINTS - 1) % TRAIL_POINTS;
      const ax = pos[i * 3];
      const ay = pos[i * 3 + 1] + 0.06;
      const az = pos[i * 3 + 2];
      const bx = pos[j * 3];
      const by = pos[j * 3 + 1] + 0.06;
      const bz = pos[j * 3 + 2];
      if ((ax - p.pos.x) ** 2 + (az - p.pos.z) ** 2 < hide && (bx - p.pos.x) ** 2 + (bz - p.pos.z) ** 2 < hide) continue;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-4) continue;
      const nx = (-(bz - az) / len) * half;
      const nz = ((bx - ax) / len) * half;
      const col = TRAIL_STATES[this.trailState[j]].color;
      const alpha = 0.25 + (0.65 * k) / n;
      this.tri(ax - nx, ay, az - nz, ax + nx, ay, az + nz, bx + nx, by, bz + nz, col, alpha);
      this.tri(ax - nx, ay, az - nz, bx + nx, by, bz + nz, bx - nx, by, bz - nz, col, alpha);
    }
  }

  /**
   * Road centrelines within the overlay radius, just above the car's ground
   * (OSM has no heights), and the last road teleport: each spot tried as a
   * cross coloured by verdict (with a post where it found a surface), a line
   * from where the car was, and an arrow for where it went.
   */
  private drawRoads(world: World, p: CarPhysics): void {
    const y = p.groundY + 0.3;
    world.roads?.forEachNear(p.pos.x, p.pos.z, RADIUS, ({ way, index }) => {
      const k = index * 2;
      const col = way.bridge ? ROAD_COLORS.bridge : ROAD_COLORS[way.cls];
      this.seg(way.xz[k], y, way.xz[k + 1], way.xz[k + 2], y, way.xz[k + 3], col);
    });
    const r = this.road;
    if (!r) return;
    for (const t of r.tries) {
      const col = ROAD_VERDICT_COLORS[t.verdict];
      this.cross(t.p.x, t.p.y + 0.1, t.p.z, t.found ? 0.5 : 0.3, col);
      if (t.found) this.seg(t.p.x, t.p.y, t.p.z, t.p.x, t.p.y + 1.5, t.p.z, col);
    }
    if (r.to) {
      const { x, y: ty, z } = r.to;
      const fx = -Math.sin(r.heading);
      const fz = -Math.cos(r.heading);
      const h = ty + 0.2;
      this.seg(r.from.x, r.from.y + 0.5, r.from.z, x, ty + 0.5, z, 0xffffff);
      this.seg(x - fx * 2, h, z - fz * 2, x + fx * 3, h, z + fz * 3, 0x40ff60);
      this.seg(x + fx * 3, h, z + fz * 3, x + fx * 2 - fz * 0.8, h, z + fz * 2 + fx * 0.8, 0x40ff60);
      this.seg(x + fx * 3, h, z + fz * 3, x + fx * 2 + fz * 0.8, h, z + fz * 2 - fx * 0.8, 0x40ff60);
    }
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
    this.surfaceMat.dispose();
    this.surfaceTex.dispose();
    this.lines.geometry.dispose();
    (this.lines.material as LineBasicMaterial).dispose();
    this.fills.geometry.dispose();
    (this.fills.material as MeshBasicMaterial).dispose();
  }
}
