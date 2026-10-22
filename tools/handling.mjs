#!/usr/bin/env node
// Runs the car's physics (src/car/physics.ts) on a flat plane through scripted
// inputs and reports how it handles: grip, braking, launch, drifts held in each
// gear, and recovery. No browser or map tiles; takes a few seconds.
//
//   node tools/handling.mjs [filter] [--timeline] [--json]
//
//   filter       only scenarios whose name contains this text
//   --timeline   also print slip°/yaw°/km/h every 0.25 s
//   --json       machine-readable results
//
// Scenario steering is the input (−1 right … +1 left); a drift entered to the
// left has negative slip.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { Vector3 } from 'three';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false } });
const { CarPhysics } = await vite.ssrLoadModule('/src/car/physics.ts');
const { PHYSICS } = await vite.ssrLoadModule('/src/config.ts');
const dt = PHYSICS.dt;
const DEG = 180 / Math.PI;

// An endless flat floor at y = 0.
const floorObject = { userData: { solid: true } };
const collider = {
  candidateCount: 1,
  prepare() {},
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

// name → [start km/h, phases [seconds, input | (t) => input], options]
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
};

function simulate(kmh, phases, opts = {}) {
  const p = new CarPhysics();
  p.reset(new Vector3(0, 0, 0), 0);
  p.launch(kmh / 3.6);
  if (opts.gear) {
    p.drivetrain.mode = 'manual';
    p.drivetrain.gear = opts.gear;
  }
  let t = 0;
  let prevDir = Math.atan2(p.vel.x, -p.vel.z);
  const r = { timeline: [], drift: 0, maxSlip: 0, maxBodySlip: 0, path: 0, marks: {} };
  for (const [dur, inp] of phases) {
    const t0 = t;
    for (let i = 0; i < Math.round(dur / dt); i++) {
      p.step(typeof inp === 'function' ? inp(t - t0) : inp, dt, collider);
      t += dt;
      const dir = Math.atan2(p.vel.x, -p.vel.z);
      if (p.speed > 1) r.path += Math.atan2(Math.sin(dir - prevDir), Math.cos(dir - prevDir));
      prevDir = dir;
      if (p.drifting) r.drift += dt;
      r.maxSlip = Math.max(r.maxSlip, Math.abs(p.slip) * DEG);
      // p.slip is clamped for scoring; a spin shows in the unclamped angle.
      if (p.speed > 2 && p.drivetrain.gear > 0) r.maxBodySlip = Math.max(r.maxBodySlip, Math.abs(Math.atan2(p.vLateral, p.vForward)) * DEG);
      for (const m of [60, 100]) if (r.marks[m] === undefined && p.speed * 3.6 >= m) r.marks[m] = t;
      if (Math.round(t / dt) % 30 === 0) r.timeline.push({ t, slip: p.slip * DEG, yaw: p.yawRate * DEG, kmh: p.speed * 3.6, gear: p.drivetrain.gear, drifting: p.drifting });
    }
  }
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
    timeline: r.timeline,
  };
}

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
const results = {};
for (const [name, [kmh, phases, opts]] of Object.entries(SCENARIOS)) {
  if (filter && !name.includes(filter)) continue;
  results[name] = simulate(kmh, phases, opts);
}
await vite.close();

if (args.includes('--json')) {
  console.log(JSON.stringify(results, null, 1));
} else {
  const f = (n, w = 4) => n.toFixed(0).padStart(w);
  console.log(`${'scenario'.padEnd(34)} ${'held slip'.padStart(9)} ${'yaw°/s'.padStart(6)} ${'km/h'.padStart(5)}  ${'max slip'.padStart(8)} ${'path°'.padStart(6)} drift`);
  for (const [name, r] of Object.entries(results)) {
    const extra = name.startsWith('launch') ? `  0–60 ${r.zeroTo[60]?.toFixed(2)} s, 0–100 ${r.zeroTo[100]?.toFixed(2)} s` : '';
    console.log(
      `${name.padEnd(34)} ${f(r.held.slip, 8)}° ${f(r.held.yaw, 6)} ${f(r.held.kmh, 5)}  ${f(r.maxSlip, 7)}° ${f(r.path, 6)} ${r.drift.toFixed(1).padStart(4)} s${r.spun ? '  SPUN' : ''}${extra}`,
    );
    if (args.includes('--timeline'))
      console.log('    ' + r.timeline.map((w) => `${w.drifting ? '*' : ''}${w.slip.toFixed(0)}/${w.yaw.toFixed(0)}/${w.kmh.toFixed(0)}`).join(' '));
  }
}
