#!/usr/bin/env node
// Headless (GPU) run of the game that saves a debug trace, a screenshot, the page
// console and optionally a Chrome performance trace, then prints the report.
//
//   node tools/capture.mjs [path-or-url] [options]
//
//   path-or-url      default "/?practice" (no billable tile loads); "./" is the
//                    default spawn, "?lat=…&lon=…" a deep link. Real-tile
//                    loads cost one Map Tiles root request each.
//   --drive SCRIPT   comma list of KEYS:SECONDS, keys joined with "+", "_" for
//                    none: "W:4,W+A:1.5,_:1,S:2". Keys: W A S D Space R C, Up…
//   --settle S       wait after spawning before driving (default 2)
//   --setup JS       run in the page after settling; `g` is window.__drift
//   --debug LAYERS   overlay layers for the screenshots: wire,height|slope,
//                    nophoto,probes,history,overpass,tyres
//   --shots S        also screenshot every S seconds while driving
//   --out PREFIX     output prefix (default traces/capture-<time>)
//   --label TEXT     stored in the trace
//   --perf           record a Chrome performance trace (<out>.perf.json)
//   --headed         show the browser
//   --base URL       dev server (default http://localhost:5173; started if down)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { report } from './trace-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = { W: 'KeyW', A: 'KeyA', S: 'KeyS', D: 'KeyD', R: 'KeyR', C: 'KeyC', SPACE: 'Space', UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight' };

const opts = { target: '/?practice', settle: 2, shots: 0, drive: '', debug: '', setup: '', label: '', base: process.env.DRIFT_URL ?? 'http://localhost:5173' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--drive') opts.drive = next();
  else if (a === '--settle') opts.settle = Number(next());
  else if (a === '--setup') opts.setup = next();
  else if (a === '--debug') opts.debug = next();
  else if (a === '--shots') opts.shots = Number(next());
  else if (a === '--out') opts.out = next();
  else if (a === '--label') opts.label = next();
  else if (a === '--perf') opts.perf = true;
  else if (a === '--headed') opts.headed = true;
  else if (a === '--base') opts.base = next();
  else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
  else opts.target = a;
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const out = resolve(ROOT, opts.out ?? `traces/capture-${stamp}`);
mkdirSync(dirname(out), { recursive: true });

// Never write the key anywhere, even if the page logs a URL containing it.
const key = readEnvKey();
const redact = (s) => {
  let r = String(s);
  if (key) r = r.split(key).join('REDACTED');
  return r.replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…REDACTED').replace(/([?&](?:key|session|token)=)[^&\s"']+/gi, '$1REDACTED');
};

// Git Bash (MSYS) rewrites a bare "/…" argument into a Windows path.
if (/^[A-Za-z]:[\/]/.test(opts.target)) {
  console.error(`"${opts.target}" looks like a path Git Bash rewrote from "/…". Use "./" or "?lat=…" instead (or set MSYS_NO_PATHCONV=1).`);
  process.exit(2);
}
const server = await ensureServer(opts.base);
const url = new URL(opts.target, server.url).href;
if (!/[?&]practice\b/.test(url)) console.log('note: real-tile load (one billable Map Tiles root request)');

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  headless: !opts.headed,
  // Without these, headless Chrome falls back to SwiftShader and pegs the CPU.
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${redact(m.text())}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${redact(e.stack ?? e.message)}`));

let exitCode = 0;
try {
  // No `path`: the trace is redacted before it touches disk (tile URLs carry the key).
  if (opts.perf) await browser.startTracing(page, { screenshots: false });
  await page.goto(url);
  const phase = await waitForDriving(page, 60);
  if (phase !== 'driving') {
    const err = await page.evaluate(() => document.getElementById('menu-error')?.textContent ?? '');
    throw new Error(`never reached driving (phase ${phase})${err ? `: ${err}` : ''}`);
  }
  await page.waitForTimeout(opts.settle * 1000);
  if (opts.debug) await page.evaluate((v) => window.__drift.debug.applyParam(v), opts.debug);
  if (opts.setup) {
    await page.evaluate((src) => {
      const g = window.__drift;
      return new Function('g', src)(g);
    }, opts.setup);
  }
  await drive(page, opts.drive, opts.shots);
  await page.screenshot({ path: `${out}.png` });
  const trace = await page.evaluate((label) => window.__drift.debug.exportTrace({ label }), opts.label || opts.drive || 'capture');
  trace.meta.capture = { target: opts.target, drive: opts.drive, setup: opts.setup, debug: opts.debug };
  writeFileSync(`${out}.json`, redact(JSON.stringify(trace)));
  console.log(report(JSON.parse(readFileSync(`${out}.json`, 'utf8'))));
} catch (err) {
  console.error(`capture failed: ${err.message}`);
  await page.screenshot({ path: `${out}.png` }).catch(() => {});
  exitCode = 1;
} finally {
  if (opts.perf) {
    const buf = await browser.stopTracing().catch(() => null);
    if (buf) writeFileSync(`${out}.perf.json`, redact(buf.toString('utf8')));
  }
  writeFileSync(`${out}.console.log`, consoleLines.join('\n') + '\n');
  await browser.close();
  await server.close();
}
const rel = (p) => p.replace(ROOT + '\\', '').replace(ROOT + '/', '');
console.log(`\nwrote ${rel(out)}.{json,png,console.log}${opts.perf ? ' + .perf.json (open in chrome://tracing or Perfetto)' : ''}`);
process.exit(exitCode);

async function waitForDriving(page, seconds) {
  let phase = null;
  for (let i = 0; i < seconds * 4; i++) {
    phase = await page.evaluate(() => window.__drift?.phase ?? null).catch(() => null);
    if (phase === 'driving') return phase;
    if (phase === 'idle' && i > 8) return phase;
    await page.waitForTimeout(250);
  }
  return phase;
}

async function drive(page, script, shotEvery) {
  const steps = script
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [keys, secs] = s.split(':');
      const codes = keys === '_' ? [] : keys.split('+').map((k) => KEYS[k.toUpperCase()] ?? (k.length === 1 ? `Key${k.toUpperCase()}` : k));
      return { codes, ms: Number(secs ?? 1) * 1000 };
    });
  const held = new Set();
  let shot = 0;
  // Wall-clock deadlines, so time spent taking screenshots counts against the holds.
  let nextShot = shotEvery ? performance.now() + shotEvery * 1000 : Infinity;
  let end = performance.now();
  for (const st of steps) {
    for (const c of [...held]) if (!st.codes.includes(c)) (await page.keyboard.up(c), held.delete(c));
    for (const c of st.codes) if (!held.has(c)) (await page.keyboard.down(c), held.add(c));
    end += st.ms;
    for (let now = performance.now(); now < end; now = performance.now()) {
      await page.waitForTimeout(Math.max(0, Math.min(end, nextShot) - now));
      if (performance.now() >= nextShot) {
        nextShot += shotEvery * 1000;
        await page.screenshot({ path: `${out}.${String(++shot).padStart(2, '0')}.png` });
      }
    }
  }
  for (const c of held) await page.keyboard.up(c);
}

async function ensureServer(base) {
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return { url: base, close: async () => {} };
  } catch {
    // Not running: start one for this capture.
  }
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, server: { port: 5199, strictPort: false }, logLevel: 'warn' });
  await vite.listen();
  const local = vite.resolvedUrls?.local?.[0] ?? 'http://localhost:5199/';
  console.log(`started dev server at ${local}`);
  return { url: local, close: () => vite.close() };
}

function readEnvKey() {
  try {
    const m = readFileSync(resolve(ROOT, '.env'), 'utf8').match(/^\s*MAPS_API_KEY\s*=\s*"?([^"\s]+)"?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
