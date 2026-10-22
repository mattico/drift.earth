#!/usr/bin/env node
// Checks the road data behind "back to road" (src/world/osmRoads.ts, roads.ts,
// roadSnap.ts) without a browser or Google tiles: first the spot search on
// synthetic streets and the loader's tile choice, then, for every spot in src/locations.ts, the real
// OpenFreeMap z14 tiles through the game's loader, projected onto a local
// east/north plane around the spot. Spots sit on drivable streets, so the
// nearest drivable road should be a few metres away.
//
//   node tools/roads.mjs [filter] [--json]
//
//   filter   only spots whose name contains this text
//
// Exits non-zero if a synthetic check fails or a spot has no drivable road
// within 25 m. Needs network access to tiles.openfreemap.org.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { Vector3 } from 'three';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false } });
const { OsmRoads, tileCoords } = await vite.ssrLoadModule('/src/world/osmRoads.ts');
const { RoadNetwork } = await vite.ssrLoadModule('/src/world/roads.ts');
const { findRoadSpot } = await vite.ssrLoadModule('/src/world/roadSnap.ts');
const { SPOTS } = await vite.ssrLoadModule('/src/locations.ts');
const { CARS, DEFAULT_CAR } = await vite.ssrLoadModule('/src/car/cars.ts');

const MAX_DISTANCE = 25;
const LOAD_TIMEOUT = 30000;
const R = 6378137;
const DEG = 180 / Math.PI;

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
let failed = false;

// --- Spot search on a synthetic street ------------------------------------------
// An east–west street 10 m north of the car on a flat floor, with a parked car
// (a 1.5 m box) right where the street passes closest: the search should slide
// along the street past it and face whichever way is closer to the car's heading.
{
  const box = { x0: -2.5, x1: 2.5, z0: -11, z1: -9, top: 1.5 };
  const inBox = (x, z) => x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1;
  const hit = (x, y, z) => ({ point: new Vector3(x, y, z), normal: new Vector3(0, 1, 0), distance: 0, object: null });
  const collider = {
    castColumn(x, z, fromY, far) {
      const hits = [];
      for (const y of inBox(x, z) ? [box.top, 0] : [0]) if (y <= fromY && y >= fromY - far) hits.push({ ...hit(x, y, z), distance: fromY - y });
      return hits;
    },
    castWide() {
      return null;
    },
  };
  const roads = new RoadNetwork([{ xz: new Float64Array([-50, -10, 50, -10]), cls: 'minor', bridge: false, layer: 0, paved: true, service: null }]);
  const chassis = CARS[DEFAULT_CAR].chassis;
  const cases = [
    // heading 0 faces north; +0.3 turns a little left (west), −0.3 a little right (east).
    { heading: 0.3, x: 8, facing: Math.PI / 2 },
    { heading: -0.3, x: 8, facing: -Math.PI / 2 },
  ];
  for (const c of cases) {
    const { spot, tried } = findRoadSpot(roads, collider, new Vector3(0, 0, 0), c.heading, chassis);
    const ok = spot && Math.abs(spot.pos.x - c.x) < 0.01 && Math.abs(spot.pos.z + 10) < 0.01 && Math.abs(spot.heading - c.facing) < 1e-6;
    const verdicts = tried.map((t) => `${t.offset}:${t.verdict}`).join(' ');
    console.log(`synthetic street, heading ${c.heading}: ${ok ? 'ok' : 'FAILED'} → ${spot ? `${spot.pos.x.toFixed(1)}, ${spot.pos.z.toFixed(1)} ψ ${spot.heading.toFixed(2)}` : 'no spot'}  (${verdicts})`);
    if (!ok) failed = true;
  }
}

// A bridge deck 6 m up (1 m thick: the mesh's underside reads as flat too)
// with a bus baked onto it where the bridge passes closest. The mesh has no
// deck under the bus, so the bus roof is the topmost flat hit: the search must
// see the deck beside it is lower and slide along past it.
{
  const bus = { x0: -5, x1: 5, z0: -11.3, z1: -8.7, top: 9 };
  const onBus = (x, z) => x >= bus.x0 && x <= bus.x1 && z >= bus.z0 && z <= bus.z1;
  const onDeck = (x, z) => Math.abs(x) < 50 && z >= -16 && z <= -4;
  const collider = {
    castColumn(x, z, fromY, far) {
      const ys = onBus(x, z) ? [bus.top, 5, 0] : onDeck(x, z) ? [6, 5, 0] : [0];
      return ys
        .filter((y) => y <= fromY && y >= fromY - far)
        .map((y) => ({ point: new Vector3(x, y, z), normal: new Vector3(0, 1, 0), distance: fromY - y, object: null }));
    },
    castWide() {
      return null;
    },
  };
  const roads = new RoadNetwork([{ xz: new Float64Array([-50, -10, 50, -10]), cls: 'primary', bridge: true, layer: 1, paved: true, service: null }]);
  const { spot, tried } = findRoadSpot(roads, collider, new Vector3(0, 0, 0), -0.3, CARS[DEFAULT_CAR].chassis);
  const ok = spot && Math.abs(spot.pos.x - 8) < 0.01 && Math.abs(spot.pos.y - 6) < 0.01 && tried[0].verdict === 'perched';
  const verdicts = tried.map((t) => `${t.offset}:${t.verdict}`).join(' ');
  console.log(`bus on a bridge: ${ok ? 'ok' : 'FAILED'} → ${spot ? `${spot.pos.x.toFixed(1)}, ${spot.pos.y.toFixed(1)}, ${spot.pos.z.toFixed(1)}` : 'no spot'}  (${verdicts})`);
  if (!ok) failed = true;
}

// A deck mapped along the street under it: both are candidates, not duplicates.
{
  const line = new Float64Array([-50, -10, 50, -10]);
  const roads = new RoadNetwork([
    { xz: line, cls: 'primary', bridge: false, layer: 0, paved: true, service: null },
    { xz: line, cls: 'motorway', bridge: true, layer: 1, paved: true, service: null },
  ]);
  const levels = roads.nearest(0, 0, 50).map((p) => (p.bridge ? 'deck' : 'street'));
  const ok = levels.length === 2 && levels.includes('deck') && levels.includes('street');
  console.log(`stacked roads: ${ok ? 'ok' : 'FAILED'} → ${levels.join(', ')}`);
  if (!ok) failed = true;
}

// Stuck on a sidewalk: the street's centreline 15 m away beats a driveway 4 m away.
{
  const roads = new RoadNetwork([
    { xz: new Float64Array([-50, 15, 50, 15]), cls: 'secondary', bridge: false, layer: 0, paved: true, service: null },
    { xz: new Float64Array([0, -4, 0, -40]), cls: 'service', bridge: false, layer: 0, paved: true, service: 'driveway' },
  ]);
  const order = roads.nearest(0, 0, 50).map((p) => p.cls);
  const ok = order[0] === 'secondary' && order.includes('service');
  console.log(`driveway vs street: ${ok ? 'ok' : 'FAILED'} → ${order.join(', ')}`);
  if (!ok) failed = true;
}

// Tile choice (no network: an empty template). Within 300 m of an edge the
// neighbour loads too: at 78° N tiles are ~510 m across, so the middle needs
// both sides; at the antimeridian the neighbour's column wraps.
{
  const cases = [
    { name: 'Longyearbyen, mid-tile', lat: 78.2232, lon: 15.6267, check: (w) => new Set(w.map((k) => k.split('/')[0])).size === 3 },
    { name: 'antimeridian, east side', lat: -16.8, lon: 179.999, check: (w) => w.some((k) => k.startsWith('0/')) && w.every((k) => +k.split('/')[0] < 2 ** 14) },
    { name: 'antimeridian, west side', lat: -16.8, lon: -179.999, check: (w) => w.some((k) => k.startsWith(`${2 ** 14 - 1}/`)) && w.every((k) => +k.split('/')[0] >= 0) },
  ];
  for (const c of cases) {
    const osm = new OsmRoads(() => [0, 0], 'data:application/json,{"tiles":["data:,"]}');
    // A spot in the middle of its tile's columns, for the Longyearbyen case.
    const { x } = tileCoords(c.lat, c.lon);
    const lon = c.name.includes('mid') ? ((Math.floor(x) + 0.5) / 2 ** 14) * 360 - 180 : c.lon;
    osm.update(c.lat, lon);
    const wanted = osm.wanted;
    osm.dispose();
    const ok = c.check(wanted);
    console.log(`tiles, ${c.name}: ${ok ? 'ok' : 'FAILED'} → ${wanted.join(' ')}`);
    if (!ok) failed = true;
  }
  console.log();
}

// --- Real tiles at every spot -------------------------------------------------------
const results = [];
for (const spot of SPOTS) {
  if (filter && !spot.name.includes(filter)) continue;
  const cosLat = Math.cos(spot.lat / DEG);
  // Local east/north plane: +X east, −Z north, as in the game.
  // Longitude difference wrapped to ±180, for tiles across the antimeridian.
  const project = (lat, lon) => [((((lon - spot.lon + 540) % 360) - 180) / DEG) * R * cosLat, (-(lat - spot.lat) / DEG) * R];
  const osm = new OsmRoads(project);
  const t0 = performance.now();
  osm.update(spot.lat, spot.lon);
  while (osm.pending && performance.now() - t0 < LOAD_TIMEOUT) {
    await new Promise((r) => setTimeout(r, 50));
    osm.update(spot.lat, spot.lon);
  }
  const loadMs = performance.now() - t0;
  const tiles = osm.decoded();
  const net = osm.network;
  const classes = {};
  for (const t of tiles) for (const [k, n] of Object.entries(t.classes)) classes[k] = (classes[k] ?? 0) + n;
  const drivable = {};
  for (const w of net?.ways ?? []) drivable[w.cls] = (drivable[w.cls] ?? 0) + (w.xz.length / 2 - 1);
  // nearest() ranks by cost (minor classes penalised); this wants plain distance.
  const near = (net?.nearest(0, 0, 200) ?? []).reduce((best, p) => (!best || p.distance < best.distance ? p : best), null);
  // Compass bearing of the road, 0…180 (a road runs both ways), and how far it is off the spot's heading.
  const bearing = near ? (((Math.atan2(near.dirX, -near.dirZ) * DEG) % 180) + 180) % 180 : null;
  const turn = bearing === null ? null : (((spot.bearing - bearing) % 180) + 180) % 180;
  const offHeading = turn === null ? null : Math.min(turn, 180 - turn);
  const r = {
    name: spot.name,
    tiles: tiles.map((t) => `${t.z}/${t.x}/${t.y}`),
    kB: Math.round(tiles.reduce((s, t) => s + t.bytes, 0) / 1024),
    loadMs: Math.round(loadMs),
    decodeMs: Math.round(tiles.reduce((s, t) => s + t.decodeMs, 0)),
    segments: net?.segments.length ?? 0,
    drivable,
    classes,
    nearest: near && { distance: near.distance, cls: near.cls, bridge: near.bridge, layer: near.layer, bearing, offHeading },
    errors: osm.stats().roadErrors,
  };
  osm.dispose();
  if (!near || near.distance > MAX_DISTANCE) {
    r.fail = true;
    failed = true;
  }
  results.push(r);
}
await vite.close();

if (args.includes('--json')) {
  console.log(JSON.stringify(results, null, 1));
} else {
  const f = (n, w) => String(n).padStart(w);
  console.log(`${'spot'.padEnd(22)} tiles    kB load ms decode ms  segments  nearest drivable road`);
  for (const r of results) {
    const n = r.nearest;
    const road = n
      ? `${n.distance.toFixed(1)} m ${n.cls}${n.bridge ? ' bridge' : ''}${n.layer ? ` layer ${n.layer}` : ''}, bearing ${n.bearing.toFixed(0)}° (${n.offHeading.toFixed(0)}° off the spot's heading)`
      : 'none within 200 m';
    console.log(`${r.name.padEnd(22)} ${f(r.tiles.length, 5)} ${f(r.kB, 5)} ${f(r.loadMs, 7)} ${f(r.decodeMs, 9)} ${f(r.segments, 9)}  ${road}${r.fail ? '  FAIL' : ''}${r.errors ? `  (${r.errors} load errors)` : ''}`);
    const by = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`${''.padEnd(22)} drivable segments: ${by(r.drivable)}`);
    console.log(`${''.padEnd(22)} all transportation features: ${by(r.classes)}`);
  }
}
process.exit(failed ? 1 : 0);
