import {
  AlwaysStencilFunc,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  GreaterDepth,
  GreaterStencilFunc,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  ReplaceStencilOp,
  ShaderMaterial,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import type { CarId, CarSpec } from './cars';
import { hatchBody } from './hatchBody';

/** The wheels sit this much wider than the ground probes (cornerX). */
const WHEEL_SPREAD = 1.08;

export interface CarPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  roll: number;
  /** Rough ground's quick share of pitch and roll, shown uneased. */
  ridePitch: number;
  rideRoll: number;
  steer: number;
  vForward: number;
  braking: boolean;
  reversing: boolean;
}

/**
 * Translucent, rim-lit stand-in for a car part, drawn only where the part is
 * behind something (GreaterDepth) and only once per pixel (stencil).
 */
function ghostMaterial(color: Color): ShaderMaterial {
  // Dark parts (tires, glass) still need to read against the scenery.
  const c = color.clone();
  c.setRGB(Math.max(c.r, 0.22), Math.max(c.g, 0.22), Math.max(c.b, 0.26));
  return new ShaderMaterial({
    uniforms: { color: { value: c } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float rim = pow(1.0 - facing, 2.0);
        // Faces toward the camera stay see-through; edges glow.
        vec3 rgb = mix(color * 1.25, vec3(1.0, 0.95, 0.85), 0.15 + rim * 0.65);
        gl_FragColor = vec4(rgb, 0.5 + 0.45 * rim);
      }`,
    transparent: true,
    depthFunc: GreaterDepth,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: GreaterStencilFunc,
    stencilZPass: ReplaceStencilOp,
  });
}

/** What a body builder gets: the car, shared materials, and `part` to add a mesh to the body. */
export interface BodyKit {
  spec: CarSpec;
  /** Overall length and width, from the footprint. */
  L: number;
  W: number;
  /** Wheel centres: ±wheelX across, ±wheelZ along. */
  wheelX: number;
  wheelZ: number;
  paint: MeshStandardMaterial;
  dark: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  head: MeshStandardMaterial;
  /** Brake and reverse lights: CarModel drives their glow. */
  brake: MeshStandardMaterial;
  reverse: MeshStandardMaterial;
  /** Adds a mesh to the body at (x, y, z), car space: −Z forward, y up from the road. */
  part(geom: BufferGeometry, mat: Material, x: number, y: number, z: number): Mesh;
}

/** A builder's result: the main body mesh (drawn last of the x-ray ghosts), and optionally its own wheel. */
export interface Body {
  shell: Mesh;
  /**
   * One wheel (tire and rim) centred on its axle, which runs along X, its face
   * toward +X (mirrored for the left side); cloned for all four.
   */
  wheel?: Object3D;
  /** Parts of that wheel that steer but don't spin (brake calipers); same frame, also mirrored. */
  hub?: Object3D;
}

/** Adds a car's body (everything but the wheels) through `kit.part`. */
export type BodyBuilder = (kit: BodyKit) => Body;

/** Rear-drive coupe: a slab with a glasshouse, twin stripes, ducktail spoiler. */
function muscleBody(k: BodyKit): Body {
  const { L, W, paint, dark, glass, part } = k;
  const stripe = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  const shell = part(new BoxGeometry(W, 0.55, L), paint, 0, 0.6, 0);
  part(taperedBox(W * 0.86, 0.48, L * 0.48, 0.78), glass, 0, 1.11, 0.15);
  part(new BoxGeometry(W * 0.8, 0.04, L * 0.3), paint, 0, 1.37, 0.15); // roof
  part(new BoxGeometry(0.35, 0.02, L * 1.001), stripe, 0.22, 0.885, 0);
  part(new BoxGeometry(0.35, 0.02, L * 1.001), stripe, -0.22, 0.885, 0);
  part(new BoxGeometry(W * 1.02, 0.18, 0.2), dark, 0, 0.42, -L / 2); // bumpers
  part(new BoxGeometry(W * 1.02, 0.18, 0.2), dark, 0, 0.42, L / 2);
  part(new BoxGeometry(W * 1.05, 0.06, 0.45), dark, 0, 1.0, L / 2 - 0.25); // spoiler
  for (const s of [-1, 1]) {
    part(new BoxGeometry(0.4, 0.14, 0.05), k.head, s * 0.6, 0.68, -L / 2 - 0.01);
    part(new BoxGeometry(0.38, 0.14, 0.05), k.brake, s * 0.6, 0.72, L / 2 + 0.01);
    part(new BoxGeometry(0.14, 0.1, 0.05), k.reverse, s * 0.25, 0.72, L / 2 + 0.01);
  }
  return { shell };
}

const BODIES: Record<CarId, BodyBuilder> = { muscle: muscleBody, hatch: hatchBody };

/** Low-poly procedural car. Faces −Z; root yaw = heading, body carries pitch/roll. */
export class CarModel {
  readonly root = new Group();
  private readonly body = new Group();
  private readonly frontPivots: Group[] = [];
  private readonly spinners: Group[] = [];
  private readonly brakeMat = new MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a1a, emissiveIntensity: 0.4 });
  private readonly reverseMat = new MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0 });
  private readonly wheelR: number;
  private wheelAngle = 0;
  /** The ground plane's pitch and roll, eased. */
  private pitch = 0;
  private roll = 0;
  /** Front and rear wheel contact points in car space (for skid marks / smoke). */
  readonly frontWheels: ReadonlyArray<[number, number]>;
  readonly rearWheels: ReadonlyArray<[number, number]>;

  constructor(readonly spec: CarSpec) {
    const ch = spec.chassis;
    const wheelR = (this.wheelR = spec.drivetrain.wheelRadius);
    this.frontWheels = [
      [-ch.cornerX, -ch.cornerZ],
      [ch.cornerX, -ch.cornerZ],
    ];
    this.rearWheels = [
      [-ch.cornerX, ch.cornerZ],
      [ch.cornerX, ch.cornerZ],
    ];
    const paint = new MeshStandardMaterial({ color: spec.paint, roughness: 0.4, metalness: 0.25 });
    const dark = new MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 });
    const glass = new MeshStandardMaterial({ color: 0x1b2633, roughness: 0.1, metalness: 0.6 });
    const head = new MeshStandardMaterial({ color: 0xdddddd, emissive: 0xfff6d5, emissiveIntensity: 1.2 });

    this.root.add(this.body);
    const parts: Mesh[] = [];
    const part = (geom: BufferGeometry, mat: Material, x: number, y: number, z: number) => {
      const m = new Mesh(geom, mat);
      m.position.set(x, y, z);
      this.body.add(m);
      parts.push(m);
      return m;
    };
    const { shell, wheel, hub } = BODIES[spec.id]({
      spec,
      L: ch.halfLength * 2,
      W: ch.halfWidth * 2,
      wheelX: ch.cornerX * WHEEL_SPREAD,
      wheelZ: ch.cornerZ,
      paint,
      dark,
      glass,
      head,
      brake: this.brakeMat,
      reverse: this.reverseMat,
      part,
    });

    let proto = wheel;
    if (!proto) {
      const rimMat = new MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.8, roughness: 0.3 });
      proto = new Group().add(
        new Mesh(new CylinderGeometry(wheelR, wheelR, 0.26, 16).rotateZ(Math.PI / 2), dark),
        new Mesh(new BoxGeometry(0.27, wheelR * 1.3, 0.12), rimMat),
      );
    }
    for (const [x, z] of [...this.frontWheels, ...this.rearWheels]) {
      const pivot = new Group();
      pivot.position.set(x * WHEEL_SPREAD, wheelR, z);
      const w = proto.clone();
      const spin = new Group().add(w);
      pivot.add(spin);
      const h = hub?.clone();
      if (h) pivot.add(h);
      // A builder's own wheel has its face on +X; the left side gets the mirror image.
      if (wheel && x < 0) for (const o of [w, h]) if (o) o.scale.x = -1;
      this.body.add(pivot);
      this.spinners.push(spin);
      if (z < 0) this.frontPivots.push(pivot);
    }

    // X-ray: where something hides the car (a deck overhead, a tunnel, a
    // building), a translucent copy of it shows through, as if seen through the
    // geometry. Visible car pixels write stencil 1, so the ghost never shows
    // through the car itself; each ghost pixel writes 1 too, so overlapping
    // parts don't stack up into an opaque blob.
    // After the world: three sorts opaque meshes by material before depth, and
    // a car drawn first would stamp the stencil before a deck covers it.
    this.body.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.renderOrder = 1;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        m.stencilWrite = true;
        m.stencilRef = 1;
        m.stencilFunc = AlwaysStencilFunc;
        m.stencilZPass = ReplaceStencilOp;
      }
    });
    const ghosts = new Map<Material, ShaderMaterial>();
    for (const p of parts) {
      const mat = p.material as MeshStandardMaterial;
      let g = ghosts.get(mat);
      if (!g) {
        g = ghostMaterial(mat.emissive.getHex() && mat.emissiveIntensity > 0.5 ? mat.emissive : mat.color);
        ghosts.set(mat, g);
      }
      const ghost = new Mesh(p.geometry, g);
      ghost.position.copy(p.position);
      ghost.rotation.copy(p.rotation);
      ghost.scale.copy(p.scale);
      // Each pixel goes to the first ghost drawn there, so draw what the chase
      // camera sees on top first (cabin, roof, stripes, lights), then the
      // shell. (No tires: they dip into the road and would glint through it.)
      ghost.renderOrder = p === shell ? 11 : mat === glass ? 10.5 : 10;
      p.parent!.add(ghost);
    }

    // Soft blob shadow; the photogrammetry has no dynamic shadows.
    const shadow = new Mesh(
      new PlaneGeometry(ch.halfWidth * 2 * 1.35, ch.halfLength * 2 * 1.2).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({
        map: blobTexture(),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    shadow.position.y = 0.04;
    shadow.renderOrder = 1;
    this.body.add(shadow);
  }

  get object(): Object3D {
    return this.root;
  }

  update(pose: CarPose, dt: number): void {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.set(0, pose.heading, 0);
    const k = 1 - Math.exp(-dt / 0.08);
    this.pitch = MathUtils.lerp(this.pitch, pose.pitch, k);
    this.roll = MathUtils.lerp(this.roll, pose.roll, k);
    this.body.rotation.x = this.pitch + pose.ridePitch;
    this.body.rotation.z = -(this.roll + pose.rideRoll);
    for (const p of this.frontPivots) p.rotation.y = pose.steer;
    this.wheelAngle -= (pose.vForward / this.wheelR) * dt;
    for (const s of this.spinners) s.rotation.x = this.wheelAngle;
    this.brakeMat.emissiveIntensity = pose.braking ? 3 : 0.4;
    this.reverseMat.emissiveIntensity = pose.reversing ? 2 : 0;
  }

  /** Removes the car from the scene and frees its GPU resources (switching cars). */
  dispose(): void {
    this.root.removeFromParent();
    const seen = new Set<{ dispose(): void }>();
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const r of [mesh.geometry, ...mats, ...mats.map((m) => (m as MeshBasicMaterial).map)]) {
        if (!r || seen.has(r)) continue;
        seen.add(r);
        r.dispose();
      }
    });
  }
}

export function taperedBox(w: number, h: number, l: number, topScale: number): BoxGeometry {
  const g = new BoxGeometry(w, h, l);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * topScale);
      pos.setZ(i, pos.getZ(i) * topScale);
    }
  }
  g.computeVertexNormals();
  return g;
}

function blobTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.translate(32, 64);
  ctx.scale(1, 2);
  const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.65)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.4)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(-32, -32, 64, 64);
  return new CanvasTexture(c);
}
