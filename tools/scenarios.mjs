#!/usr/bin/env node
// Pass/fail checks of the real game in headless Chrome: each scenario sets the
// car up through window.__drift, drives it with key presses, waits on game or
// physics time and asserts on the car's state and the trace events. Starts
// its own dev server; the practice set takes well under a minute and needs no
// key or network.
//
//   node tools/scenarios.mjs [filter…] [options]
//
//   filter         only scenarios whose name contains one of these
//   --list         list the scenarios and what each asserts
//   --keep-going   run the rest after a failure (default: stop at the first)
//   --real         also the real-tile scenarios: one page load, one billable
//                  Map Tiles root request (needs MAPS_API_KEY in .env)
//   --json         results as JSON on stdout (progress goes to stderr)
//   --headed       show the browser
//   --chrome PATH  Chrome to run (or CHROME_PATH; default: the installed one)
//   --gl BACKEND   ANGLE backend: d3d11, metal, vulkan, gl or swiftshader
//                  (or DRIFT_GL; default: the GPU on Windows and macOS,
//                  SwiftShader on Linux)
//   --cpu N        run the page's CPU N× slower (Chrome's throttling), to see
//                  the timing margins hold on a slow CI runner
//
// Exits 1 if any scenario failed. A failure saves a screenshot, the page's
// console (with the WebGL renderer) and, if the game is up, its trace to
// traces/scenarios/<name>.{png,console.log,json} (load.* for a page that never
// started; its scenarios are then skipped, not retried). Console errors and
// page errors fail the scenario they happened in (or "load", for the page load).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchChrome, makeRedact, ROOT, startServer, waitForDriving } from './browser.mjs';

const opts = { filters: [], keepGoing: false, real: false, json: false, headed: false, list: false, chrome: process.env.CHROME_PATH, gl: undefined, cpu: 1 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--list') opts.list = true;
  else if (a === '--keep-going') opts.keepGoing = true;
  else if (a === '--real') opts.real = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--headed') opts.headed = true;
  else if (a === '--chrome') opts.chrome = argv[++i];
  else if (a === '--gl') opts.gl = argv[++i];
  else if (a === '--cpu') opts.cpu = Number(argv[++i]);
  else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
  else opts.filters.push(a);
}
// With --json, stdout carries only the JSON.
const log = opts.json ? (...a) => console.error(...a) : (...a) => console.log(...a);

// --- Practice track geometry (src/world/practiceWorld.ts) ---------------------

/** Street centrelines: x = c (north–south) and z = c (east–west), for every c. */
const STREETS = Array.from({ length: 12 }, (_, k) => -461 + 82 * k);
const STREET_END = 461;
/** The block at (154, −10): x 124…184, z −40…20, on the z = 31 street's north side. */
const BLOCK = { x: 154, z: -10, half: 30 };
const DEG = 180 / Math.PI;
const EAST = -Math.PI / 2;
/** Spawn spots on clear asphalt east of the city, away from every patch. */
const OPEN = { x: 600, z: -150 };

/** Degrees from `heading` to the nearest multiple of `step`. */
const offAxis = (heading, step = Math.PI / 2) => Math.abs(heading - Math.round(heading / step) * step) * DEG;

/**
 * The street centreline under (x, z) within `tol` m whose direction `heading`
 * runs along (within `deg`°), or null: "x=31" or "z=-133".
 */
function streetUnder(x, z, heading, tol = 1.5, deg = 3) {
  for (const c of STREETS) {
    // Along x = c the car faces north or south (heading 0 or π).
    if (Math.abs(x - c) < tol && Math.abs(z) <= STREET_END + tol && offAxis(heading, Math.PI) < deg) return `x=${c}`;
    if (Math.abs(z - c) < tol && Math.abs(x) <= STREET_END + tol && offAxis(heading + Math.PI / 2, Math.PI) < deg) return `z=${c}`;
  }
  return null;
}

// --- Assertions ----------------------------------------------------------------

class Fail extends Error {}

const fmt = (v) =>
  typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 0.1 ? 4 : 2)) : Array.isArray(v) ? `[${v.map(fmt).join(', ')}]` : JSON.stringify(v);

/** Fails the scenario unless `ok`: "<what>: got <actual>, expected <expected>". */
function check(what, actual, ok, expected) {
  if (!ok) throw new Fail(`${what}: got ${fmt(actual)}, expected ${expected}`);
}
const near = (what, actual, want, tol, unit = '') => check(what, actual, Math.abs(actual - want) <= tol, `${fmt(want)}${unit} ± ${tol}${unit}`);
const between = (what, actual, lo, hi, unit = '') => check(what, actual, actual >= lo && actual <= hi, `${lo}–${hi}${unit}`);

/**
 * The reset-related events in order, for a count that came out wrong: a hold
 * read as a tap and a road search that found nothing (road-teleport to=null,
 * then a breadcrumb reset) look alike as bare counts.
 */
const seenText = (events) =>
  events
    .map((e) =>
      e.kind === 'reset'
        ? `reset@${e.gt.toFixed(2)} crumb=${e.crumb}`
        : `road-teleport@${e.gt.toFixed(2)} ${e.to ? `to=${fmt(e.to)}` : `to=null tried=${e.tried?.length ?? 0}${e.reason ? ` (${e.reason})` : ''}`}`,
    )
    .join(', ') || 'none';

/** Fails unless exactly `want` `kind` events fired since the last clear, listing what did; → those events. */
async function expectEvents(t, kind, want, what = `'${kind}' events`) {
  const seen = await t.events('reset', 'road-teleport');
  const got = seen.filter((e) => e.kind === kind);
  check(what, got.length, got.length === want, `${want} (seen: ${seenText(seen)})`);
  return got;
}

// --- In-page harness --------------------------------------------------------------

/**
 * Installed once per page load. Taps the trace recorder for events (stamped
 * with the game clock when they fire) and the physics step for per-step rows,
 * and adds waits on game time (`g.time`: frames, as the input's hold timer
 * counts) and physics time (steps × dt, which runs faster under setTimeScale).
 */
function install() {
  const g = window.__drift;
  const rec = g.debug.recorder;
  const DT = g.debug.meta().physics.dt;
  const S = (window.__scn = { events: [], rows: null, layers: { ...g.debug.layers }, open: g.debug.open, dt: DT });
  const event = rec.event.bind(rec);
  rec.event = (kind, data) => {
    const e = event(kind, data);
    if (kind !== 'sample') S.events.push({ ...e, gt: g.time });
    return e;
  };
  const onStep = g.debug.onStep.bind(g.debug);
  g.debug.onStep = (p, inp, colliders) => {
    onStep(p, inp, colliders);
    if (!S.rows) return;
    S.rows.push({
      s: rec.stepIndex,
      t: rec.stepIndex * DT,
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      speed: p.speed,
      vF: p.vForward,
      air: p.airborne,
      surf: [...p.surface],
      gF: p.axleSurface[0].grip,
      gR: p.axleSurface[1].grip,
      rp: p.ridePitch,
      rr: p.rideRoll,
      throttle: inp.throttle,
    });
  };
  const frames = (done, wallLimit) =>
    new Promise((res) => {
      const t0 = performance.now();
      const tick = () => {
        const r = done();
        if (r !== undefined && r !== false) res(r);
        else if (performance.now() - t0 > wallLimit) res(false);
        else requestAnimationFrame(tick);
      };
      tick();
    });
  /** Waits `s` seconds of game clock. */
  S.wait = (s) => {
    const end = g.time + s;
    return frames(() => g.time >= end && g.time, s * 1000 * 5 + 5000);
  };
  /** Waits until `pred(g, P)` holds (→ physics seconds waited) or `max` physics seconds pass (→ false). */
  S.until = (src, max) => {
    const pred = new Function('g', 'P', `return (${src});`);
    const s0 = rec.stepIndex;
    return frames(() => {
      const t = (rec.stepIndex - s0) * DT;
      if (pred(g, g.physics)) return t;
      return t > max ? -1 : false;
    }, max * 1000 * 5 + 10000).then((t) => (t === -1 ? false : t));
  };
  /** Waits `s` seconds of physics time. */
  S.steps = (s) => {
    const end = rec.stepIndex + Math.round(s / DT);
    return frames(() => rec.stepIndex >= end, s * 1000 * 5 + 10000);
  };
  S.car = () => {
    const P = g.physics;
    return {
      x: P.pos.x,
      y: P.pos.y,
      z: P.pos.z,
      speed: P.speed,
      heading: P.heading,
      airborne: P.airborne,
      contact: P.contact,
      groundY: P.groundY,
      surface: [...P.surface],
      phase: g.phase,
      time: g.time,
      step: rec.stepIndex,
    };
  };
  S.spawn = (x, y, z, heading, kmh) => {
    g.spawn(g.physics.pos.clone().set(x, y, z), heading, kmh);
    S.events = [];
    S.rows = null;
  };
  /** Back to a known state between scenarios: driving, real time, the page's own debug layers. */
  S.reset = () => {
    g.debug.setTimeScale(1);
    g.debug.set({ ...S.layers, open: S.open });
    S.events = [];
    S.rows = null;
  };
}

/** The handle a scenario drives the game through. */
function harness(page) {
  const held = new Set();
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const h = {
    page,
    /** Puts the car at rest (or rolling at `kmh`) at (x, y, z) facing `heading`; clears events. */
    spawn: (x, z, heading = 0, kmh = 0, y = 0) => ev(([x, y, z, heading, kmh]) => window.__scn.spawn(x, y, z, heading, kmh), [x, y, z, heading, kmh]),
    /** Game seconds (frames, as the input sees them). */
    wait: (s) => ev((s) => window.__scn.wait(s), s),
    /** Waits for an in-page expression of `g` (window.__drift) and `P` (its physics); fails after `max` physics seconds. */
    async until(src, max, what) {
      const t = await ev(([src, max]) => window.__scn.until(src, max), [src, max]);
      if (t === false) throw new Fail(`${what}: not within ${max} s`);
      return t;
    },
    /** Physics seconds (steps × dt). */
    phys: (s) => ev((s) => window.__scn.steps(s), s),
    car: () => ev(() => window.__scn.car()),
    time: () => ev(() => window.__drift.time),
    events: (...kinds) => ev((kinds) => window.__scn.events.filter((e) => kinds.includes(e.kind)), kinds),
    clearEvents: () => ev(() => (window.__scn.events = [])),
    record: () => ev(() => (window.__scn.rows = [])),
    /** The rows recorded since record(), and stops recording. */
    rows: () =>
      ev(() => {
        const r = window.__scn.rows;
        window.__scn.rows = null;
        return r;
      }),
    timeScale: (s) => ev((s) => window.__drift.debug.setTimeScale(s), s),
    async down(key) {
      held.add(key);
      await page.keyboard.down(key);
    },
    async up(key) {
      held.delete(key);
      await page.keyboard.up(key);
    },
    async releaseAll() {
      for (const k of [...held]) await h.up(k);
    },
    /** Presses `key` for `s` game seconds; → the game clock just before the press and just before the release. */
    async press(key, s) {
      const down = await h.time();
      await h.down(key);
      await h.wait(s);
      const up = await h.time();
      await h.up(key);
      return { down, up };
    },
  };
  return h;
}

// --- Scenarios ----------------------------------------------------------------------

/** Pinned against the block's south face: spawned on the z = 31 street (or at `z`, nearer the wall), nose north into it. */
async function pinAgainstBlock(t, z = 31) {
  await t.spawn(BLOCK.x, z, 0);
  await t.down('KeyW');
  await t.wait(2);
  const c = await t.car();
  check('pinned against the wall: z', c.z, c.z < BLOCK.z + BLOCK.half + 4, `< ${BLOCK.z + BLOCK.half + 4} (the wall is at z = ${BLOCK.z + BLOCK.half})`);
  check('pinned against the wall: speed (m/s)', c.speed, c.speed < 1, '< 1 with the throttle down');
  return c;
}

/** Degrees between two headings, the short way round. */
const turn = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * DEG;

/**
 * The car after road teleport `e` (onStreet's): at rest on the ground at
 * street level, on the spot, and itself on the centreline facing along it. The
 * event only says what the search chose; this checks the car was put there
 * that way (a placeCar that drops or turns the heading passes onStreet).
 */
async function landed(t, e) {
  const c = await t.car();
  const to = e.to;
  check('airborne after landing', c.airborne, !c.airborne, 'false');
  near('height above the street (m)', c.y, 0, 0.5);
  near('ground under the car (m)', c.groundY, 0, 0.3);
  check('distance from the teleport spot (m)', Math.hypot(c.x - to[0], c.z - to[2]), Math.hypot(c.x - to[0], c.z - to[2]) < 1, '< 1');
  check('speed after landing (m/s)', c.speed, c.speed < 0.5, '< 0.5');
  const off = turn(c.heading, e.heading);
  check(`car heading off the road-teleport's ${fmt(e.heading * DEG)}° (°)`, off, off < 3, '< 3');
  const street = streetUnder(c.x, c.z, c.heading);
  check(`car on a street centreline facing along it (heading ${fmt(c.heading * DEG)}°)`, [c.x, c.z], street !== null, 'within 1.5 m of a centreline, heading within 3° of it');
}

/** One road-teleport event onto a street centreline at ground level, facing along the street. */
function onStreet(e) {
  check('road-teleport destination', e.to, Array.isArray(e.to), 'a spot (the search found none)');
  const [x, y, z] = e.to;
  const street = streetUnder(x, z, e.heading);
  check(`road-teleport onto a street centreline facing along it (heading ${fmt(e.heading * DEG)}°)`, [x, z], street !== null, 'within 1.5 m of a centreline, heading within 3° of it');
  near('road-teleport height (m)', y, 0, 0.5);
  return street;
}

/** Mean deceleration over the second of physics time from row `i` (m/s²), and the speed there. */
function decelFrom(rows, i) {
  let j = i;
  while (j + 1 < rows.length && rows[j + 1].t - rows[i].t <= 1 + 1e-9) j++;
  return { v0: rows[i].speed, decel: (rows[i].speed - rows[j].speed) / (rows[j].t - rows[i].t || 1) };
}

/** Rows have no NaN or infinity and never leave the ground. */
function sane(rows, what) {
  const bad = rows.find((r) => ![r.x, r.y, r.z, r.speed].every(Number.isFinite));
  check(`${what}: finite position and speed`, bad ?? null, !bad, 'all finite');
  const air = rows.filter((r) => r.air).length;
  check(`${what}: airborne steps`, air, air === 0, '0');
}

const all = (surf, id) => surf.every((s) => s === id);

const SCENARIOS = [
  {
    name: 'reset-tap',
    about: "pinned against a block, a 0.1 s tap of R fires exactly one 'reset' when released (back to the spawn), and no 'road-teleport'",
    async run(t) {
      await pinAgainstBlock(t);
      await t.clearEvents();
      const { up } = await t.press('KeyR', 0.1);
      await t.wait(0.4);
      await t.up('KeyW');
      const resets = await expectEvents(t, 'reset', 1);
      await expectEvents(t, 'road-teleport', 0);
      check("'reset' fired on release: game time after the key went up", resets[0].gt - up, resets[0].gt > up, '> 0');
      near("'reset' destination x (the spawn)", resets[0].to[0], BLOCK.x, 0.5);
      near("'reset' destination z (the spawn)", resets[0].to[2], 31, 0.5);
    },
  },
  {
    name: 'reset-hold',
    about:
      "holding R 0.8 s fires one 'road-teleport' ~0.5 s into the hold (not on release) onto a street centreline facing along it; landed and grounded 1 s later; the release adds nothing; a later tap comes back to that spot (the teleport's breadcrumb, not the spawn 7 m away)",
    async run(t) {
      // Spawned off the centreline, so the spawn (where a reset without the
      // teleport's breadcrumb would go) isn't the road spot.
      const SPAWN_Z = 24;
      await pinAgainstBlock(t, SPAWN_Z);
      await t.up('KeyW');
      await t.wait(0.2);
      await t.clearEvents();
      const { down, up } = await t.press('KeyR', 0.8);
      await t.wait(0.3);
      const [e] = await expectEvents(t, 'road-teleport', 1);
      await expectEvents(t, 'reset', 0, "'reset' events (the release must not also reset)");
      between("'road-teleport' delay after the key went down (s)", e.gt - down, 0.4, 0.7, ' s');
      check("'road-teleport' fired while held: before the release by (s)", up - e.gt, e.gt < up, '> 0');
      const street = onStreet(e);
      const fromSpawn = Math.hypot(e.to[0] - BLOCK.x, e.to[2] - SPAWN_Z);
      check('road spot away from the spawn (m)', fromSpawn, fromSpawn > 5, '> 5 (else the tap below proves nothing)');
      await t.wait(0.7);
      await landed(t, e);
      // A tap now comes back here: the teleport left a breadcrumb old enough for R.
      await t.clearEvents();
      await t.press('KeyR', 0.1);
      await t.wait(0.3);
      const [back] = await expectEvents(t, 'reset', 1, "'reset' events from the later tap");
      check("the later tap's 'reset' went to a breadcrumb", back.crumb, back.crumb === true, 'true (false: back to the spawn)');
      const off = Math.hypot(back.to[0] - e.to[0], back.to[2] - e.to[2]);
      check('the later tap goes to the road spot (m)', off, off < 0.5, `< 0.5 (spot ${fmt(e.to)} on ${street})`);
      t.note = `teleport ${(e.gt - down).toFixed(2)} s into the hold, onto ${street}`;
    },
  },
  {
    name: 'back-to-road',
    about: "Esc pauses; the menu's Back to road button resumes and fires one 'road-teleport' onto a street centreline",
    async run(t) {
      await t.spawn(0, -10, 0.3);
      await t.wait(0.3);
      await t.clearEvents();
      await t.press('Escape', 0.05);
      await t.page.waitForFunction(() => window.__drift.phase === 'paused' && !document.getElementById('menu').hidden, null, { timeout: 5000 });
      const button = t.page.locator('#back-to-road');
      check('Back to road button enabled', await button.isEnabled(), await button.isEnabled(), 'true');
      await button.click();
      await t.wait(0.2);
      const c = await t.car();
      check('phase after Back to road', c.phase, c.phase === 'driving', "'driving'");
      const hidden = await t.page.evaluate(() => document.getElementById('menu').hidden);
      check('menu hidden after Back to road', hidden, hidden, 'true');
      const roads = await expectEvents(t, 'road-teleport', 1);
      onStreet(roads[0]);
      await t.wait(0.8);
      await landed(t, roads[0]);
    },
  },
  {
    name: 'teleport-from-roof',
    about: 'on the roof of a block, the road teleport lands at street level on a centreline, grounded 1 s later',
    async run(t) {
      const roof = await t.page.evaluate(({ x, z }) => {
        const g = window.__drift;
        const o = g.physics.pos.clone().set(x, 300, z);
        g.collider.prepare(x, z, 5);
        return g.collider.castAll(o, o.clone().set(0, -1, 0), 400)[0]?.point.y ?? null;
      }, BLOCK);
      check('roof height (m)', roof, roof > 5, '> 5');
      await t.spawn(BLOCK.x, BLOCK.z, 0, 0, roof + 0.05);
      await t.wait(0.5);
      const c = await t.car();
      near('on the roof: height (m)', c.y, roof, 0.5);
      check('on the roof: airborne', c.airborne, !c.airborne, 'false');
      await t.page.evaluate(() => window.__drift.teleportToRoad());
      const roads = await expectEvents(t, 'road-teleport', 1);
      onStreet(roads[0]);
      await t.wait(1);
      await landed(t, roads[0]);
    },
  },
  {
    name: 'teleport-from-inside',
    about: 'from inside a block, the road teleport lands at street level on a centreline outside it, grounded 1 s later',
    async run(t) {
      await t.spawn(BLOCK.x, BLOCK.z, 0, 0, 0.05);
      await t.wait(0.3);
      await t.page.evaluate(() => window.__drift.teleportToRoad());
      const roads = await expectEvents(t, 'road-teleport', 1);
      onStreet(roads[0]);
      const [x, , z] = roads[0].to;
      const inside = Math.abs(x - BLOCK.x) < BLOCK.half && Math.abs(z - BLOCK.z) < BLOCK.half;
      check('road-teleport spot outside the block', [x, z], !inside, `outside x ${BLOCK.x - BLOCK.half}…${BLOCK.x + BLOCK.half}, z ${BLOCK.z - BLOCK.half}…${BLOCK.z + BLOCK.half}`);
      await t.wait(1);
      await landed(t, roads[0]);
    },
  },
  {
    name: 'tab-map',
    about: "holding Tab opens the big map and letting go closes it, firing no resets; R tapped and held fire one 'reset' / one 'road-teleport' with the map open as with it closed",
    async run(t) {
      const expanded = () => t.page.evaluate(() => window.__drift.minimap.expanded && document.getElementById('minimap').classList.contains('expanded'));
      await t.spawn(31, 200, 0);
      await t.wait(0.2);
      await t.clearEvents();
      await t.down('Tab');
      await t.wait(0.2);
      check('big map open while Tab is held', await expanded(), await expanded(), 'true');
      // Longer than a reset hold: Tab alone must do nothing else.
      await t.wait(0.6);
      await t.up('Tab');
      await t.wait(0.2);
      check('big map closed after Tab is let go', await expanded(), !(await expanded()), 'false');
      const quiet = await t.events('reset', 'road-teleport');
      check("'reset'/'road-teleport' events from Tab alone", quiet.length, quiet.length === 0, `0 (seen: ${seenText(quiet)})`);
      /** → [resets, road teleports] since the last clear, and what they were. */
      const count = async () => {
        const seen = await t.events('reset', 'road-teleport');
        return { n: ['reset', 'road-teleport'].map((k) => seen.filter((e) => e.kind === k).length), seen: seenText(seen) };
      };
      const counts = {};
      for (const open of [true, false]) {
        if (open) await t.down('Tab');
        await t.wait(0.1);
        await t.clearEvents();
        await t.press('KeyR', 0.1);
        await t.wait(0.3);
        const tap = await count();
        await t.clearEvents();
        await t.press('KeyR', 0.8);
        await t.wait(0.3);
        const hold = await count();
        if (open) check('big map still open after the R presses', await expanded(), await expanded(), 'true');
        if (open) await t.up('Tab');
        counts[open ? 'open' : 'closed'] = { tap, hold };
      }
      for (const k of ['open', 'closed']) {
        const { tap, hold } = counts[k];
        check(`map ${k}: R tap → [reset, road-teleport] events`, tap.n, tap.n[0] === 1 && tap.n[1] === 0, `[1, 0] (seen: ${tap.seen})`);
        check(`map ${k}: R hold → [reset, road-teleport] events`, hold.n, hold.n[0] === 0 && hold.n[1] === 1, `[0, 1] (seen: ${hold.seen})`);
      }
    },
  },
  {
    name: 'gravel-entry',
    about: 'from (425, 31) heading east under full throttle onto the gravel road: the front wheels read gravel before the rear, and each axle grip eases down to 0.63 over several steps (no step change)',
    async run(t) {
      await t.spawn(425, 31, EAST);
      await t.record();
      await t.down('KeyW');
      await t.until('P.pos.x > 470', 8, 'reaching x = 470 on the gravel road');
      await t.up('KeyW');
      const rows = await t.rows();
      sane(rows, 'gravel entry');
      check('start on asphalt (wheels)', rows[0].surf, all(rows[0].surf, 'asphalt'), 'all asphalt');
      const front = rows.findIndex((r) => r.surf[0] === 'gravel' && r.surf[1] === 'gravel');
      const rear = rows.findIndex((r) => r.surf[2] === 'gravel' && r.surf[3] === 'gravel');
      check('front wheels reach gravel (step)', front, front >= 0, 'some step');
      check('rear wheels reach gravel (step)', rear, rear >= 0, 'some step');
      check('front wheels on gravel before the rear: steps between', rear - front, rear > front, '> 0');
      const gripDrop = (k) => rows.findIndex((r) => r[k] < 0.999);
      check('front axle grip falls before the rear: steps between', gripDrop('gR') - gripDrop('gF'), gripDrop('gF') < gripDrop('gR'), '> 0');
      const notes = [];
      for (const [k, axle] of [['gF', 'front'], ['gR', 'rear']]) {
        const blend = rows.filter((r) => r[k] < 0.98 && r[k] > 0.65).length;
        let jump = 0;
        for (let i = 1; i < rows.length; i++) jump = Math.max(jump, Math.abs(rows[i][k] - rows[i - 1][k]));
        check(`${axle} axle grip steps between asphalt and gravel`, blend, blend >= 5, '≥ 5 (an eased blend)');
        check(`${axle} axle grip largest change in one step`, jump, jump < 0.06, '< 0.06');
        near(`${axle} axle grip on gravel`, rows[rows.length - 1][k], 0.63, 0.015);
        notes.push(`${axle} ${blend} steps, ≤ ${jump.toFixed(3)}/step`);
      }
      t.note = `rear on gravel ${rear - front} steps after the front; grip blend ${notes.join(', ')}`;
    },
  },
  {
    name: 'soft-ground-coasts',
    about:
      'rolling at 75 km/h off the throttle onto grass and sand: the first second on each slows the car more than asphalt by a margin (sand by far); it comes to a clean stop (grass under the brake) with finite numbers and no airborne step. (The pond sinks the car: pond-sink.)',
    async run(t) {
      // Physics time runs 3× (more steps a frame); the waits count steps.
      await t.timeScale(3);
      // Approach from 25 m out on asphalt, so every run enters at about the same speed.
      const runs = [
        { id: 'asphalt', x: OPEN.x, z: OPEN.z, margin: null },
        { id: 'grass', x: 780, z: 30, margin: 0.5, brake: true },
        { id: 'sand', x: 630, z: 130, margin: 4 },
      ];
      const result = {};
      for (const run of runs) {
        await t.spawn(run.x, run.z, EAST, 75);
        await t.record();
        // The asphalt reference is measured from where the others reach their surface.
        if (run.id === 'asphalt') await t.phys(2.4);
        else {
          await t.until(`P.surface.every((s) => s === '${run.id}')`, 3, `all four wheels on ${run.id}`);
          await t.phys(1.1);
          if (run.brake) {
            await t.down('KeyS');
            await t.until('P.speed < 0.3', 8, `${run.id}: stopping under the brake`);
            await t.up('KeyS');
          } else {
            await t.until('P.speed < 0.3', 8, `${run.id}: coasting to a stop`);
          }
          // Stopped means stopped: no creep or jitter with hands off.
          await t.phys(1);
        }
        const rows = await t.rows();
        sane(rows, run.id);
        const i = run.id === 'asphalt' ? rows.findIndex((r) => r.t - rows[0].t >= 1.25) : rows.findIndex((r) => all(r.surf, run.id));
        result[run.id] = decelFrom(rows, i);
        between(`${run.id}: entry speed (km/h)`, result[run.id].v0 * 3.6, 60, 80, ' km/h');
        if (run.id === 'asphalt') continue;
        const extra = result[run.id].decel - result.asphalt.decel;
        check(`${run.id}: deceleration over asphalt's in the first second (m/s²; asphalt ${fmt(result.asphalt.decel)})`, extra, extra >= run.margin, `≥ ${run.margin}`);
        const tail = rows.filter((r) => r.t >= rows[rows.length - 1].t - 0.8);
        const creep = Math.hypot(tail[tail.length - 1].x - tail[0].x, tail[tail.length - 1].z - tail[0].z);
        check(`${run.id}: movement while stopped (m)`, creep, creep < 0.05, '< 0.05');
        check(`${run.id}: still on ${run.id} when stopped`, rows[rows.length - 1].surf, rows[rows.length - 1].surf.some((s) => s === run.id), `a wheel on ${run.id}`);
      }
      t.note = Object.entries(result)
        .map(([id, r]) => `${id} ${r.decel.toFixed(1)}`)
        .join(', ') + ' m/s²';
    },
  },
  {
    name: 'ride',
    about: 'on the cobbles at 30 km/h the body shakes (ridePitch and rideRoll vary); on asphalt both stay exactly 0',
    async run(t) {
      await t.spawn(480, -39, EAST, 30);
      await t.until("P.surface.every((s) => s === 'cobbles')", 1, 'all four wheels on the cobbles');
      await t.record();
      await t.phys(1.5);
      const cob = await t.rows();
      check('wheels on the cobbles throughout', cob.filter((r) => !all(r.surf, 'cobbles')).length, cob.every((r) => all(r.surf, 'cobbles')), '0 steps off them');
      const spread = (k, rows) => Math.max(...rows.map((r) => r[k])) - Math.min(...rows.map((r) => r[k]));
      check('cobbles: ridePitch spread (rad)', spread('rp', cob), spread('rp', cob) > 0.002, '> 0.002');
      check('cobbles: rideRoll spread (rad)', spread('rr', cob), spread('rr', cob) > 0.002, '> 0.002');
      await t.spawn(OPEN.x, OPEN.z, EAST, 30);
      await t.record();
      await t.phys(1);
      const flat = await t.rows();
      const moved = flat.filter((r) => r.rp !== 0 || r.rr !== 0);
      check('asphalt: steps with ridePitch or rideRoll ≠ 0', moved.length, moved.length === 0, '0');
      t.note = `cobbles spread pitch ${spread('rp', cob).toFixed(4)} roll ${spread('rr', cob).toFixed(4)} rad`;
    },
  },
  {
    name: 'pond-sink',
    about:
      "driving into the pond at 40 km/h with the throttle held: a 'sink' event once three wheels are in, a splash of spray, the controls let go (no throttle reaches the physics) and the car drawn going under; then 'sunk' and a road teleport out of the water, landing grounded and dry, with the HUD saying so",
    async run(t) {
      await t.spawn(820, 150, EAST, 40);
      await t.down('KeyW');
      await t.until("P.surface.filter((s) => s === 'water').length >= 3", 4, 'three wheels in the pond');
      const sink = await t.until('g.sink !== null', 1, 'the car starting to sink (g.sink)');
      check('sinking began after three wheels were in (s)', sink, sink >= 0.2 && sink <= 0.4, '0.2–0.4 (SINK_AFTER 0.25)');
      await t.record();
      const sinks = await t.events('sink');
      check("'sink' events", sinks.length, sinks.length === 1, '1');
      const spray = await t.page.evaluate(() => window.__drift.effects.counts().spray);
      check('spray puffs right after going in', spray, spray >= 30, '≥ 30 (the splash)');
      await t.wait(1.5);
      const under = await t.page.evaluate(() => ({ drawn: window.__drift.car.root.position.y, y: window.__drift.physics.pos.y }));
      check('car drawn below its physics height after 1.5 s (m)', under.y - under.drawn, under.y - under.drawn > 0.5, '> 0.5 (going under)');
      const rows = await t.rows();
      const pushed = rows.filter((r) => r.throttle > 0).length;
      check('steps with throttle reaching the physics while sinking', pushed, rows.length > 0 && pushed === 0, '0 (W held, the controls let go)');
      await t.until('g.sink === null', 2.5, 'being fished out (sinking over)');
      await t.up('KeyW');
      const sunk = await t.events('sunk', 'road-teleport');
      check("'sunk' then 'road-teleport' events", sunk.map((e) => e.kind), sunk.length === 2 && sunk[0].kind === 'sunk' && sunk[1].kind === 'road-teleport' && sunk[1].to, "['sunk', 'road-teleport' with a spot]");
      await t.wait(1);
      const c = await t.car();
      check('airborne after landing', c.airborne, !c.airborne, 'false');
      check('wheels out of the water after landing', c.surface, c.surface.every((s) => s !== 'water'), 'none on water');
      near('ground under the car (m)', c.groundY, 0, 0.3);
      const status = await t.page.evaluate(() => document.getElementById('status').textContent);
      check('HUD status', status, /water/i.test(status), "mentions the water ('Fished out of the water')");
      t.note = `sank ${sink.toFixed(2)} s after three wheels went in; out at ${sunk[1].to.map((v) => v.toFixed(0)).join(', ')}`;
    },
  },
  {
    name: 'ford-crossing',
    about: 'across the ford on the gravel road at 30 km/h under part throttle: the wheels read ford, throw spray, never sink, and the car comes out the other side still moving',
    async run(t) {
      await t.spawn(530, 31, EAST, 30);
      await t.record();
      await t.down('KeyW');
      // The rear wheels throw the spray: wait until they're in.
      await t.until("P.surface[2] === 'ford' && P.surface[3] === 'ford'", 4, 'rear wheels reaching the ford');
      await t.wait(0.2);
      const spray = await t.page.evaluate(() => window.__drift.effects.counts().spray);
      await t.until('P.pos.x > 575', 6, 'out the other side of the ford');
      await t.up('KeyW');
      const rows = await t.rows();
      sane(rows, 'ford');
      const ford = rows.filter((r) => r.surf.some((s) => s === 'ford'));
      check('steps with a wheel on the ford', ford.length, ford.length > 5, '> 5');
      check('steps with a wheel in deep water', rows.filter((r) => r.surf.some((s) => s === 'water')).length, rows.every((r) => !r.surf.includes('water')), '0 (the ford covers the road)');
      const sinks = await t.events('sink');
      check("'sink' events", sinks.length, sinks.length === 0, '0');
      check('spray puffs in the ford', spray, spray > 0, '> 0');
      const slowest = Math.min(...ford.map((r) => r.speed * 3.6));
      check('slowest speed in the ford (km/h)', slowest, slowest > 10, '> 10 (it keeps going)');
      t.note = `${ford.length} steps on the ford, slowest ${slowest.toFixed(0)} km/h, ${spray} spray puffs`;
    },
  },
  {
    name: 'surface-label',
    about: "the HUD's surface label names the gravel road once the car is on it (after a short delay, not at the first wheel) and hides again back on asphalt",
    async run(t) {
      const label = () => t.page.evaluate(() => {
        const el = document.getElementById('surface');
        return el.hidden ? '' : el.textContent;
      });
      await t.spawn(OPEN.x, OPEN.z, EAST, 30);
      await t.wait(0.7);
      check('label on asphalt', await label(), (await label()) === '', "'' (hidden)");
      await t.spawn(440, 31, EAST, 40);
      await t.until("P.surface[0] === 'gravel'", 2, 'front wheels reaching the gravel');
      const early = await label();
      check('label as the first wheels reach the gravel', early, early === '', "'' (it waits for the surface to hold)");
      await t.wait(0.6);
      check('label on the gravel road', await label(), (await label()) === 'Gravel', "'Gravel'");
      await t.spawn(OPEN.x, OPEN.z, EAST, 30);
      await t.wait(0.8);
      check('label back on asphalt', await label(), (await label()) === '', "'' (hidden)");
    },
  },
  {
    name: 'surface-puffs',
    about: 'rolling straight at 60 km/h: no puffs on asphalt; dust behind the car on the gravel road without any sliding; turf clods from a handbrake slide on the grass',
    async run(t) {
      const counts = () => t.page.evaluate(() => window.__drift.effects.counts());
      const clear = () => t.page.evaluate(() => window.__drift.effects.clear());
      await t.spawn(OPEN.x, OPEN.z, EAST, 60);
      await clear();
      await t.wait(1);
      const tar = await counts();
      const any = Object.values(tar).reduce((a, b) => a + b, 0);
      check('puffs rolling straight on asphalt', tar, any === 0, 'none');
      await t.spawn(452, 31, EAST, 60);
      await clear();
      await t.wait(1);
      const road = await counts();
      const c = await t.car();
      check('still on the gravel road', c.surface, all(c.surface, 'gravel'), 'all gravel');
      check('dust puffs rolling on gravel', road.dust, road.dust > 10, '> 10');
      check('smoke puffs rolling on gravel', road.smoke, road.smoke === 0, '0 (no rubber smoke off the tarmac)');
      await t.spawn(830, 30, EAST, 50);
      await t.until("P.surface.every((s) => s === 'grass')", 2, 'all four wheels on the grass');
      await clear();
      await t.down('Space');
      await t.down('KeyA');
      await t.wait(0.8);
      const turf = await counts();
      await t.releaseAll();
      check('turf clods from a handbrake slide on grass', turf.turf, turf.turf > 5, '> 5');
      t.note = `gravel dust ${road.dust}, grass clods ${turf.turf}`;
    },
  },
  {
    name: 'debug-layers',
    about: 'toggling the roads, surfaces, tires, trail and gauges layers (one by one, then together, with a road search drawn) while driving raises no console error and the game keeps stepping',
    async run(t) {
      await t.spawn(425, 31, EAST);
      await t.down('KeyW');
      const set = (layers) => t.page.evaluate((l) => window.__drift.debug.set(l), layers);
      await set({ open: true });
      const s0 = (await t.car()).step;
      for (const layer of ['roads', 'surfaces', 'tires', 'trail', 'gauges']) {
        await set({ [layer]: true });
        await t.wait(0.25);
        await set({ [layer]: false });
        await t.wait(0.05);
      }
      await set({ roads: true, surfaces: true, tires: true, trail: true, gauges: true });
      await t.page.evaluate(() => window.__drift.teleportToRoad());
      await t.wait(0.4);
      await t.up('KeyW');
      const steps = (await t.car()).step - s0;
      check('physics steps while toggling', steps, steps > 100, '> 100 (the game kept running)');
    },
  },
];

// Real tiles (--real): one page load at the I-35W bridge (README deep link).
const BRIDGE_GEO = { lat: 44.97889, lon: -93.24472 };
const BRIDGE = `/?lat=${BRIDGE_GEO.lat}&lon=${BRIDGE_GEO.lon}&bearing=14&top=1`;
/**
 * Fixed ground around the bridge: [name, m east, m south of the deep link,
 * surface], each ≥ 15 m inside its patch (read off `node tools/surfaces.mjs
 * I-35W --png DIR`). None is symmetric with another about the spawn, so a
 * surface map mirrored, rotated, axis-swapped or shifted 40 m along the deck
 * gets at least one wrong, though the spawn's own spot still reads right.
 */
const BRIDGE_PROBES = [
  ['deck', 0, 0, 'asphalt'],
  ['river west of the decks', -120, -40, 'water'],
  ['river between the decks', 32, -10, 'water'],
  ['lawn on the south-west bank', -150, 90, 'grass'],
];

/** → [{ name, want, got, at: [x, z] }]: the surface map at each probe, placed through the world's own geo frame. */
const probeBridge = (t) =>
  t.page.evaluate(
    ({ geo, probes }) => {
      const g = window.__drift;
      const R = 6378137;
      const DEG = 180 / Math.PI;
      const height = g.world.geo(g.physics.pos).height;
      return probes.map(([name, x, z, want]) => {
        const p = g.world.fromGeo({ lat: geo.lat - (z / R) * DEG, lon: geo.lon + (x / (R * Math.cos(geo.lat / DEG))) * DEG, height });
        return { name, want, got: g.world.surfaceAt(p.x, p.z), at: [p.x, p.z] };
      });
    },
    { geo: BRIDGE_GEO, probes: BRIDGE_PROBES },
  );

/** Unloaded cells read asphalt: wait for every loaded OSM tile to be rasterised, and the river to show within 150 m. */
const surfaceMapLoaded = (t) =>
  t.until(
    `(() => { const s = g.world.stats(); if (s.roadLoading || !s.roadTiles || s.surfaceTiles < s.roadTiles) return false; for (let dx = -150; dx <= 150; dx += 5) for (let dz = -150; dz <= 150; dz += 5) if (g.world.surfaceAt(P.pos.x + dx, P.pos.z + dz) === 'water') return true; return false; })()`,
    30,
    'the surface map loaded, with the river within 150 m',
  );

const REAL = [
  {
    name: 'real-bridge-deck',
    about:
      'at the I-35W bridge, once the OSM surface map has loaded (water found within 150 m), fixed lat/lon points read deck asphalt, river water on both sides and a bank lawn grass, and all four wheels read asphalt on the deck',
    url: BRIDGE,
    async run(t) {
      await surfaceMapLoaded(t);
      const wrong = (await probeBridge(t)).filter((p) => p.got !== p.want);
      check('fixed lat/lon points reading the wrong surface', wrong.map((p) => `${p.name} ${p.got}`), !wrong.length, `none (${BRIDGE_PROBES.map(([n, , , s]) => `${n} ${s}`).join(', ')})`);
      await t.record();
      await t.phys(1);
      const rows = await t.rows();
      const off = rows.filter((r) => !all(r.surf, 'asphalt'));
      check('steps with a wheel off asphalt on the deck', off.length ? off[0].surf : 0, off.length === 0, '0');
      check('airborne on the deck', rows.filter((r) => r.air).length, rows.every((r) => !r.air), '0 steps');
    },
  },
  {
    name: 'real-lawn',
    about: "dropped onto the south-west bank's lawn (a fixed lat/lon, placed through the world's geo frame), the car lands and all four wheels read grass",
    url: BRIDGE,
    async run(t) {
      await surfaceMapLoaded(t);
      const lawn = (await probeBridge(t)).find((p) => p.want === 'grass');
      check(`the surface map at the ${lawn.name}`, lawn.got, lawn.got === 'grass', "'grass'");
      const y = await t.page.evaluate(() => window.__drift.physics.pos.y);
      const spot = { x: lawn.at[0], z: lawn.at[1], d: Math.hypot(...lawn.at) };
      // Fine tiles only load around the car: put it over the lawn at the
      // deck's height and let it come down onto whatever is there.
      await t.spawn(spot.x, spot.z, 0, 0, y + 1);
      await t.phys(1);
      await t.until('!P.airborne && !P.waiting && P.speed < 0.5', 10, 'landing on the lawn');
      await t.record();
      await t.phys(0.5);
      const rows = await t.rows();
      const last = rows[rows.length - 1];
      check(`wheels on the lawn ${spot.d.toFixed(0)} m away`, last.surf, all(last.surf, 'grass'), 'all grass');
      check('airborne on the lawn', last.air, !last.air, 'false');
      t.note = `lawn ${spot.d.toFixed(0)} m from the spawn`;
    },
  },
];

// --- Runner -----------------------------------------------------------------------------

const pick = (list) => list.filter((s) => !opts.filters.length || opts.filters.some((f) => s.name.includes(f)));
if (opts.list) {
  for (const s of SCENARIOS) console.log(`${s.name.padEnd(22)} ${s.about}`);
  for (const s of REAL) console.log(`${s.name.padEnd(22)} [--real] ${s.about}`);
  process.exit(0);
}
const chosen = [...pick(SCENARIOS), ...(opts.real ? pick(REAL) : [])];
if (!chosen.length) {
  console.error(`no scenario matches ${opts.filters.join(', ')}${opts.real ? '' : ' (real-tile ones need --real)'}`);
  process.exit(2);
}

const redact = makeRedact();
const outDir = resolve(ROOT, 'traces/scenarios');
const started = performance.now();
const server = await startServer();
const browser = await launchChrome({ headed: opts.headed, chromePath: opts.chrome, gl: opts.gl });
const results = [];
let page = null;
let pageUrl = null;
let errors = [];
/** The page's whole console since it loaded (redacted, newest CONSOLE_LINES), saved with any failure. */
let consoleLines = [];
const CONSOLE_LINES = 5000;
const keepLine = (line) => {
  consoleLines.push(line);
  if (consoleLines.length > CONSOLE_LINES) consoleLines.shift();
};

/** A fresh page at `url`, driving, with the harness installed. */
async function load(url) {
  await page?.close();
  errors = [];
  consoleLines = [];
  page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  page.on('console', (m) => {
    keepLine(`[${m.type()}] ${redact(m.text())}`);
    if (m.type() === 'error') errors.push(`console.error: ${redact(m.text())}`);
  });
  page.on('pageerror', (e) => {
    keepLine(`[pageerror] ${redact(e.stack ?? e.message)}`);
    errors.push(`page error: ${redact(e.message)}`);
  });
  page.on('crash', () => {
    keepLine('[crash] page crashed');
    errors.push('page crashed');
  });
  if (opts.cpu > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: opts.cpu });
  if (!/[?&]practice\b/.test(url)) log('note: real-tile load (one billable Map Tiles root request)');
  await page.goto(new URL(url, server.url).href);
  const phase = await waitForDriving(page, url.includes('practice') ? 30 : 90);
  if (phase !== 'driving') {
    const err = await page.evaluate(() => document.getElementById('menu-error')?.textContent ?? '').catch(() => '');
    throw new Fail(`never reached driving (phase ${phase})${err ? `: ${redact(err)}` : ''}`);
  }
  await page.evaluate(install);
  pageUrl = url;
}

/** The renderer WebGL runs on (SwiftShader, or which GPU). */
const gpu = () => page.evaluate(() => `${window.__drift.debug.meta().gpu ?? 'unknown GPU'}, ${Math.round(window.__drift.fps)} fps`).catch(() => '');

/** The same without the game: what a fresh WebGL2 context gets, for a page that never started. */
const bareGpu = () =>
  page
    .evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return 'no WebGL2 context';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    })
    .catch((err) => `unknown (${err.message.split('\n')[0]})`);

const errorText = () => errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more)` : '');

function report(name, ok, ms, message = '', note = '') {
  results.push({ name, ok, seconds: Math.round(ms) / 1000, ...(message && { failure: message }), ...(note && { note }) });
  log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(22)} ${(ms / 1000).toFixed(1).padStart(5)} s${message ? `  ${message}` : ''}${note && ok ? `  (${note})` : ''}`);
}

/** <name>.png, .console.log and (if the game is up) .json in traces/scenarios; each on its own, as the page may be half gone. */
async function saveFailure(name, message) {
  mkdirSync(outDir, { recursive: true });
  const file = (ext) => resolve(outDir, `${name}${ext}`);
  await page?.screenshot({ path: file('.png') }).catch(() => {});
  const head = [`# ${name}: ${message}`, `# url: ${pageUrl ?? '(not loaded)'}`, `# WebGL: ${page ? await bareGpu() : 'no page'}`, `# game: ${page ? (await gpu()) || 'not running' : 'no page'}`];
  writeFileSync(file('.console.log'), [...head, ...consoleLines, ''].join('\n'));
  try {
    const trace = await page.evaluate((label) => window.__drift.debug.exportTrace({ label, seconds: 20 }), name);
    writeFileSync(file('.json'), redact(JSON.stringify(trace)));
  } catch {
    // No game to trace (a failed load); the console and screenshot say why.
  }
}

let failed = false;
let reload = true;
/** Pages that didn't load: their scenarios are skipped, not each retried (up to 30 s apiece) for the same failure. */
const deadUrls = new Set();
let skipped = 0;
try {
  for (const s of chosen) {
    const url = s.url ?? '/?practice';
    if (deadUrls.has(url)) {
      skipped++;
      continue;
    }
    if (reload || url !== pageUrl) {
      const t0 = performance.now();
      const name = s.url ? `load ${s.name}` : 'load';
      try {
        await load(url);
        if (errors.length) throw new Fail(errorText());
        // Reloads after a failure pass quietly.
        if (!s.url && !results.some((r) => r.name === 'load')) report('load', true, performance.now() - t0, '', await gpu());
      } catch (err) {
        const message = err instanceof Fail ? err.message : `error: ${redact(err.message.split('\n')[0])}`;
        await saveFailure(name.replace(' ', '-'), message);
        report(name, false, performance.now() - t0, message);
        failed = true;
        deadUrls.add(url);
        skipped++;
        if (!opts.keepGoing) break;
        continue;
      }
      reload = false;
    }
    const t = harness(page);
    const t0 = performance.now();
    try {
      await page.evaluate(() => window.__scn.reset());
      errors = [];
      keepLine(`--- scenario ${s.name} ---`);
      await s.run(t);
      // A frame for errors from the last thing it did to surface.
      await t.wait(0.05);
      if (errors.length) throw new Fail(errorText());
      await t.releaseAll();
      report(s.name, true, performance.now() - t0, '', t.note);
    } catch (err) {
      const message = err instanceof Fail ? err.message : `error: ${redact(err.message.split('\n')[0])}`;
      await t.releaseAll().catch(() => {});
      await saveFailure(s.name, message);
      report(s.name, false, performance.now() - t0, message);
      failed = true;
      // Whatever it left behind, the next one starts on a fresh page.
      reload = true;
      if (!opts.keepGoing) break;
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const passed = results.filter((r) => r.ok && !r.name.startsWith('load')).length;
const total = (performance.now() - started) / 1000;
if (opts.json) console.log(JSON.stringify({ ok: !failed, seconds: Math.round(total * 10) / 10, skipped, results }, null, 1));
log(
  `\n${passed}/${chosen.length} scenarios passed in ${total.toFixed(1)} s${skipped ? ` (${skipped} not run: their page didn't load)` : ''}${failed ? ` — failure screenshots, consoles and traces in ${outDir.replace(ROOT, '').replace(/^[\\/]/, '')}` : ''}`,
);
process.exit(failed ? 1 : 0);
