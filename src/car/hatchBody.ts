// The hot hatch's body: a low-poly two-box hatchback after a Focus ST. Each
// panel is a side profile extruded across the car with rounded edges, then
// bent: nose and tail corners swept back in plan, the cabin leaning in
// (tumblehome), bonnet and roof crowned, arches flared past the tyres. The
// chase camera looks down from behind, so the roof, spoiler, tailgate and rear
// quarters carry most of the shape.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  Shape,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Body, BodyKit } from './carModel';

/** A side-profile point (z, y) in car space: −Z forward, y up from the road. */
type P = [number, number];
/** A width limit at a profile point: x = f(y, z). */
type XAt = (y: number, z: number) => number;

const TYRE_WIDTH = 0.24;
/** Edges this sharp (radians) or sharper stay hard; gentler ones shade smooth. */
const CREASE = 0.9;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};

/** A side profile built from lines and curves, subdivided so the bends below have vertices to move. */
class Profile {
  readonly pts: P[];
  constructor(z: number, y: number) {
    this.pts = [[z, y]];
  }
  /** Index of the latest point (to slice sub-paths for trim that hugs the panel). */
  get end(): number {
    return this.pts.length - 1;
  }
  /** Straight to (z, y) in `n` pieces. */
  line(z: number, y: number, n = 1): this {
    const [z0, y0] = this.pts[this.end];
    for (let i = 1; i <= n; i++) this.pts.push([lerp(z0, z, i / n), lerp(y0, y, i / n)]);
    return this;
  }
  /** Quadratic curve to (z, y), pulled toward (cz, cy). */
  curve(cz: number, cy: number, z: number, y: number, n: number): this {
    const [z0, y0] = this.pts[this.end];
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      this.pts.push([u * u * z0 + 2 * u * t * cz + t * t * z, u * u * y0 + 2 * u * t * cy + t * t * y]);
    }
    return this;
  }
  /** Arc about (cz, cy) from angle a0 to a1 (0 = +z, π/2 = up), both ends included. */
  arc(cz: number, cy: number, r: number, a0: number, a1: number, n: number): this {
    for (let i = 0; i <= n; i++) {
      const a = lerp(a0, a1, i / n);
      this.pts.push([cz + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return this;
  }
}

/** Moves each point `d` along the path's left normal (outward, on a clockwise outline). */
function offset(path: P[], d: number, closed = false): P[] {
  const n = path.length;
  const normal = (a: P, b: P): P => {
    const dz = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dz, dy) || 1;
    return [-dy / l, dz / l];
  };
  return path.map((p, i) => {
    const prev = closed ? path[(i - 1 + n) % n] : i > 0 ? path[i - 1] : null;
    const next = closed ? path[(i + 1) % n] : i < n - 1 ? path[i + 1] : null;
    const n1 = prev ? normal(prev, p) : normal(p, next!);
    const n2 = next ? normal(p, next) : n1;
    const m = [n1[0] + n2[0], n1[1] + n2[1]];
    const ml = Math.hypot(m[0], m[1]) || 1;
    // Mitred, so straight runs either side of a bend keep their distance.
    const k = d / Math.max(0.5, (m[0] * n1[0] + m[1] * n1[1]) / ml) / ml;
    return [p[0] + m[0] * k, p[1] + m[1] * k];
  });
}

/** Grows a closed outline by `d` (shrinks if negative), whichever way it winds. */
function grow(poly: P[], d: number): P[] {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [z0, y0] = poly[i];
    const [z1, y1] = poly[(i + 1) % poly.length];
    area += z0 * y1 - z1 * y0;
  }
  return offset(poly, area < 0 ? d : -d, true);
}

/** A band hugging a panel: the panel's path pushed `out` beyond it and `inn` into it. */
function strip(path: P[], out: number, inn: number): P[] {
  return [...offset(path, out), ...offset(path, -inn).reverse()];
}

/**
 * Extrudes a side profile across the car with rounded edges. The raw extrusion
 * spans x = −1…1 (bevel included) and `place` moves each vertex to its final
 * spot, so it sets the real width, which may vary with y and z (tumblehome,
 * flares, a band between two surfaces), and bends the panel in plan.
 * `round` is the edge rounding across the width, as a share of that −1…1;
 * `bevel` is the rounding within the profile, in metres.
 */
function extrude(
  profile: P[],
  o: { bevel: number; round: number; steps?: number; segments?: number },
  place: (v: Vector3) => void,
  uv?: (v: Vector3) => [number, number],
): BufferGeometry {
  const shape = new Shape(grow(profile, -o.bevel).map(([z, y]) => new Vector2(z, y)));
  const t = o.round;
  const g = new ExtrudeGeometry(shape, {
    depth: 2 - 2 * t,
    steps: o.steps ?? 1,
    bevelEnabled: true,
    bevelThickness: t,
    bevelSize: o.bevel,
    bevelSegments: o.segments ?? 1,
    curveSegments: 1,
  });
  // Shape x → car z, extrusion → car x (a proper rotation, so faces keep their winding).
  g.rotateY(-Math.PI / 2).translate(1 - t, 0, 0);
  const pos = g.attributes.position;
  const uvs = g.attributes.uv;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    place(v.fromBufferAttribute(pos, i));
    pos.setXYZ(i, v.x, v.y, v.z);
    if (uv) uvs.setXY(i, ...uv(v));
  }
  // Shade the flat faces (the profile's two caps) apart from the rounded edges
  // and walls: smoothed together, an edge would tint the whole of a big panel.
  return mergeGeometries(
    g.groups.map(({ start, count }) => {
      const piece = new BufferGeometry();
      for (const [name, a] of Object.entries(g.attributes)) {
        const n = a.itemSize;
        const slice = (a.array as Float32Array).slice(start * n, (start + count) * n);
        piece.setAttribute(name, new BufferAttribute(slice, n));
      }
      return toCreasedNormals(piece, CREASE);
    }),
  );
}

/** Diamond mesh for the grille, tiling. */
function meshTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1a1a1a';
  g.fillRect(0, 0, 32, 32);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(32, 32);
  g.moveTo(32, 0);
  g.lineTo(0, 32);
  g.stroke();
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * One road wheel, axle along X with its face on +X: tyre with rounded
 * shoulders, a dark ten-spoke alloy and the brake disc behind it. The caliper
 * comes back separately because it must not spin.
 */
function hatchWheel(R: number, tyre: Material): { wheel: Group; hub: Group } {
  const alloy = new MeshStandardMaterial({ color: 0x2c2f34, metalness: 0.7, roughness: 0.35, side: DoubleSide });
  const disc = new MeshStandardMaterial({ color: 0x8b8e93, metalness: 0.6, roughness: 0.5 });
  const caliper = new MeshStandardMaterial({ color: 0xc8161d, roughness: 0.45 });
  const h = TYRE_WIDTH / 2;
  const rim = R * 0.72; // 19-inch rim on a 0.335 m tyre
  const sec = [
    [rim, h - 0.005],
    [R - 0.03, h],
    [R, h - 0.045],
    [R, -h + 0.045],
    [R - 0.03, -h],
    [rim, -h + 0.005],
  ].map(([r, y]) => new Vector2(r, y));
  const tyreGeom = new LatheGeometry(sec, 12).rotateZ(-Math.PI / 2);

  // Five pairs of spokes from the hub to the rim, set out toward the face; the
  // barrel shows between them.
  const spokes: BufferGeometry[] = [];
  const len = rim - 0.05;
  for (let i = 0; i < 5; i++) {
    for (const s of [-1, 1]) {
      const a = (i / 5) * Math.PI * 2 + s * 0.14;
      spokes.push(
        new BoxGeometry(0.03, len, 0.03).translate(h - 0.035, 0.05 + len / 2, 0).rotateX(a),
      );
    }
  }
  spokes.push(new CylinderGeometry(0.06, 0.07, 0.05, 8).rotateZ(-Math.PI / 2).translate(h - 0.03, 0, 0));
  spokes.push(new CylinderGeometry(rim - 0.004, rim - 0.004, TYRE_WIDTH - 0.03, 10, 1, true).rotateZ(-Math.PI / 2));
  const wheel = new Group().add(
    new Mesh(tyreGeom, tyre),
    new Mesh(mergeGeometries(spokes), alloy),
    new Mesh(new CylinderGeometry(rim * 0.8, rim * 0.8, 0.025, 10).rotateZ(-Math.PI / 2).translate(0.005, 0, 0), disc),
  );

  // Behind the axle and a little up, astride the disc's edge.
  const a = 0.6;
  const r = rim * 0.8 - 0.015;
  const hub = new Group().add(
    new Mesh(
      new BoxGeometry(0.06, 0.13, 0.05).rotateX(-a).translate(0.035, r * Math.sin(a), r * Math.cos(a)),
      caliper,
    ),
  );
  return { wheel, hub };
}

/** Front-drive hot hatch: two-box shape, roof spoiler, big grille, flared arches, twin tips. */
export function hatchBody(k: BodyKit): Body {
  const { L, W, spec, paint, glass, part } = k;
  const R = spec.drivetrain.wheelRadius;
  const hw = W / 2;
  const zN = -L / 2; // nose
  const zT = L / 2; // tail
  const zC = zN + 0.27 * L; // cowl: bonnet meets windscreen
  const zA = zN + 0.49 * L; // windscreen meets roof
  const zS = zT - 0.118 * L; // roof meets rear glass
  const axles = [-k.wheelZ, k.wheelZ];
  const archR = R + 0.075;
  const sill = 0.19;
  /** How far the arches stand out: past the tyre's outer wall. */
  const flareX = Math.max(hw + 0.03, k.wheelX + TYRE_WIDTH / 2 + 0.025);

  const trim = new MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.25, metalness: 0.3 });
  const chrome = new MeshStandardMaterial({ color: 0xd0d3d8, metalness: 0.6, roughness: 0.25, side: DoubleSide });
  const grille = new MeshStandardMaterial({ color: 0x3c4046, roughness: 0.6, map: meshTexture() });

  // ---- Body sides and the bends every panel on them shares ----

  /** Half-width of the body sides: pulled in toward the nose, the tail and the shoulder. */
  const sideX: XAt = (y, z) => {
    const u = (z - zN) / L;
    let s = 1 - 0.035 * clamp01((y - 0.55) / 0.45);
    if (u < 0.25) s -= 0.1 * ((0.25 - u) / 0.25) ** 2;
    if (u > 0.85) s -= 0.07 * ((u - 0.85) / 0.15) ** 2;
    return hw * s;
  };
  /** Nose and tail corners swept back in plan; bonnet and tailgate crowned. */
  const bendBody = (v: Vector3) => {
    const x2 = (v.x / hw) ** 2;
    const nose = clamp01((zN + 0.8 - v.z) / 0.8) ** 3;
    const tail = clamp01((v.z - (zT - 0.5)) / 0.5) ** 2;
    v.z += (0.2 * nose - 0.14 * tail) * x2;
    v.y += 0.03 * Math.max(0, 1 - x2);
  };
  /** Places an extrusion between x = a and b on the body (a = −b for a centred part). */
  const onBody = (a: XAt, b: XAt) => (v: Vector3) => {
    v.x = lerp(a(v.y, v.z), b(v.y, v.z), (v.x + 1) / 2);
    bendBody(v);
  };
  const across = (f: XAt): [XAt, XAt] => [(y, z) => -f(y, z), f];

  // Lower body, clockwise from the chin. Indices mark the stretches trim follows.
  const a0 = Math.asin((sill - R) / archR); // where the arch meets the sill
  const prof = new Profile(zN + 0.08, 0.16).curve(zN, 0.16, zN, 0.27, 3);
  const iFace = prof.end;
  prof.line(zN + 0.04, 0.6, 4);
  const iNose = prof.end;
  prof.curve(zN + 0.03, 0.71, zN + 0.17, 0.745, 4);
  const iBonnet = prof.end;
  prof
    .curve(zN + 0.6, 0.86, zC, 0.955, 5)
    .line(zT - 0.4, 1.02, 4)
    .line(zT - 0.16, 1.04)
    .curve(zT - 0.02, 1.03, zT, 0.88, 4);
  const iTail = prof.end - 2; // just below the tailgate's top edge
  prof.line(zT + 0.005, 0.48, 4);
  const iBumper = prof.end;
  prof.curve(zT, 0.18, zT - 0.14, 0.17, 4).line(zT - 0.3, 0.175);
  const iUnder = prof.end;
  for (const z of [...axles].reverse()) prof.arc(z, R, archR, a0, Math.PI - a0, 10);
  const P = prof.pts;

  /** Adds a part already in place (car space). */
  const add = (geom: BufferGeometry, mat: Material) => part(geom, mat, 0, 0, 0);
  /** Adds a part on the right and its mirror image on the left. */
  const pair = (geom: BufferGeometry, mat: Material) => {
    add(geom, mat);
    add(geom, mat).scale.x = -1;
  };

  // ---- Cabin ----

  const cabinX0 = hw - 0.085;
  /** Half-width of the glasshouse: leaning in from the shoulder to the roof. */
  const cabinX = (y: number) => lerp(cabinX0, hw * 0.68, clamp01((y - 0.95) / 0.5));
  /** Windscreen pillars swept back, rear glass curved forward, roof crowned. */
  const bendCabin = (v: Vector3) => {
    const x2 = (v.x / cabinX0) ** 2;
    const front = 1 - smooth((v.z - zA + 0.15) / 0.35);
    const rear = smooth((v.z - zS + 0.3) / 0.3);
    v.z += (0.16 * front - 0.07 * rear) * x2;
    v.y += 0.03 * Math.max(0, 1 - x2) * smooth((v.y - 1.25) / 0.15);
  };
  const onCabin = (out: number, share = 1) => (v: Vector3) => {
    v.x *= (cabinX(v.y) + out) * share;
    bendCabin(v);
  };

  const cab = new Profile(zC + 0.03, 0.9)
    .line(zC + 0.06, 0.96)
    .line(zA - 0.12, 1.38, 3)
    .curve(zA, 1.445, zA + 0.2, 1.455, 3);
  const iRoof = cab.end;
  cab.curve((zA + zS) / 2, 1.47, zS - 0.15, 1.44, 4).curve(zS, 1.43, zS + 0.07, 1.37, 3);
  const iRearGlass = cab.end;
  cab.line(zT - 0.17, 1.02, 3);
  const iRearEnd = cab.end;
  cab.line(zT - 0.15, 0.9);
  const C = cab.pts;

  // Painted roof and D-pillars over the glass; the side windows show below the
  // roof's edge, ahead of the pillars.
  const pillarZ = zS - 0.42;
  const roofTop = C.slice(iRoof - 2, iRearEnd + 1);
  const roofUnder = offset(C.slice(iRoof - 2, iRoof + 4), -0.05).filter(([z]) => z < pillarZ);
  const roof: P[] = [
    ...offset(roofTop, 0.012),
    [zT - 0.16, 0.99],
    [zT - 0.62, 0.99],
    [pillarZ, 1.385],
    ...roofUnder.reverse(),
  ];
  add(extrude(roof, { bevel: 0.02, round: 0.07, steps: 3, segments: 2 }, onCabin(0.012)), paint);
  // Rear window, between the pillars.
  const rearGlass = strip(C.slice(iRearGlass, iRearEnd + 1), 0.02, 0.03);
  add(extrude(rearGlass, { bevel: 0.01, round: 0.06, steps: 4 }, onCabin(0, 0.8)), glass);
  // Roof spoiler, carrying the roofline out over the rear window.
  const spoiler: P[] = [
    [zS - 0.32, 1.462],
    [zS + 0.08, 1.475],
    [zS + 0.26, 1.44],
    [zS + 0.25, 1.415],
    [zS + 0.05, 1.41],
    [zS - 0.1, 1.43],
    [zS - 0.32, 1.445],
  ];
  add(extrude(spoiler, { bevel: 0.012, round: 0.06, steps: 4, segments: 2 }, onCabin(0.035)), paint);
  // High-level brake light along its trailing edge.
  const chmsl = new Vector3(0, 1.427, zS + 0.252);
  bendCabin(chmsl);
  part(new BoxGeometry(0.42, 0.014, 0.012), k.brake, chmsl.x, chmsl.y, chmsl.z);
  // The glasshouse itself, under all of that.
  add(extrude(C, { bevel: 0.03, round: 0.08, steps: 3, segments: 2 }, onCabin(0)), glass);

  // ---- Tail ----

  // Tail lights wrapping round the corners, a reversing light inboard of each.
  const tailRear: P[] = [...P.slice(iTail, iTail + 3), [zT + 0.001, 0.84]];
  const tail: P[] = [...offset(tailRear, 0.012), [zT - 0.1, 0.84], [zT - 0.34, 0.95], [zT - 0.3, 0.99]];
  pair(
    extrude(tail, { bevel: 0.03, round: 0.15 }, onBody(() => 0.41, (y, z) => sideX(y, z) + 0.012)),
    k.brake,
  );
  pair(extrude(strip(tailRear, 0.011, 0.03), { bevel: 0.01, round: 0.1 }, onBody(() => 0.32, () => 0.43)), k.reverse);
  // Diffuser across the bottom of the bumper, a tailpipe each side of it.
  const tipX = 0.66;
  const diffuser = strip([[zT + 0.003, 0.4], ...P.slice(iBumper + 1, iUnder + 1)], 0.012, 0.05);
  add(extrude(diffuser, { bevel: 0.01, round: 0.04, steps: 4 }, onBody(...across(() => tipX - 0.08))), k.dark);
  const tip = new Vector3(tipX, 0.27, zT - 0.03);
  bendBody(tip);
  pair(new CylinderGeometry(0.05, 0.05, 0.16, 12, 1, true).rotateX(Math.PI / 2).translate(tip.x, tip.y, tip.z), chrome);
  pair(new CylinderGeometry(0.042, 0.042, 0.01, 8).rotateX(Math.PI / 2).translate(tip.x, tip.y, tip.z + 0.04), k.dark);

  // ---- Nose ----

  // The big trapezoid grille, mesh-textured, down the bumper face…
  const grilleX: XAt = (y) => lerp(0.7, 0.46, (y - 0.27) / 0.33);
  const meshUv = (v: Vector3): [number, number] => [v.x / 0.07, v.y / 0.07];
  const grilleFace = strip(P.slice(iFace, iNose + 1), 0.012, 0.04);
  add(extrude(grilleFace, { bevel: 0.008, round: 0.03, steps: 4 }, onBody(...across(grilleX)), meshUv), grille);
  // …a splitter lip under it, and air curtains at the corners.
  const lip = strip(P.slice(0, iFace + 1), 0.03, 0.02);
  add(extrude(lip, { bevel: 0.008, round: 0.04, steps: 6 }, onBody(...across((y, z) => sideX(y, z) - 0.03))), k.dark);
  const curtain = strip(P.slice(iFace + 1, iFace + 4), 0.008, 0.03);
  pair(extrude(curtain, { bevel: 0.006, round: 0.2 }, onBody(() => 0.715, () => 0.79)), k.dark);
  // Slim headlights round the top of the nose, tapering inboard (the top edge
  // sinks into the nose there) and swept back with it.
  const lamp = onBody(() => 0.46, (y, z) => sideX(y, z) - 0.01);
  const yLamp = P[iNose][1];
  pair(
    extrude(strip(P.slice(iNose, iBonnet), 0.01, 0.04), { bevel: 0.01, round: 0.12 }, (v) => {
      v.y = yLamp + (v.y - yLamp) * lerp(0.3, 1, smooth((v.x + 1) / 1.4));
      lamp(v);
    }),
    k.head,
  );
  // Mirrors at the front of the doors: a slim stalk out to the housing, swept back.
  const zM = zC + 0.5;
  const yM = 1.07;
  const mirror: P[] = [
    [zM - 0.1, yM - 0.065],
    [zM + 0.08, yM - 0.065],
    [zM + 0.08, yM + 0.065],
    [zM - 0.1, yM + 0.065],
  ];
  pair(
    extrude(mirror, { bevel: 0.04, round: 0.25, segments: 2 }, (v) => {
      const t = (v.x + 1) / 2;
      const stalk = lerp(0.4, 1, smooth(t / 0.45));
      v.x = lerp(hw - 0.14, hw + 0.13, t);
      v.y = yM + (v.y - yM) * stalk;
      v.z += 0.06 * t;
    }),
    trim,
  );

  // ---- Lower body ----

  // Arches: a flare standing out past the tyre at the opening, fading into the
  // side; dark liners hide the paint inside.
  for (const z0 of axles) {
    const ro = archR + 0.16;
    const ri = archR - 0.012;
    const ao = Math.asin((0.22 - R) / ro);
    const ai = Math.asin((0.22 - R) / ri);
    const ring = new Profile(z0 + ro * Math.cos(ao), R + ro * Math.sin(ao))
      .arc(z0, R, ro, ao, Math.PI - ao, 8)
      .arc(z0, R, ri, Math.PI - ai, ai, 8)
      .pts.slice(1);
    const out: XAt = (y, z) => {
      const s = sideX(y, z);
      // Full at the lip, fading out across the panel and toward the sill.
      const lip = 1 - smooth((Math.hypot(z - z0, y - R) - archR) / 0.16);
      return s + 0.004 + (flareX - s) * lip * lerp(0.3, 1, smooth((y - 0.22) / 0.25));
    };
    pair(extrude(ring, { bevel: 0.025, round: 0.35 }, onBody((y, z) => sideX(y, z) - 0.08, out)), paint);
    const liner = new Profile(z0, R)
      .arc(z0, R, archR + 0.005, a0, Math.PI - a0, 8)
      .arc(z0, R, archR - 0.025, Math.PI - a0, a0, 8)
      .pts.slice(1);
    add(extrude(liner, { bevel: 0.005, round: 0.02 }, onBody(...across((y, z) => sideX(y, z) - 0.015))), k.dark);
  }

  // Side skirts between the arches.
  const skirt = new Profile(axles[0] + archR - 0.05, 0.14)
    .line(axles[1] - archR + 0.05, 0.14)
    .line(axles[1] - archR + 0.02, 0.25)
    .line(axles[0] + archR - 0.02, 0.25).pts;
  pair(
    extrude(skirt, { bevel: 0.02, round: 0.3 }, onBody((y, z) => sideX(y, z) - 0.05, (y, z) => sideX(y, z) + 0.025)),
    k.dark,
  );
  // And the body itself.
  const shell = add(
    extrude(prof.pts, { bevel: 0.045, round: 0.09, steps: 3, segments: 2 }, onBody(...across(sideX))),
    paint,
  );

  return { shell, ...hatchWheel(R, k.dark) };
}
