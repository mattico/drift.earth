#!/usr/bin/env node
// Fails if a build contains anything shaped like a Google API key, except the
// one key it is told to expect. Vite inlines MAPS_API_KEY into the bundle: a
// local build gets the developer's key from .env, which must never be
// published; the Pages deploy builds in its own referrer-restricted key from
// the MAPS_API_KEY Actions secret, passed here as ALLOWED_KEY. CI runs this
// after the build; run it locally before publishing dist/.
//
//   ALLOWED_KEY=… node tools/check-no-key.mjs [dir]    (default: dist)
//
// Matches are reported by file and offset only; no key is ever printed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const KEY = /AIza[0-9A-Za-z_-]{20,}/g;
const allowed = process.env.ALLOWED_KEY || null;

const root = resolve(process.argv[2] ?? 'dist');
const shown = relative(process.cwd(), root).startsWith('..') ? root : relative(process.cwd(), root) || '.';
let stat;
try {
  stat = statSync(root);
} catch {
  console.error(`check-no-key: ${root} does not exist; build first`);
  process.exit(2);
}
if (!stat.isDirectory()) {
  console.error(`check-no-key: ${root} is not a directory`);
  process.exit(2);
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

let scanned = 0;
let expected = 0;
const hits = [];
for (const file of files(root)) {
  scanned++;
  // latin1 maps every byte to one character, so binary files (images, wasm)
  // are scanned too and offsets are byte offsets.
  const text = readFileSync(file).toString('latin1');
  for (const m of text.matchAll(KEY)) {
    if (m[0] === allowed) expected++;
    else hits.push(`${relative(root, file)} @ byte ${m.index} (${m[0].length} chars)`);
  }
}

if (!scanned) {
  console.error(`check-no-key: ${root} is empty; build first`);
  process.exit(2);
}
if (hits.length) {
  console.error(`check-no-key: found ${hits.length} API-key-shaped string(s) in ${shown}:`);
  for (const h of hits) console.error(`  ${h}`);
  console.error(
    allowed
      ? 'Only the deployment key (ALLOWED_KEY) may be built in; find where the other came from.'
      : "Rebuild with the key variables empty (they override .env) and check again: MAPS_API_KEY= VITE_GOOGLE_MAPS_KEY= pnpm build, or in PowerShell $env:MAPS_API_KEY=''; $env:VITE_GOOGLE_MAPS_KEY=''; pnpm build",
  );
  process.exit(1);
}
console.log(`check-no-key: ${scanned} files in ${shown}, ${expected ? `only the deployment key (${expected}×)` : 'no API keys'}`);
