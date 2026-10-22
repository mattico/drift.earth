#!/usr/bin/env node
// Summarises a drift.earth debug trace (F9 in the game, or tools/capture.mjs).
//
//   node tools/trace-report.mjs traces/drift-….json [--window -8:-5] [--episodes 40] [--json]
//
// Times are seconds relative to the end of the trace (t-3.20 = 3.2 s before it
// was saved). --window dumps the per-step frames for that span at 40 Hz.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROBES = 'gbmd'; // ground, blocked (ledge), miss, drop
const FLAGS = [
  [1, 'A'], // airborne
  [2, 'W'], // waiting for tiles
  [4, 'D'], // drifting
  [8, 'C'], // contact
  [16, 'L'], // long probe used
  [32, 'T'], // in a tunnel (virtual road)
];

export function analyse(trace) {
  const cols = Object.fromEntries(trace.frames.columns.map((c, i) => [c, i]));
  const rows = trace.frames.rows;
  const dt = trace.meta?.physics?.dt ?? 1 / 120;
  const events = trace.events ?? [];
  const lastStep = rows.length ? rows[rows.length - 1][cols.step] : 0;
  const rel = (step) => (step - lastStep) * dt;
  const get = (r, c) => r[cols[c]];

  // Episodes: runs of steps with wall pushes or edge stops, merged across short gaps.
  const episodes = [];
  let cur = null;
  rows.forEach((r, i) => {
    const hit = get(r, 'wallPen') > 0 || get(r, 'edge') > 0;
    if (!hit) return;
    if (cur && i - cur.end <= 12) cur.end = i;
    else {
      cur = { start: i, end: i };
      episodes.push(cur);
    }
  });
  for (const e of episodes) {
    const r0 = rows[e.start];
    let before = 0;
    for (let i = Math.max(0, e.start - 36); i < e.start; i++) before = Math.max(before, get(rows[i], 'speed'));
    if (e.start === 0) before = get(r0, 'speed');
    let after = Infinity;
    for (let i = e.start; i <= Math.min(rows.length - 1, e.end + 24); i++) after = Math.min(after, get(rows[i], 'speed'));
    const kinds = { wall: 0, ledge: 0, drop: 0 };
    const rays = new Map();
    let first = null;
    let firstIdx = -1;
    let maxPen = 0;
    for (let i = e.start; i <= e.end; i++) {
      const r = rows[i];
      if (get(r, 'wallPen') > 0) {
        kinds.wall++;
        rays.set(get(r, 'wallRay'), (rays.get(get(r, 'wallRay')) ?? 0) + 1);
        maxPen = Math.max(maxPen, get(r, 'wallPen'));
        if (!first) {
          first = r;
          firstIdx = i;
        }
      }
      if (get(r, 'edge') === 1) kinds.ledge++;
      if (get(r, 'edge') === 2) kinds.drop++;
    }
    e.t = rel(get(r0, 'step'));
    e.duration = (e.end - e.start + 1) * dt;
    e.pos = [get(r0, 'x'), get(r0, 'y'), get(r0, 'z')];
    e.epoch = get(r0, 'epoch');
    e.speedBefore = before;
    e.speedAfter = after;
    e.throttle = get(r0, 'throttle');
    e.kinds = kinds;
    e.maxPen = maxPen;
    e.probes = decodeProbes(get(r0, 'probes'));
    e.stop = before > 3 && after < before * 0.5;
    if (first) {
      // Rows hold post-collision velocity; the step before shows the approach.
      const approach = rows[Math.max(0, firstIdx - 1)];
      const vx = get(approach, 'vx');
      const vz = get(approach, 'vz');
      const nx = get(first, 'wallNx');
      const nz = get(first, 'wallNz');
      const sp = Math.hypot(vx, vz) || 1;
      e.wall = {
        point: [get(first, 'wallX'), get(first, 'wallY'), get(first, 'wallZ')],
        heightAboveGround: get(first, 'wallY') - get(first, 'groundY'),
        normal: [nx, nz],
        // 90° = head-on, 0° = grazing.
        incidence: (Math.asin(Math.min(1, Math.abs((vx * nx + vz * nz) / sp))) * 180) / Math.PI,
        ray: [...rays.entries()].sort((a, b) => b[1] - a[1])[0][0],
        tileError: get(first, 'wallGe'),
      };
      e.overpass = nearbyOverpass(events, rows, cols, e.wall.point, e.epoch);
    }
    e.repro = reproLink(trace, rows, cols, events, Math.max(0, e.start - Math.round(2 / dt)));
  }

  // Drifts: runs of the drifting flag.
  const drifts = [];
  let d = null;
  rows.forEach((r, i) => {
    if (!(get(r, 'flags') & 4)) {
      d = null;
      return;
    }
    if (!d || i !== d.end + 1) {
      d = { start: i, end: i, maxSlip: 0, speed: 0, throttle: 0, handbrake: 0, gears: new Set(), n: 0, turn: 0, prevDir: null };
      drifts.push(d);
    }
    d.end = i;
    const s = slipOf(r, cols);
    if (Math.abs(s) > Math.abs(d.maxSlip)) d.maxSlip = s;
    d.speed += get(r, 'speed');
    d.throttle += get(r, 'throttle');
    d.handbrake += get(r, 'handbrake');
    if (cols.gear !== undefined) d.gears.add(get(r, 'gear') % 10);
    d.n++;
    // Path turn, accumulated so it doesn't wrap at ±180°.
    if (get(r, 'speed') > 1) {
      const a = Math.atan2(get(r, 'vx'), -get(r, 'vz'));
      if (d.prevDir !== null) d.turn += Math.atan2(Math.sin(a - d.prevDir), Math.cos(a - d.prevDir));
      d.prevDir = a;
    }
  });
  for (const e of drifts) {
    const r0 = rows[e.start];
    e.t = rel(get(r0, 'step'));
    e.duration = e.n * dt;
    e.speed /= e.n;
    e.throttle /= e.n;
    e.handbrake /= e.n;
    // How far the direction of travel turned over the drift (left +).
    e.turn = (-e.turn * 180) / Math.PI;
    delete e.prevDir;
    e.gears = [...e.gears].sort((x, y) => x - y);
  }

  // Hard decelerations with no contact (and no brake) — invisible walls the solver didn't log.
  const decels = [];
  const win = Math.round(0.25 / dt);
  for (let i = win; i < rows.length; i += 6) {
    const a = rows[i - win];
    const b = rows[i];
    if (get(a, 'speed') - get(b, 'speed') < 4 || get(b, 'brake') > 0 || get(b, 'handbrake')) continue;
    let touched = false;
    for (let k = i - win; k <= i; k++) if (get(rows[k], 'wallPen') > 0 || get(rows[k], 'edge') > 0) touched = true;
    if (touched) continue;
    if (decels.length && i - decels[decels.length - 1].i < win * 2) continue;
    decels.push({ i, t: rel(get(b, 'step')), from: get(a, 'speed'), to: get(b, 'speed'), pos: [get(b, 'x'), get(b, 'y'), get(b, 'z')] });
  }

  const samples = events.filter((e) => e.kind === 'sample');
  const logs = events.filter((e) => e.kind === 'log');
  const marks = events.filter((e) => e.kind === 'mark');
  const other = events.filter((e) => !['sample', 'log', 'overpass'].includes(e.kind));
  let dist = 0;
  let maxSpeed = 0;
  let air = 0;
  let wait = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (get(a, 'epoch') === get(b, 'epoch')) dist += Math.hypot(get(b, 'x') - get(a, 'x'), get(b, 'z') - get(a, 'z'));
    maxSpeed = Math.max(maxSpeed, get(b, 'speed'));
    if (get(b, 'flags') & 1) air += dt;
    if (get(b, 'flags') & 2) wait += dt;
  }
  return { cols, rows, dt, rel, episodes, drifts, decels, samples, logs, marks, other, events, dist, maxSpeed, air, wait, lastStep };
}

/** Body slip angle (°) of a frame, from its velocity and heading: negative with the rear out to the right. */
function slipOf(r, cols) {
  const h = r[cols.heading];
  const vx = r[cols.vx];
  const vz = r[cols.vz];
  const vF = -vx * Math.sin(h) - vz * Math.cos(h);
  const vL = -vx * Math.cos(h) + vz * Math.sin(h);
  return (Math.atan2(vL, Math.max(Math.abs(vF), 1)) * 180) / Math.PI;
}

function decodeProbes(v) {
  return [0, 2, 4, 6].map((s) => PROBES[(v >> s) & 3]).join('');
}

function decodeFlags(v) {
  return FLAGS.map(([bit, ch]) => (v & bit ? ch : '·')).join('');
}

/** Map a physics step to the epoch it ran in (events only carry the step). */
function epochAt(rows, cols, step) {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid][cols.step] <= step) lo = mid;
    else hi = mid - 1;
  }
  return rows.length ? rows[lo][cols.epoch] : 0;
}

function nearbyOverpass(events, rows, cols, p, epoch) {
  // The most recent decision near the hit point (overpass or car-blob test).
  let best = null;
  for (const e of events) {
    if (e.kind !== 'overpass') continue;
    if (epochAt(rows, cols, e.step) !== epoch) continue;
    const d = Math.hypot(e.hit[0] - p[0], e.hit[2] - p[2]);
    if (d < 3 && (!best || d <= best.d + 0.5)) best = { d: Math.min(d, best?.d ?? d), e };
  }
  if (!best) return null;
  const e = best.e;
  const fmt = (s) => `${s[0].toFixed(1)}:${s[1] === null ? '–' : s[1].toFixed(1)}`;
  const phase = (p) => e.samples.filter((s) => s[2] === p).map(fmt).join(' ');
  return {
    result: e.result
      ? e.reason === 'blob'
        ? 'car blob (passed)'
        : e.reason.startsWith('portal')
          ? 'underpass/tunnel portal'
          : e.reason.startsWith('tunnel')
            ? 'tunnel exit'
            : 'overpass'
      : 'wall',
    reason: e.overpass ? `${e.reason}; overpass test: ${e.overpass}` : e.reason,
    deck: e.start >= 0 ? `${e.deck.toFixed(1)} m at ${e.start.toFixed(1)} m` : null,
    samples: ['skirt', 'far', 'along', 'side'].filter((p) => phase(p)).map((p) => `${p}[${phase(p)}]`).join(' '),
    distance: best.d,
  };
}

/** Deep link that respawns at row `i` with its heading, ground height and speed. */
function reproLink(trace, rows, cols, events, i) {
  const r = rows[i];
  if (!r) return null;
  const epoch = r[cols.epoch];
  let s = null;
  for (const e of events) {
    if (e.kind !== 'sample' || !e.geo) continue;
    if (epochAt(rows, cols, e.step) !== epoch) continue;
    if (!s || Math.abs(e.step - r[cols.step]) < Math.abs(s.step - r[cols.step])) s = e;
  }
  const url = trace.meta?.url ? new URL(trace.meta.url) : null;
  const base = url ? `${url.origin}${url.pathname}` : '/';
  if (!s) return trace.meta?.world === 'practice' ? `${base}?practice` : null;
  // Local tangent frame: +X east, −Z north. Good to centimetres over a few km.
  const dE = r[cols.x] - s.pos[0];
  const dN = -(r[cols.z] - s.pos[2]);
  const lat = s.geo.lat + dN / 111132.954;
  const lon = s.geo.lon + dE / (111319.49 * Math.cos((s.geo.lat * Math.PI) / 180));
  const sampleGround = s.geo.height - (s.pos[1] - s.groundY);
  const h = sampleGround + (r[cols.groundY] - s.groundY);
  const bearing = Math.round(((((-r[cols.heading] * 180) / Math.PI) % 360) + 360) % 360);
  const q = new URLSearchParams({ lat: lat.toFixed(7), lon: lon.toFixed(7), bearing: String(bearing), h: h.toFixed(2) });
  // Signed forward speed: a reversing car respawns reversing.
  const hd = r[cols.heading];
  const kmh = Math.round(-(r[cols.vx] * Math.sin(hd) + r[cols.vz] * Math.cos(hd)) * 3.6);
  if (kmh) q.set('kmh', String(kmh));
  return `${base}?${q}`;
}

const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);
const kmh = (v) => `${Math.round(v * 3.6)} km/h`;
const T = (t) => `t${t >= 0 ? '+' : ''}${t.toFixed(2)}`;

export function report(trace, opts = {}) {
  const a = analyse(trace);
  const m = trace.meta ?? {};
  const out = [];
  const say = (s = '') => out.push(s);
  say(`drift trace ${m.label ? `“${m.label}” ` : ''}${m.createdAt ?? ''}`);
  say(`  ${m.world ?? '?'} world · ${m.url ?? ''}`);
  say(`  ${m.gpu ?? 'unknown GPU'} · ${(m.viewport ?? []).join('×')}`);
  say(
    `  ${a.rows.length} steps (${f1(a.rows.length * a.dt)} s) · ${a.events.length} events · ${f1(a.dist)} m driven · max ${kmh(a.maxSpeed)} · airborne ${f1(a.air)} s · waiting ${f1(a.wait)} s`,
  );
  if (m.car) say(`  end: pos ${m.car.pos.map(f1).join(', ')} · ${kmh(m.car.speed)}${m.repro ? `\n  repro: ${m.repro}` : ''}`);

  if (a.samples.length) {
    const fps = a.samples.map((s) => s.fps).sort((x, y) => x - y);
    const pick = (q) => fps[Math.min(fps.length - 1, Math.floor(q * fps.length))];
    const worst = Math.max(...a.samples.map((s) => s.frameMaxMs));
    const avg = (k) => a.samples.reduce((s, e) => s + (e[k] ?? 0), 0) / a.samples.length;
    const tiles = a.samples.map((s) => s.tiles?.active).filter((v) => v !== undefined);
    say();
    say(
      `perf: fps p10 ${f1(pick(0.1))} · median ${f1(pick(0.5))} · worst frame ${f1(worst)} ms · update ${f2(avg('physMs'))} ms · render ${f2(avg('renderMs'))} ms · ${Math.round(avg('calls'))} draws`,
    );
    if (tiles.length) say(`      tiles active ${Math.min(...tiles)}–${Math.max(...tiles)} · heap ${f1(avg('heapMB') || 0)} MB`);
  }

  if (a.marks.length) {
    say();
    say('marks:');
    for (const k of a.marks) say(`  ${T(a.rel(k.step))}  “${k.label}” at ${k.pos.map(f1).join(', ')}`);
  }

  const max = opts.episodes ?? 25;
  say();
  say(`contacts: ${a.episodes.length} episode(s)${a.episodes.length > max ? `, showing the last ${max}` : ''}  (STOP = lost over half its speed)`);
  for (const e of a.episodes.slice(-max)) {
    const kinds = Object.entries(e.kinds)
      .filter(([, n]) => n)
      .map(([k, n]) => `${k}×${n}`)
      .join(' ');
    say(
      `  ${T(e.t)} ${e.stop ? 'STOP ' : ''}${kinds} for ${f2(e.duration)} s at ${e.pos.map(f1).join(', ')} · ${kmh(e.speedBefore)} → ${kmh(e.speedAfter)} · throttle ${f1(e.throttle)} · probes ${e.probes}`,
    );
    if (e.wall) {
      const w = e.wall;
      say(
        `      wall ray ${w.ray} hit ${w.point.map(f1).join(', ')} (${f2(w.heightAboveGround)} m above ground) normal ${w.normal.map(f2).join(', ')} incidence ${Math.round(w.incidence)}° tile error ${f2(w.tileError)} m pen ${f2(e.maxPen)}`,
      );
      if (e.overpass) {
        const o = e.overpass;
        say(`      classifier: ${o.result} (${o.reason}${o.deck ? `, deck ${o.deck}` : ''}) ${o.samples}`);
      }
    }
    if (e.repro) say(`      repro (2 s before): ${e.repro}`);
  }

  if (a.drifts.length) {
    say();
    say(`drifts: ${a.drifts.length}${a.drifts.length > max ? `, showing the last ${max}` : ''}  (slip negative = rear out to the right; turn = how far the path bent)`);
    for (const e of a.drifts.slice(-max)) {
      const gears = e.gears.length ? ` · gear ${e.gears.map((g) => (g < 0 ? 'R' : g)).join('/')}` : '';
      say(
        `  ${T(e.t)} ${f1(e.duration)} s · max slip ${Math.round(e.maxSlip)}° · turn ${Math.round(e.turn)}° · ${kmh(e.speed)} avg · throttle ${f1(e.throttle)} · handbrake ${Math.round(e.handbrake * 100)}%${gears}`,
      );
    }
  }

  if (a.decels.length) {
    say();
    say('hard decelerations without contact or brake:');
    for (const d of a.decels) say(`  ${T(d.t)} ${kmh(d.from)} → ${kmh(d.to)} at ${d.pos.map(f1).join(', ')}`);
  }

  if (a.other.length) {
    say();
    say('events:');
    for (const e of a.other) {
      const { t: _t, step, kind, ...rest } = e;
      if (kind === 'impact' || kind === 'land') continue;
      say(`  ${T(a.rel(step))}  ${kind} ${compact(rest)}`);
    }
    const impacts = a.other.filter((e) => e.kind === 'impact');
    if (impacts.length) say(`  (${impacts.length} impacts, hardest ${f1(Math.max(...impacts.map((e) => e.v)))} m/s)`);
  }

  if (a.logs.length) {
    say();
    say('console:');
    for (const l of a.logs.slice(-30)) say(`  ${T(a.rel(l.step))}  [${l.level}]${l.repeat ? ` ×${l.repeat}` : ''} ${String(l.message).split('\n')[0].slice(0, 200)}`);
  }

  if (opts.window) say('\n' + windowDump(a, opts.window));
  return out.join('\n');
}

function compact(o) {
  const s = JSON.stringify(o, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));
  return s.length > 220 ? `${s.slice(0, 217)}…` : s;
}

function windowDump(a, spec) {
  const [from, to] = spec.split(':').map(Number);
  const { rows, cols, rel } = a;
  const g = (r, c) => r[cols[c]];
  const lines = ['      t       x       y       z  km/h  slip    gap   thr   str  flags probes edge   pen  ray  wall-h  normal'];
  for (let i = 0; i < rows.length; i += 3) {
    const r = rows[i];
    const t = rel(g(r, 'step'));
    if (t < from || t > to) continue;
    const pen = g(r, 'wallPen');
    lines.push(
      [
        t.toFixed(2).padStart(7),
        f1(g(r, 'x')).padStart(7),
        f2(g(r, 'y')).padStart(7),
        f1(g(r, 'z')).padStart(7),
        String(Math.round(g(r, 'speed') * 3.6)).padStart(5),
        `${Math.round(slipOf(r, cols))}°`.padStart(5),
        f2(g(r, 'y') - g(r, 'groundY')).padStart(6),
        f1(g(r, 'throttle')).padStart(5),
        f1(g(r, 'steer')).padStart(5),
        decodeFlags(g(r, 'flags')).padStart(6),
        decodeProbes(g(r, 'probes')).padStart(6),
        String(g(r, 'edge')).padStart(4),
        (pen ? f2(pen) : '').padStart(5),
        (pen ? String(g(r, 'wallRay')) : '').padStart(4),
        (pen ? f2(g(r, 'wallY') - g(r, 'groundY')) : '').padStart(7),
        pen ? `${f2(g(r, 'wallNx'))},${f2(g(r, 'wallNz'))}` : '',
      ].join(' '),
    );
  }
  lines.push('gap: body above ground · flags: A airborne · W waiting for tiles · D drifting · C contact · L long probe · T tunnel; probes FL FR RL RR: g ground, b blocked, m miss, d drop');
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window') opts.window = argv[++i];
    else if (a === '--episodes') opts.episodes = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
    else opts.files.push(a);
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.files.length) {
    console.error('usage: node tools/trace-report.mjs <trace.json> [--window -8:-5] [--episodes N] [--json]');
    process.exit(1);
  }
  for (const file of opts.files) {
    const trace = JSON.parse(readFileSync(file, 'utf8'));
    if (opts.json) {
      const { episodes, decels } = analyse(trace);
      console.log(JSON.stringify({ file, episodes, decels }, null, 1));
    } else {
      console.log(report(trace, opts));
    }
  }
}
