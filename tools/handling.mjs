#!/usr/bin/env node
// Runs the car's physics (src/car/physics.ts) on a flat plane through scripted
// inputs and reports how it handles: grip, braking, launch, drifts held in each
// gear, and recovery. No browser or map tiles; takes a few seconds.
//
//   node tools/handling.mjs [filter] [--car hatch|muscle] [--surface ID | --surfaces [--check]] [--all] [--timeline] [--json] [--compare REF]
//
//   filter       only scenarios whose name contains this text
//   --car        which car (default: the game's default)
//   --surface    the ground: asphalt (default), cobbles, gravel, grass, sand, water, ford
//   --surfaces   compare every surface on the key numbers instead (grip, braking,
//                launch, speed, coasting, drifts), each also as × asphalt
//   --check      implies --surfaces: both cars (or --car's) against the tuning
//                targets (TARGETS below); exits 1 if any is missed
//   --all        also the front-drive scenarios on a rear-drive car
//   --timeline   also print slip°/yaw°/km/h every 0.25 s
//   --json       machine-readable results
//   --compare REF  run the same (every car unless --car) at commit REF and in
//                the working tree, and list what differs; exits 1 if anything
//                does (tools/handling-compare.mjs)
//
// Scenario steering is the input (−1 right … +1 left); a drift entered to the
// left has negative slip.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { Vector3 } from 'three';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// SSR loads only: no client dep optimizer, which would otherwise rewrite (or,
// closed mid-run, leak temp dirs into) the dep cache a dev server is using.
const vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
const { CarPhysics } = await vite.ssrLoadModule('/src/car/physics.ts');
const { PHYSICS } = await vite.ssrLoadModule('/src/config.ts');
const { CARS, DEFAULT_CAR } = await vite.ssrLoadModule('/src/car/cars.ts');
const { SURFACES, SURFACE_IDS } = await vite.ssrLoadModule('/src/car/surfaces.ts');
const dt = PHYSICS.dt;
const DEG = 180 / Math.PI;

// An endless flat floor at y = 0, all of it `surface`.
const floorObject = { userData: { solid: true } };
let surface = 'asphalt';
const collider = {
  candidateCount: 1,
  prepare() {},
  surfaceAt() {
    return surface;
  },
  cast(o, d, far, out) {
    if (d.y > -0.5 || o.y < 0 || o.y > far) return null;
    const h = out ?? { point: new Vector3(), normal: new Vector3(), distance: 0, object: floorObject };
    h.point.set(o.x, 0, o.z);
    h.normal.set(0, 1, 0);
    h.distance = o.y;
    h.object = floorObject;
    return h;
  },
  castAll(o, d, far) {
    const h = this.cast(o, d, far);
    return h ? [h] : [];
  },
  castColumn(x, z, y, far) {
    return this.castAll(new Vector3(x, y, z), new Vector3(0, -1, 0), far);
  },
  castWide() {
    return null;
  },
};

const I = (throttle = 0, steer = 0, handbrake = false, brake = 0) => ({ throttle, brake, steer, handbrake });
const tap = (frac, period, on, off) => (t) => ((t % period) / period < frac ? on : off);
const HB = [0.3, I(0, 1, true)]; // handbrake pull at full left lock

// name → [start km/h, phases [seconds, input | (t) => input], options]. Options:
// gear (held in manual), fwd / rwd (tricks for one layout: run only for such a
// car, or with --all, so the other car's table stays comparable).
const SCENARIOS = {
  'grip 60 full lock': [60, [[3, I(0.3, 1)]]],
  'grip 100 full lock': [100, [[3, I(0.4, 1)]]],
  'grip 140 lane change': [140, [[0.4, I(0.6, 1)], [0.4, I(0.6, -1)], [1.5, I(0.6, 0)]]],
  'lift-off 110 full lock': [110, [[0.6, I(0.8, 1)], [2, I(0, 1)]]],
  'coast 120 full lock': [120, [[2.5, I(0, 1)]]],
  'light brake 100 full lock': [100, [[2.5, I(0, 1, false, 0.3)]]],
  'grip 150 full lock': [150, [[2.5, I(0.5, 1)]]],
  'brake 100': [100, [[2.5, I(0, 0, false, 1)]]],
  'brake 100 full lock': [100, [[2.5, I(0, 1, false, 1)]]],
  'launch 0-100': [0, [[6, I(1, 0)]]],
  'power-over 2nd, hold steer .4': [50, [[0.8, I(1, 1)], [3, I(1, 0.4)]], { gear: 2 }],
  'power-over 2nd, centre wheel': [50, [[0.8, I(1, 1)], [3, I(1, 0)]], { gear: 2 }],
  'power-over 2nd, feather 50%': [50, [[0.8, I(1, 1)], [3, tap(0.5, 0.25, I(1, 0.4), I(0, 0.4))]], { gear: 2 }],
  'handbrake 70, thr 1 steer .4': [70, [HB, [3, I(1, 0.4)]]],
  'handbrake 70, thr 1 full lock': [70, [HB, [3, I(1, 1)]]],
  'handbrake 70, thr 1 countersteer': [70, [HB, [3, I(1, -0.5)]]],
  'handbrake 70, lift': [70, [HB, [3, I(0, 0)]]],
  'handbrake 100, thr 1 steer .3': [100, [HB, [3, I(1, 0.3)]]],
  'gear 1 held drift': [45, [HB, [3.5, I(1, 0.4)]], { gear: 1 }],
  'gear 2 held drift': [60, [HB, [3.5, I(1, 0.4)]], { gear: 2 }],
  'gear 3 held drift': [85, [HB, [3.5, I(1, 0.4)]], { gear: 3 }],
  'gear 4 held drift': [110, [HB, [3.5, I(1, 0.4)]], { gear: 4 }],
  'gear 5 held drift': [130, [HB, [3.5, I(1, 0.4)]], { gear: 5 }],
  'reverse from rest': [0, [[2, I(0, 0, false, 1)], [2, I(1, 0)]]],

  // Front-drive: power understeers, lifting tucks the nose in and lets the
  // rear come round, and the handbrake starts slides the throttle pulls
  // straight. Over-committing (full lock, handbrake held) can still spin it.
  // Rear-drive: floored in 1st it lights up the tires; in 2nd it hooks up in a
  // straight line and lets go with moderate steering, the edge a handbrake blip
  // tips over into a drift that the throttle holds.
  'burnout 1st from rest': [0, [[2.5, I(1, 0)]], { rwd: true }],
  '2nd floored straight 40': [40, [[2.5, I(1, 0)]], { gear: 2, rwd: true }],
  '2nd floored steer .3 50': [50, [[3, I(1, 0.3)]], { gear: 2, rwd: true }],
  '2nd floored steer .4 50': [50, [[3, I(1, 0.4)]], { gear: 2, rwd: true }],
  '2nd floored steer .5 50': [50, [[3, I(1, 0.5)]], { gear: 2, rwd: true }],
  '2nd blip, thr 1 steer .4 50': [50, [[0.2, I(0, 0.6, true)], [3, I(1, 0.4)]], { gear: 2, rwd: true }],
  '2nd blip, thr .7 steer .3 60': [60, [[0.2, I(0, 0.6, true)], [3, I(0.7, 0.3)]], { gear: 2, rwd: true }],
  'power-on 80 steer .6': [80, [[3, I(1, 0.6)]], { fwd: true }],
  'lift-off 80 steer .6': [80, [[1.2, I(0.7, 0.6)], [2, I(0, 0.6)]], { fwd: true }],
  'lift-off 80 full lock': [80, [[0.8, I(0.7, 1)], [2, I(0, 1)]], { fwd: true }],
  'lift-off 110 steer .6': [110, [[1.2, I(0.7, 0.6)], [2, I(0, 0.6)]], { fwd: true }],
  'lift-off 110 steer .6, catch': [110, [[1.2, I(0.7, 0.6)], [0.8, I(0, 0.6)], [2, I(0.6, 0.2)]], { fwd: true }],
  'handbrake 70, thr .4 steer .4': [70, [HB, [3, I(0.4, 0.4)]], { fwd: true }],
  'handbrake 70, feather 50% steer .5': [70, [HB, [3, tap(0.5, 0.25, I(1, 0.5), I(0, 0.5))]], { fwd: true }],
  'handbrake 70, lift steer .4': [70, [HB, [3, I(0, 0.4)]], { fwd: true }],
  'handbrake 90, thr .5 steer .5': [90, [HB, [3, I(0.5, 0.5)]], { fwd: true }],
  'handbrake taps, thr 1 steer .5': [70, [HB, [3, tap(0.2, 0.75, I(1, 0.5, true), I(1, 0.5))]], { fwd: true }],
  'handbrake held 1.5 s, full lock': [70, [[1.5, I(0, 1, true)], [2, I(0, 1)]], { fwd: true }],
  'handbrake held 1 s, thr 1 full lock': [70, [[1, I(1, 1, true)], [2, I(1, 1)]], { fwd: true }],
  'scandinavian flick 80': [80, [[0.5, I(0.3, -0.7)], [0.4, I(0, 1)], [2.5, I(0.6, 0.4)]], { fwd: true }],
  'scandinavian flick 80, lift': [80, [[0.5, I(0.3, -0.7)], [0.5, I(0, 1)], [2.5, I(0.3, 0.3)]], { fwd: true }],
};

// `metrics` gets when and how far in the car first stopped (null if it didn't),
// the lateral g its tires held over the last 1.5 s and how long it drifted to
// the left (the way the scenarios' handbrake turns go).
function simulate(kmh, phases, opts = {}, metrics = {}) {
  const p = new CarPhysics({}, CARS[carId]);
  p.reset(new Vector3(0, 0, 0), 0);
  p.launch(kmh / 3.6);
  if (opts.gear) {
    p.drivetrain.mode = 'manual';
    p.drivetrain.gear = opts.gear;
  }
  let t = 0;
  let prevDir = Math.atan2(p.vel.x, -p.vel.z);
  const r = { timeline: [], drift: 0, maxSlip: 0, maxBodySlip: 0, path: 0, marks: {}, spin: 0 };
  const total = phases.reduce((s, [d]) => s + d, 0);
  let dist = 0;
  let lat = 0;
  let latN = 0;
  metrics.stopped = metrics.stopDist = null;
  metrics.driftLeft = 0;
  for (const [dur, inp] of phases) {
    const t0 = t;
    for (let i = 0; i < Math.round(dur / dt); i++) {
      p.step(typeof inp === 'function' ? inp(t - t0, p) : inp, dt, collider);
      t += dt;
      dist += p.speed * dt;
      if (metrics.stopped === null && kmh > 0 && p.speed < 0.3) {
        metrics.stopped = t;
        metrics.stopDist = dist;
      }
      if (p.drifting && p.slip < 0) metrics.driftLeft += dt;
      if (t > total - 1.5) {
        lat += Math.abs(p.tire.forceF[1] + p.tire.forceR[1]) / (p.car.chassis.mass * 9.81);
        latN++;
      }
      const dir = Math.atan2(p.vel.x, -p.vel.z);
      if (p.speed > 1) r.path += Math.atan2(Math.sin(dir - prevDir), Math.cos(dir - prevDir));
      prevDir = dir;
      if (p.drifting) r.drift += dt;
      r.spin += p.wheelSpin * dt;
      r.maxSlip = Math.max(r.maxSlip, Math.abs(p.slip) * DEG);
      // p.slip is clamped for scoring; a spin shows in the unclamped angle.
      if (p.speed > 2 && p.drivetrain.gear > 0) r.maxBodySlip = Math.max(r.maxBodySlip, Math.abs(Math.atan2(p.vLateral, p.vForward)) * DEG);
      for (const m of [60, 96.56, 100]) if (r.marks[m] === undefined && p.speed * 3.6 >= m) r.marks[m] = t; // 96.56 km/h = 60 mph
      if (Math.round(t / dt) % 30 === 0) r.timeline.push({ t, slip: p.slip * DEG, yaw: p.yawRate * DEG, kmh: p.speed * 3.6, gear: p.drivetrain.gear, drifting: p.drifting });
    }
  }
  metrics.latG = lat / Math.max(1, latN);
  // "Held": the last 1.5 s.
  const tail = r.timeline.filter((w) => w.t > t - 1.5);
  const mean = (k) => tail.reduce((s, w) => s + w[k], 0) / Math.max(1, tail.length);
  return {
    held: { slip: mean('slip'), yaw: mean('yaw'), kmh: mean('kmh') },
    end: p.speed * 3.6,
    drift: r.drift,
    maxSlip: r.maxSlip,
    path: -r.path * DEG,
    spun: r.maxBodySlip > 100,
    zeroTo: r.marks,
    spin: r.spin / Math.max(t, dt),
    timeline: r.timeline,
  };
}

const args = process.argv.slice(2);
const compareAt = args.indexOf('--compare');
const compareRef = compareAt >= 0 ? args.splice(compareAt, 2)[1] : null;
if (compareAt >= 0 && !compareRef) throw new Error('--compare needs a commit, e.g. --compare master');
// --check only means anything on the surface table: alone it would run the
// plain scenarios and pass having checked nothing.
if (args.includes('--check') && !args.includes('--surfaces')) args.push('--surfaces');
// The arguments as given, less --compare: what both sides of a comparison run with.
const passOn = [...args];
const carAt = args.indexOf('--car');
const carGiven = carAt >= 0 ? args.splice(carAt, 2)[1] : null;
let carId = carGiven ?? DEFAULT_CAR;
if (!CARS[carId]) throw new Error(`unknown car ${carId}; one of ${Object.keys(CARS).join(', ')}`);
const surfaceArg = args.indexOf('--surface');
if (surfaceArg >= 0) surface = args.splice(surfaceArg, 2)[1];
if (!SURFACES[surface]) throw new Error(`unknown surface ${surface}; one of ${SURFACE_IDS.join(', ')}`);
const filter = args.find((a) => !a.startsWith('--'));

function runScenarios() {
  const results = {};
  for (const [name, [kmh, phases, opts]] of Object.entries(SCENARIOS)) {
    if (filter && !name.includes(filter)) continue;
    if (((opts?.fwd && CARS[carId].drive !== 'fwd') || (opts?.rwd && CARS[carId].drive !== 'rwd')) && !args.includes('--all')) continue;
    results[name] = simulate(kmh, phases, opts);
  }
  return results;
}

// Slides started on purpose: their drift time and the slip they hold.
const DRIFTS = /handbrake|drift|flick|lift-off|power-over|blip|floored steer/;

/**
 * A driver holding a left-hand drift at 25°: a little steering into the slide,
 * more while it is shallower, less (or countersteer) while deeper, damped by
 * how fast it changes; a tap of the handbrake when it is dying away; and on a
 * rear-drive car, the throttle to set the angle. The same hands on every
 * surface, so how long they keep it sliding says how easy the surface makes it.
 */
function holdDrift(rwd) {
  const target = 25 / DEG;
  let prev = null;
  return (t, p) => {
    const slip = -p.slip;
    const rate = prev === null ? 0 : (slip - prev) / dt;
    prev = slip;
    const e = target - slip;
    const throttle = rwd ? Math.max(0, Math.min(1, 0.5 + 3 * e)) : 0.5;
    return I(throttle, Math.max(-1, Math.min(1, 0.3 + 2 * e - 0.3 * rate)), e > 12 / DEG && rate < 0);
  };
}

/** The key numbers on the current surface. */
function surfaceSummary() {
  const results = runScenarios();
  const skid = {};
  simulate(60, [[3, I(0.3, 1)]], {}, skid);
  const brake = {};
  simulate(100, [[10, I(0, 0, false, 1)]], {}, brake);
  const launch = simulate(0, [[20, I(1, 0)]]);
  const coast = {};
  simulate(80, [[20, I(0, 0)]], {}, coast);
  // Into a handbrake turn at 70, then 6 s of holding it.
  const hold = {};
  const holding = simulate(70, [[0.4, I(0, 1, true)], [6, holdDrift(CARS[carId].drive === 'rwd')]], {}, hold);
  const drifts = Object.entries(results).filter(([name]) => DRIFTS.test(name));
  return {
    // Full lock from 60: the tires' sideways force over the last 1.5 s.
    latG: skid.latG,
    brakeM: brake.stopDist,
    brakeS: brake.stopped,
    zeroTo100: launch.zeroTo[100] ?? null,
    kmh20s: launch.end,
    coastS: coast.stopped,
    driftS: drifts.reduce((s, [, r]) => s + r.drift, 0),
    heldSlip: drifts.reduce((s, [, r]) => s + Math.abs(r.held.slip), 0) / Math.max(1, drifts.length),
    maxSlip: drifts.reduce((s, [, r]) => s + r.maxSlip, 0) / Math.max(1, drifts.length),
    spun: Object.values(results).filter((r) => r.spun).length,
    scenarios: Object.keys(results).length,
    hold: hold.driftLeft,
    holdSpun: holding.spun,
  };
}

/**
 * Tuning targets for `--surfaces --check`: each surface's number against
 * asphalt's (×) or as it is. The hot hatch's are the agreed targets. The
 * muscle car's are the same bands, loosened where its tuning sits on or near
 * an edge today; each loosened bound notes the number it had when set.
 */
const TARGETS = {
  hatch: [
    { surface: 'gravel', key: 'latG', x: true, lo: 0.6, hi: 0.7 },
    { surface: 'gravel', key: 'brakeM', x: true, lo: 1.4, hi: 1.7 },
    { surface: 'gravel', key: 'zeroTo100', x: true, lo: 1.3, hi: 1.6 },
    // Easier to keep sliding than on asphalt.
    { surface: 'gravel', key: 'hold', x: true, above: 1 },
    { surface: 'grass', key: 'latG', x: true, lo: 0.4, hi: 0.5 },
    { surface: 'grass', key: 'brakeM', x: true, lo: 2, hi: 2.5 },
    // Hard going but not bogged: 80 km/h to a stop in about 5 s off the
    // throttle (5.3 s when set), about 30 km/h flat out (29 when set).
    { surface: 'sand', key: 'coastS', lo: 4.5, hi: 5.5 },
    { surface: 'sand', key: 'kmh20s', lo: 25, hi: 35 },
    { surface: 'cobbles', key: 'latG', x: true, below: 1 },
    { surface: 'water', key: 'latG', x: true, below: 0.25 },
    // Still moving after 20 s flat out: a car that gets out before it sinks can crawl.
    { surface: 'water', key: 'kmh20s', above: 0 },
    // But only crawl (6.5 when set), and a coast stops within a few seconds
    // (4.7 s when set): water's drag and rolling resistance are doing their job.
    { surface: 'water', key: 'kmh20s', below: 15 },
    { surface: 'water', key: 'coastS', hi: 5.5 },
    // A ford: slippery and slow, but a car keeps going across it.
    { surface: 'ford', key: 'latG', x: true, lo: 0.4, hi: 0.6 },
    { surface: 'ford', key: 'kmh20s', lo: 20, hi: 60 },
  ],
  muscle: [
    // ×0.70 when set: on the hatch's upper edge.
    { surface: 'gravel', key: 'latG', x: true, lo: 0.6, hi: 0.75 },
    // ×1.44 when set: near the hatch's 1.4 floor.
    { surface: 'gravel', key: 'brakeM', x: true, lo: 1.35, hi: 1.7 },
    // ×1.58 when set: near the hatch's 1.6 cap.
    { surface: 'gravel', key: 'zeroTo100', x: true, lo: 1.3, hi: 1.7 },
    { surface: 'gravel', key: 'hold', x: true, above: 1 },
    // ×0.41 when set: near the hatch's 0.4 floor.
    { surface: 'grass', key: 'latG', x: true, lo: 0.37, hi: 0.5 },
    // ×2.03 when set: near the hatch's 2.0 floor.
    { surface: 'grass', key: 'brakeM', x: true, lo: 1.9, hi: 2.5 },
    // 5.2 s and 42 km/h when set: more power, so faster through it than the hatch.
    { surface: 'sand', key: 'coastS', lo: 4.5, hi: 5.5 },
    { surface: 'sand', key: 'kmh20s', lo: 25, hi: 50 },
    { surface: 'cobbles', key: 'latG', x: true, below: 1 },
    { surface: 'water', key: 'latG', x: true, below: 0.25 },
    { surface: 'water', key: 'kmh20s', above: 0 },
    // 6.0 km/h and 4.6 s when set.
    { surface: 'water', key: 'kmh20s', below: 15 },
    { surface: 'water', key: 'coastS', hi: 5.5 },
    { surface: 'ford', key: 'latG', x: true, lo: 0.4, hi: 0.6 },
    { surface: 'ford', key: 'kmh20s', lo: 20, hi: 70 },
  ],
};
const METRICS = {
  latG: 'lateral grip',
  brakeM: 'braking 100–0 (m)',
  zeroTo100: '0–100 km/h (s)',
  hold: 'drift held (s)',
  coastS: 'coast 80–0 (s)',
  kmh20s: 'km/h after 20 s flat out',
};

/** Every target for `car` against its surfaces table: [{ car, target, value, ok }]. */
function checkTargets(car, table) {
  return (TARGETS[car] ?? []).map((target) => {
    const v = table[target.surface][target.key];
    const base = table.asphalt[target.key];
    // Null: never got there (no stop, no 100 km/h), which misses any bound.
    const value = v === null || (target.x && !base) ? null : target.x ? v / base : v;
    const ok =
      value !== null &&
      (target.lo === undefined || value >= target.lo) &&
      (target.hi === undefined || value <= target.hi) &&
      (target.above === undefined || value > target.above) &&
      (target.below === undefined || value < target.below);
    return { car, target, value, ok };
  });
}

function boundText(t) {
  const x = t.x ? '×' : '';
  if (t.lo !== undefined && t.hi !== undefined) return `${x}${t.lo}–${t.hi}`;
  if (t.hi !== undefined) return `≤ ${x}${t.hi}`;
  return t.above !== undefined ? `> ${x}${t.above}` : `< ${x}${t.below}`;
}

/** The --surfaces numbers for the current car, by surface. */
function surfaceTable() {
  const table = {};
  for (const id of SURFACE_IDS) {
    surface = id;
    table[id] = surfaceSummary();
  }
  return table;
}

function printSurfaces(table) {
  const base = table.asphalt;
  // A value and its ratio to asphalt's.
  const x = (v, b, digits, unit, w) => {
    if (v === null) return '—'.padEnd(w);
    const ratio = b ? ` ×${(v / b).toFixed(2)}` : '';
    return `${v.toFixed(digits)}${unit}${ratio}`.padEnd(w);
  };
  console.log(
    `${CARS[carId].name}: ${'surface'.padEnd(8)} ${'lat g'.padEnd(11)} ${'brake 100–0'.padEnd(20)} ${'0–100'.padEnd(13)} ${'km/h @20 s'.padEnd(13)} ${'coast 80–0'.padEnd(14)} ${'drift'.padEnd(13)} held/max slip  spun   drift held`,
  );
  for (const [id, m] of Object.entries(table)) {
    console.log(
      `${''.padEnd(CARS[carId].name.length + 2)}${id.padEnd(8)} ${x(m.latG, base.latG, 2, '', 11)} ${x(m.brakeM, base.brakeM, 0, ' m', 11)} ${x(m.brakeS, null, 1, ' s', 8)} ${x(m.zeroTo100, base.zeroTo100, 1, ' s', 13)} ${x(m.kmh20s, base.kmh20s, 0, '', 13)} ${x(m.coastS, base.coastS, 1, ' s', 14)} ${x(m.driftS, base.driftS, 0, ' s', 13)} ${`${m.heldSlip.toFixed(0)}°/${m.maxSlip.toFixed(0)}°`.padEnd(14)} ${`${m.spun}/${m.scenarios}`.padEnd(6)} ${m.hold.toFixed(1)} s${m.holdSpun ? ' SPUN' : ''}`,
    );
  }
}

if (compareRef) {
  await vite.close();
  const { compare } = await import('./handling-compare.mjs');
  process.exit(await compare(ROOT, compareRef, passOn, carGiven ? [carGiven] : Object.keys(CARS)));
} else if (args.includes('--surfaces')) {
  // --check: both cars (or the one asked for), each against its targets.
  const check = args.includes('--check');
  const cars = check && !carGiven ? Object.keys(CARS) : [carId];
  const tables = {};
  for (const id of cars) {
    carId = id;
    tables[id] = surfaceTable();
  }
  await vite.close();
  const results = check ? cars.flatMap((id) => checkTargets(id, tables[id])) : [];
  const missed = results.filter((r) => !r.ok);
  if (args.includes('--json')) {
    const checks = results.map(({ car, target, value, ok }) => ({ car, ...target, bound: boundText(target), value, ok }));
    console.log(JSON.stringify(check ? { ok: !missed.length, tables, checks } : tables[carId], null, 1));
  } else {
    for (const id of cars) {
      carId = id;
      printSurfaces(tables[id]);
    }
    if (check) {
      console.log(`\n${'car'.padEnd(7)} ${'surface'.padEnd(8)} ${'target'.padEnd(25)} ${'value'.padEnd(8)} ${'bound'.padEnd(11)}`);
      for (const r of results) {
        const v = r.value === null ? '—' : `${r.target.x ? '×' : ''}${r.value.toFixed(r.target.x ? 3 : 1)}`;
        console.log(`${r.car.padEnd(7)} ${r.target.surface.padEnd(8)} ${METRICS[r.target.key].padEnd(25)} ${v.padEnd(8)} ${boundText(r.target).padEnd(11)} ${r.ok ? 'ok' : 'FAIL'}`);
      }
      console.log(missed.length ? `\n${missed.length} of ${results.length} targets missed` : `\nall ${results.length} targets met`);
    }
  }
  if (missed.length) process.exit(1);
} else {
  const results = runScenarios();
  await vite.close();

  if (args.includes('--json')) {
    console.log(JSON.stringify(results, null, 1));
  } else {
    const f = (n, w = 4) => n.toFixed(0).padStart(w);
    console.log(`${'scenario'.padEnd(34)} ${'held slip'.padStart(9)} ${'yaw°/s'.padStart(6)} ${'km/h'.padStart(5)}  ${'max slip'.padStart(8)} ${'path°'.padStart(6)} drift  spin m/s`);
    for (const [name, r] of Object.entries(results)) {
      // Marks not reached in the scenario's time show as '—'.
      const z = (m) => (r.zeroTo[m] === undefined ? '—' : `${r.zeroTo[m].toFixed(2)} s`);
      const extra = name.startsWith('launch') ? `  0–60 ${z(60)}, 0–100 ${z(100)} (0–60 mph ${z(96.56)})` : '';
      console.log(
        `${name.padEnd(34)} ${f(r.held.slip, 8)}° ${f(r.held.yaw, 6)} ${f(r.held.kmh, 5)}  ${f(r.maxSlip, 7)}° ${f(r.path, 6)} ${r.drift.toFixed(1).padStart(4)} s ${r.spin.toFixed(1).padStart(5)}${r.spun ? '  SPUN' : ''}${extra}`,
      );
      if (args.includes('--timeline'))
        console.log('    ' + r.timeline.map((w) => `${w.drifting ? '*' : ''}${w.slip.toFixed(0)}/${w.yaw.toFixed(0)}/${w.kmh.toFixed(0)}`).join(' '));
    }
  }
}
