// Shared by the tools that drive the game in Chrome (capture.mjs, scenarios.mjs):
// the dev server, launching Chrome with GL flags that suit the machine, key
// redaction and waiting for the car to spawn.
import { createServer as netServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Chrome flags for WebGL. Without a GPU flag headless Chrome falls back to
 * SwiftShader and pegs the CPU, so Windows and macOS ask for the GPU (ANGLE on
 * D3D11 / Metal). Linux CI runners have no GPU, and recent Chrome only runs
 * WebGL on SwiftShader (ANGLE's CPU Vulkan) when told to. DRIFT_GL picks the
 * ANGLE backend instead: d3d11, metal, vulkan, gl or swiftshader.
 */
export function glArgs(gl = process.env.DRIFT_GL || { win32: 'd3d11', darwin: 'metal' }[process.platform] || 'swiftshader') {
  if (gl === 'swiftshader') return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  return [`--use-angle=${gl}`, '--enable-gpu', '--ignore-gpu-blocklist'];
}

/** Installed Chrome (or CHROME_PATH / `chromePath`), headless unless `headed`. */
export function launchChrome({ headed = false, chromePath = process.env.CHROME_PATH, gl } = {}) {
  return chromium.launch({
    ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }),
    headless: !headed,
    args: [...glArgs(gl), '--autoplay-policy=no-user-gesture-required'],
  });
}

/** A dev server of our own on a free port; close() it when done. */
export async function startServer() {
  const port = await freePort();
  const { createServer, createLogger } = await import('vite');
  // Whatever Vite prints goes through the key redaction too: a tile URL in a
  // proxy or transform warning would otherwise reach the terminal or CI log raw.
  const logger = createLogger('warn');
  const redact = makeRedact();
  for (const k of ['info', 'warn', 'warnOnce', 'error']) {
    const f = logger[k].bind(logger);
    logger[k] = (msg, o) => f(redact(msg), o);
  }
  // No HMR: an edit while a run is going must not reload the page under it.
  // No console forwarding (Vite 8 turns it on under coding agents): the page's
  // console.error lines, tile URLs and all, are the runner's to redact and keep.
  const vite = await createServer({ root: ROOT, server: { port, strictPort: false, hmr: false, forwardConsole: false }, customLogger: logger });
  await vite.listen();
  return { url: vite.resolvedUrls?.local?.[0] ?? `http://localhost:${port}/`, close: () => vite.close() };
}

/** The server at `base` if one answers, else one of our own. */
export async function ensureServer(base) {
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return { url: base, close: async () => {} };
  } catch {
    // Not running: start one for this run.
  }
  const server = await startServer();
  console.log(`started dev server at ${server.url}`);
  return server;
}

function freePort() {
  return new Promise((done, fail) => {
    const s = netServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
}

/** Strips the .env key and anything key- or token-shaped: page output is never written or printed raw. */
export function makeRedact(key = readEnvKey()) {
  return (s) => {
    let r = String(s);
    if (key) r = r.split(key).join('REDACTED');
    return r.replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…REDACTED').replace(/([?&](?:key|session|token)=)[^&\s"']+/gi, '$1REDACTED');
  };
}

export function readEnvKey() {
  try {
    const m = readFileSync(resolve(ROOT, '.env'), 'utf8').match(/^\s*MAPS_API_KEY\s*=\s*"?([^"\s]+)"?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Polls the game's phase until it is driving (or gives up after `seconds`, or idle: a failed start). */
export async function waitForDriving(page, seconds) {
  let phase = null;
  for (let i = 0; i < seconds * 4; i++) {
    phase = await page.evaluate(() => window.__drift?.phase ?? null).catch(() => null);
    if (phase === 'driving') return phase;
    if (phase === 'idle' && i > 8) return phase;
    await page.waitForTimeout(250);
  }
  return phase;
}
