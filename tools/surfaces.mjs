#!/usr/bin/env node
// Checks the surface map behind TilesWorld.surfaceAt (src/world/osmSurface.ts)
// without a browser or Google tiles: first the rasteriser and lookup on
// synthetic tiles, then, for every spot in src/locations.ts, the real
// OpenFreeMap z14 tiles through the game's loader and rasteriser, on a local
// east/north plane around the spot. Spots sit on streets, so the spot itself
// should read asphalt.
//
//   node tools/surfaces.mjs [filter] [--png DIR] [--json]
//
//   filter      only spots whose name contains this text
//   --png DIR   also write DIR/<spot>.png: the classified ground 400 m square
//               around the spot, north up, in the debug overlay's colours,
//               with a ring at the spot
//
// Exits non-zero if a synthetic check fails or a spot doesn't read asphalt.
// Needs network access to tiles.openfreemap.org.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false } });
const { OsmRoads, tileCoords } = await vite.ssrLoadModule('/src/world/osmRoads.ts');
const { GRID, OsmSurface, Painter, SURFACE_CODE, rasterise } = await vite.ssrLoadModule('/src/world/osmSurface.ts');
const { SURFACE_IDS } = await vite.ssrLoadModule('/src/car/surfaces.ts');
const { SURFACE_COLORS } = await vite.ssrLoadModule('/src/debug/overlay.ts');
const { SPOTS } = await vite.ssrLoadModule('/src/locations.ts');

const LOAD_TIMEOUT = 30000;
/** Histogram radius (m). */
const NEAR = 150;
/** How far (m) to look for the nearest water and grass. */
const SEARCH = 300;
/** PNG: side (m) and metres per pixel. */
const PNG_SPAN = 400;
const PNG_RES = 0.5;
/** The game's per-frame rasterising budget (tilesWorld.ts), for the time-sliced run. */
const BUDGET = 3;
const R = 6378137;
const DEG = 180 / Math.PI;

const args = process.argv.slice(2);
const pngDir = args.includes('--png') ? resolve(args[args.indexOf('--png') + 1]) : null;
const filter = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--png');
let failed = false;

const check = (name, ok, detail = '') => {
  console.log(`${name}: ${ok ? 'ok' : 'FAILED'}${detail ? ` → ${detail}` : ''}`);
  if (!ok) failed = true;
};

// --- Synthetic checks ----------------------------------------------------------
// A stand-in for @mapbox/vector-tile: layers of features in 4096-unit tile pixels.
const feature = (type, properties, geometry) => ({
  type,
  extent: 4096,
  properties,
  loadGeometry: () => geometry.map((ring) => ring.map(([x, y]) => ({ x, y }))),
});
const mockTile = (layers) => ({
  layers: Object.fromEntries(Object.entries(layers).map(([k, fs]) => [k, { length: fs.length, extent: 4096, feature: (i) => fs[i] }])),
});
const box = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];
const count = (cells, v = 1) => cells.reduce((n, c) => n + (c === v ? 1 : 0), 0);

// A square with a square hole, the hole wound the other way as in MVT.
{
  const n = 32;
  const cells = new Uint8Array(n * n);
  new Painter(cells, n).fill([new Float64Array([4, 4, 28, 4, 28, 28, 4, 28]), new Float64Array([12, 12, 12, 20, 20, 20, 20, 12])], 1);
  const at = (i, j) => cells[j * n + i];
  const ok = count(cells) === 24 * 24 - 8 * 8 && at(4, 4) === 1 && at(27, 27) === 1 && at(16, 16) === 0 && at(11, 16) === 1 && at(3, 3) === 0;
  check('polygon with a hole', ok, `${count(cells)} cells (want ${24 * 24 - 8 * 8})`);
}

// A concave star against a point-in-polygon test at every cell centre.
{
  const n = 64;
  const pts = [];
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * 2 * Math.PI;
    const r = k % 2 ? 12 : 29;
    pts.push(32.3 + r * Math.cos(a), 31.7 + r * Math.sin(a));
  }
  const cells = new Uint8Array(n * n);
  new Painter(cells, n).fill([new Float64Array(pts)], 1);
  let wrong = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i + 0.5;
      const y = j + 0.5;
      let inside = false;
      for (let k = 0, m = pts.length; k < m; k += 2) {
        const [ax, ay, bx, by] = [pts[k], pts[k + 1], pts[(k + 2) % m], pts[(k + 3) % m]];
        if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
      }
      if (inside !== (cells[j * n + i] === 1)) wrong++;
    }
  }
  check('concave polygon', wrong === 0, `${wrong} cells differ from point-in-polygon`);
}

// A bent thick line against the distance to its centreline at every cell centre.
{
  const n = 64;
  const line = [5.2, 10.1, 40.7, 22.3, 30.1, 55.6];
  const r = 3.3;
  const cells = new Uint8Array(n * n);
  new Painter(cells, n).line(new Float64Array(line), r, 1);
  let wrong = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let d = Infinity;
      for (let k = 0; k + 3 < line.length; k += 2) {
        const [ax, ay, bx, by] = line.slice(k, k + 4);
        const t = Math.max(0, Math.min(1, ((i + 0.5 - ax) * (bx - ax) + (j + 0.5 - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
        d = Math.min(d, Math.hypot(i + 0.5 - ax - t * (bx - ax), j + 0.5 - ay - t * (by - ay)));
      }
      if (Math.abs(d - r) > 1e-6 && d < r !== (cells[j * n + i] === 1)) wrong++;
    }
  }
  check('thick line', wrong === 0, `${wrong} cells differ from the distance test`);
}

// Off the edges: a polygon well past the tile's buffer and a line across its
// west edge are clipped, and nothing wraps into the neighbouring row.
{
  const n = 32;
  const cells = new Uint8Array(n * n);
  const paint = new Painter(cells, n);
  paint.fill([new Float64Array([-50, -50, 90, -50, 90, 4, -50, 4])], 1);
  paint.line(new Float64Array([-10, 16, 3, 16]), 1.2, 2);
  paint.fill([new Float64Array([40, 40, 60, 40, 60, 60])], 3);
  const ok =
    count(cells, 1) === 4 * n &&
    count(cells, 3) === 0 &&
    cells[16 * n] === 2 &&
    cells[16 * n + 3] === 2 &&
    cells[16 * n + 5] === 0 &&
    cells[15 * n + n - 1] === 0 &&
    cells[16 * n + n - 1] === 0;
  check('tile-edge clipping', ok, `${count(cells, 1)} polygon cells (want ${4 * n}), line ${count(cells, 2)} cells`);
}

// Priority: grass everywhere west of x = 2048 (ice to the east stays hard
// ground), with bare rock, sand and scree listed before the park they sit in;
// a court in the park; a turf pitch and a racecourse on the hard ground, and a
// running track around a turf pitch listed before it; a lake over the middle
// with a paved road, a footbridge, a footbridge outline, a pier and a
// pedestrian plaza; a dry pond; an unpaved track that a paved road crosses; a
// pedestrian street through the park; a culverted stream; a road tunnel under
// the park and the lake; and a road fording the lake.
{
  const n = 512;
  const tile = mockTile({
    landcover: [
      feature(3, { class: 'rock', subclass: 'bare_rock' }, [box(300, 700, 400, 800)]),
      feature(3, { class: 'sand', subclass: 'beach' }, [box(500, 700, 600, 800)]),
      feature(3, { class: 'rock', subclass: 'scree' }, [box(1100, 700, 1200, 800)]),
      feature(3, { class: 'grass', subclass: 'park' }, [box(-64, -64, 2048, 4160)]),
      feature(3, { class: 'ice' }, [box(2048, -64, 4160, 4160)]),
    ],
    // A tile unit is 0.6 m here: a 24 m court, a 240 m field, a 60 × 48 m
    // pitch in a 180 m running track, and a 950 m racecourse.
    landuse: [
      feature(3, { class: 'pitch' }, [box(200, 200, 240, 240)]),
      feature(3, { class: 'pitch' }, [box(2200, 200, 2600, 600)]),
      feature(3, { class: 'residential' }, [box(700, 200, 900, 600)]),
      feature(3, { class: 'pitch' }, [box(2300, 3040, 2400, 3120)]),
      feature(3, { class: 'track' }, [box(2200, 3000, 2500, 3160)]),
      feature(3, { class: 'track' }, [box(2200, 3300, 3800, 3900)]),
    ],
    water: [
      feature(3, { class: 'lake', intermittent: 0 }, [box(1000, 1000, 3000, 2000)]),
      feature(3, { class: 'pond', intermittent: 1 }, [box(200, 3000, 600, 3400)]),
      feature(3, { class: 'river', brunnel: 'tunnel' }, [box(700, 3000, 900, 3400)]),
    ],
    transportation: [
      feature(3, { class: 'path', subclass: 'pedestrian' }, [box(2600, 1200, 2800, 1400)]),
      feature(3, { class: 'path', subclass: 'footway', brunnel: 'bridge' }, [box(2100, 1100, 2200, 1200)]),
      feature(2, { class: 'primary', surface: 'paved' }, [[[0, 1500], [4096, 1500]]]),
      feature(2, { class: 'track' }, [[[300, 2500], [1800, 2500]]]),
      feature(2, { class: 'minor' }, [[[1000, 2300], [1000, 2700]]]),
      feature(2, { class: 'minor', brunnel: 'tunnel' }, [[[1500, 900], [1500, 2100]]]),
      feature(2, { class: 'path', subclass: 'footway' }, [[[2000, 900], [2000, 2100]]]),
      feature(2, { class: 'path', subclass: 'footway', brunnel: 'bridge' }, [[[1804, 900], [1804, 2100]]]),
      feature(2, { class: 'pier' }, [[[2500, 1804], [3000, 1804]]]),
      feature(2, { class: 'path', subclass: 'pedestrian' }, [[[100, 2804], [900, 2804]]]),
      feature(2, { class: 'minor', brunnel: 'ford' }, [[[2900, 1100], [2900, 1400]]]),
    ],
  });
  const cells = rasterise(tile, 14, 8192, n);
  const at = (x, y) => SURFACE_IDS[cells[Math.floor((y / 4096) * n) * n + Math.floor((x / 4096) * n)]];
  const want = [
    [100, 100, 'grass'],
    [3000, 100, 'asphalt'],
    [350, 750, 'cobbles'],
    [550, 750, 'sand'],
    [1150, 750, 'gravel'],
    [220, 220, 'asphalt'],
    [800, 400, 'grass'],
    [2400, 400, 'grass'],
    [2220, 3080, 'asphalt'],
    [2350, 3080, 'grass'],
    [3000, 3600, 'grass'],
    [1200, 1200, 'water'],
    [2400, 1800, 'water'],
    [1200, 1500, 'asphalt'],
    [2700, 1300, 'asphalt'],
    [2150, 1150, 'asphalt'],
    [1804, 1200, 'asphalt'],
    [2700, 1804, 'asphalt'],
    [400, 3200, 'grass'],
    [800, 3200, 'grass'],
    [600, 2500, 'gravel'],
    [1000, 2500, 'asphalt'],
    [500, 2804, 'asphalt'],
    [500, 2860, 'grass'],
    [1500, 948, 'asphalt'],
    [1500, 1200, 'water'],
    [2000, 1200, 'water'],
    [2900, 1250, 'ford'],
    [2860, 1250, 'water'],
  ];
  const bad = want.filter(([x, y, s]) => at(x, y) !== s).map(([x, y, s]) => `(${x}, ${y}) ${at(x, y)}, want ${s}`);
  check('priority order', bad.length === 0, bad.join('; '));
}

// Lookup: a lake at known tile pixels of the Minneapolis tile, found through
// the time-sliced rasteriser and the world → tile mapping, from a local plane
// whose origin is ~600 m away from the lake.
{
  const z = 14;
  const lat0 = 44.977634;
  const lon0 = -93.275376;
  const t = tileCoords(lat0, lon0);
  const tx = Math.floor(t.x);
  const ty = Math.floor(t.y);
  const toLatLon = (px, py) => {
    const n = 2 ** z;
    return [Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / 4096)) / n))) * DEG, ((tx + px / 4096) / n) * 360 - 180];
  };
  const cosLat = Math.cos(lat0 / DEG);
  const project = (lat, lon) => [((lon - lon0) / DEG) * R * cosLat, (-(lat - lat0) / DEG) * R];
  const unproject = (x, zz) => [lat0 - (zz / R) * DEG, lon0 + (x / (R * cosLat)) * DEG];
  const lakePx = [1000, 2000, 1200, 2200];
  const tile = { x: tx, y: ty, z, tile: mockTile({ water: [feature(3, { class: 'lake' }, [box(...lakePx)])] }) };
  const surf = new OsmSurface({ decoded: () => [tile], current: () => [tile] });
  surf.sync();
  let frames = 0;
  while (!surf.stats().surfaceTiles && frames < 1000) (surf.work(0.05), frames++);
  surf.setFrame(0, 0, unproject);
  const ask = (px, py) => surf.surfaceAt(...project(...toLatLon(px, py)));
  // 4 tile units is 2 cells, ~1.7 m here.
  const got = { inside: ask(1100, 2100), nearEdge: ask(1196, 2100), pastEdge: ask(1204, 2100), outside: ask(1500, 2100), otherTile: surf.surfaceAt(5000, 0) };
  const ok = got.inside === 'water' && got.nearEdge === 'water' && got.pastEdge === 'asphalt' && got.outside === 'asphalt' && got.otherTile === 'asphalt';
  check('lookup at known lat/lon', ok, `${Object.entries(got).map(([k, v]) => `${k} ${v}`).join(', ')}; rasterised over ${frames} slices`);
}
console.log();

// --- Real tiles at every spot -------------------------------------------------------
const results = [];
for (const spot of SPOTS) {
  if (filter && !spot.name.includes(filter)) continue;
  const cosLat = Math.cos(spot.lat / DEG);
  // Local east/north plane, as in tools/roads.mjs: +X east, −Z north.
  const project = (lat, lon) => [((((lon - spot.lon + 540) % 360) - 180) / DEG) * R * cosLat, (-(lat - spot.lat) / DEG) * R];
  const unproject = (x, z) => [spot.lat - (z / R) * DEG, spot.lon + (x / (R * cosLat)) * DEG];
  const osm = new OsmRoads(project);
  const t0 = performance.now();
  osm.update(spot.lat, spot.lon);
  while (osm.pending && performance.now() - t0 < LOAD_TIMEOUT) {
    await new Promise((r) => setTimeout(r, 50));
    osm.update(spot.lat, spot.lon);
  }
  const tiles = osm.current();

  // Each tile in one go, timed, then the game's way: time-sliced at BUDGET ms a
  // frame. Both must agree cell for cell.
  const whole = tiles.map((d) => {
    const s0 = performance.now();
    const cells = rasterise(d.tile, d.z, d.y);
    return { tile: `${d.z}/${d.x}/${d.y}`, kB: Math.round(d.bytes / 1024), ms: performance.now() - s0, cells };
  });
  const surf = new OsmSurface(osm);
  surf.sync();
  let frames = 0;
  let slowest = 0;
  while (surf.stats().surfaceTiles < tiles.length && frames < 10000) {
    const s0 = performance.now();
    surf.work(BUDGET);
    slowest = Math.max(slowest, performance.now() - s0);
    frames++;
  }
  // Private, but this is the test.
  const sliced = surf.ready;
  const same = whole.every((w, i) => sliced[i] && w.cells.every((c, k) => c === sliced[i].cells[k]));
  surf.setFrame(0, 0, unproject);

  // Lookup cost: four wheels a step, scattered around the spot.
  const N = 1e6;
  const pts = new Float64Array(2048).map(() => (Math.random() - 0.5) * 2 * NEAR);
  let sink = 0;
  const l0 = performance.now();
  for (let i = 0; i < N; i++) sink += surf.surfaceAt(pts[i & 2047], pts[(i + 977) & 2047]).length;
  const lookupNs = ((performance.now() - l0) / N) * 1e6;

  const histogram = Object.fromEntries(SURFACE_IDS.map((s) => [s, 0]));
  let samples = 0;
  const nearest = { water: Infinity, grass: Infinity };
  for (let z = -SEARCH; z <= SEARCH; z++) {
    for (let x = -SEARCH; x <= SEARCH; x++) {
      const d = Math.hypot(x, z);
      if (d > SEARCH) continue;
      const s = surf.surfaceAt(x, z);
      if (d <= NEAR) {
        histogram[s]++;
        samples++;
      }
      if (s in nearest && d < nearest[s]) nearest[s] = d;
    }
  }
  for (const s of SURFACE_IDS) histogram[s] = Math.round((histogram[s] / samples) * 1000) / 10;
  const at = surf.surfaceAt(0, 0);

  if (pngDir) {
    const size = Math.round(PNG_SPAN / PNG_RES);
    const rgb = new Uint8Array(size * size * 3);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const x = -PNG_SPAN / 2 + (c + 0.5) * PNG_RES;
        const z = -PNG_SPAN / 2 + (r + 0.5) * PNG_RES;
        const col = SURFACE_COLORS[surf.surfaceAt(x, z)];
        const d = Math.hypot(x, z);
        // A ring at the spot: white outside, black inside.
        const ring = d > 6 && d < 8 ? 0xffffff : d > 4.5 && d <= 6 ? 0x000000 : col;
        rgb.set([(ring >> 16) & 255, (ring >> 8) & 255, ring & 255], (r * size + c) * 3);
      }
    }
    mkdirSync(pngDir, { recursive: true });
    writeFileSync(join(pngDir, `${spot.name.replace(/[^A-Za-z0-9]+/g, '-')}.png`), png(size, size, rgb));
  }

  results.push({
    name: spot.name,
    at,
    tiles: whole.map(({ cells: _cells, ...w }) => ({ ...w, ms: Math.round(w.ms * 10) / 10 })),
    sliced: { frames, slowestMs: Math.round(slowest * 10) / 10, same },
    lookupNs: Math.round(lookupNs * 10) / 10,
    histogram,
    nearestWater: Number.isFinite(nearest.water) ? Math.round(nearest.water) : null,
    nearestGrass: Number.isFinite(nearest.grass) ? Math.round(nearest.grass) : null,
    errors: osm.stats().roadErrors,
    fail: at !== 'asphalt' || !same || !tiles.length,
    sink,
  });
  if (results[results.length - 1].fail) failed = true;
  osm.dispose();
}
await vite.close();

if (args.includes('--json')) {
  console.log(JSON.stringify(results.map(({ sink: _s, ...r }) => r), null, 1));
} else {
  const legend = Object.entries(SURFACE_COLORS)
    .map(([k, v]) => `${k} #${v.toString(16).padStart(6, '0')}`)
    .join(', ');
  console.log(`grid ${GRID}² cells a tile; colours: ${legend}\n`);
  console.log(`${'spot'.padEnd(22)} at spot  ${SURFACE_IDS.map((s) => s.padStart(7)).join('')}  (% within ${NEAR} m)  water   grass  lookup`);
  for (const r of results) {
    const hist = SURFACE_IDS.map((s) => String(r.histogram[s]).padStart(7)).join('');
    const dist = (d) => (d === null ? `>${SEARCH} m` : `${d} m`).padStart(7);
    console.log(
      `${r.name.padEnd(22)} ${r.at.padEnd(8)} ${hist}                  ${dist(r.nearestWater)} ${dist(r.nearestGrass)}  ${r.lookupNs} ns${r.fail ? '  FAIL' : ''}${r.errors ? `  (${r.errors} load errors)` : ''}`,
    );
    const tiles = r.tiles.map((t) => `${t.tile} ${t.kB} kB ${t.ms} ms`).join(', ');
    console.log(`${''.padEnd(22)} rasterise: ${tiles}; sliced at ${BUDGET} ms: ${r.sliced.frames} frames, slowest ${r.sliced.slowestMs} ms${r.sliced.same ? '' : ', DIFFERS from the one-go grid'}`);
  }
  if (pngDir) console.log(`\nwrote ${results.length} PNGs to ${pngDir}`);
}
process.exit(failed ? 1 : 0);

/** An 8-bit RGB PNG. */
function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
