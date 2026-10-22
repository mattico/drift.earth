# drift.earth

An arcade drifting game played on Google's Photorealistic 3D Tiles. The camera looks down from slightly behind the car, about as close as the tile data's resolution allows.

The default start is a street in downtown Minneapolis. Press **Esc** for the menu, where you can pick another city, search any place, or paste coordinates or a Google Maps link.

## Running it

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # type-check + production build into dist/
```

### API key

Put a Google Maps Platform key in `.env`:

```
MAPS_API_KEY=AIza...
```

The key needs these APIs enabled, and allowed under the key's **API restrictions**:

- **Map Tiles API** (required). Billing counts one request per root tileset load, which is roughly one per location you start. The free tier is 1,000 per month.
- **Places API (New)** (optional). Only the place search box uses it.

The key ships to the browser, so restrict it by HTTP referrer, for example `http://localhost:5173/*` plus your production origin. If `.env` has no key, the menu asks for one and stores it in `localStorage`.

`?practice` runs an offline test track that needs no key.

### Deep links

`/?lat=44.97889&lon=-93.24472&bearing=14&top=1` starts at that spot.
- `bearing` is a compass heading.
- `top=1` spawns on the highest surface, such as a bridge deck. Without it, the game looks for the lowest flat ground nearby so you don't start on a roof.
- `h=218.3` spawns on the surface closest to that height (metres above the WGS84 ellipsoid). `kmh=90` starts already moving. Repro links from the debug tools use both.
- `debug` opens the debug panel; `debug=wire,probes,history` also picks the overlay layers (see below).

## Controls

| | Keyboard | Gamepad |
|---|---|---|
| Throttle | W / ↑ | RT |
| Brake / reverse | S / ↓ | LT |
| Steer | A D / ← → | Left stick |
| Handbrake (drift) | Space | A / RB |
| Shift down / up (switches to manual) | Q / E | X / B |
| Back to automatic | T, or click AUTO/MANUAL | |
| Reset to a recent spot | R | Y |
| Camera tilt preset | C | LB |
| Zoom | Mouse wheel, + / − | Right stick Y |
| Menu / pause | Esc | Start |
| Mute | M | |
| Debug panel | F3 or ` | |
| Mark the debug trace | F8 | |
| Save the debug trace | F9 | |

On touch devices an on-screen steering pad and GAS, BRAKE and DRIFT buttons appear. Tap AUTO/MANUAL on the gear selector to switch; in manual, ▼▲ buttons appear under it.

**Gearbox:** the engine makes 420 N·m at 5,000 rpm and 354 hp at 7,100 rpm, with a 7,500 rpm redline and a limiter at 7,800. The six-speed box runs out at 77, 106, 137, 165, 191 and 217 km/h; top speed is about 180 km/h in 5th, limited by drag. 0–100 km/h takes 3.6 s.
- **Automatic** is the default. It shifts later the harder you press, and holds its gear while sliding so feathering the throttle doesn't short-shift it.
- **Manual:** pressing Q or E switches to manual. Each shift cuts drive for 0.14 s. A downshift that would over-rev is refused (the selector flashes red). In 1st the car sits on the limiter early. The tach rim glows yellow near redline and red on the limiter.
- **Engine braking** grows with rpm, so a lower gear slows the car harder.
- **The gear matters for drifting.** Throttle oversteer scales with the drive the current gear can deliver. Held at full throttle, a drift holds about 51° in 2nd and 44° in 3rd but bogs to 33° in 5th.

**Drifting:** pull the handbrake while turning (or throw the car into a slide) to start a drift. Once sliding:
- **The angle bends the line.** A sliding car carves round harder the further its rear hangs out (up to about 85°/s at 40° of slip, at any speed), scrubbing a little speed.
- **Throttle sets the angle and swings the car round.** At half steer, half throttle holds about 30° and carves about 60°/s; full throttle holds about 45° and carves nearly 100°/s. Lifting off lets the car straighten and grip up. Tapping the key feathers it.
- **Handbrake adds angle and rotation** and scrubs speed; tap it to feather. The angle is capped at 75°. The pull that starts a drift adds none of this for its first 0.3 s, so it doesn't also over-rotate the car.
- **Steering** turns the car and adds angle; countersteer catches the slide. You need some steering, either way, to hold an angle: with the wheel centred the car straightens out even at full throttle.

**Scoring:** drifting earns points for speed × slip angle. The multiplier rises every 2 s you hold a drift. A drift chain banks 1.2 s after it ends. Hitting a wall hard during the chain loses it.

## How it works

```
src/
  main.ts            boot, API key, deep links, menu wiring
  game.ts            phases (locating → driving ⇄ paused), fly-in spawn, fixed-step loop, rebasing
  camera.ts          top-down chase camera
  config.ts          every tunable number
  car/physics.ts     kinematic arcade drift model, ground following, wall response
  car/drivetrain.ts  torque curve, gearbox (auto/manual), clutch, rev limiter, engine braking
  car/carModel.ts    procedural low-poly car, x-ray silhouette, blob shadow
  car/effects.ts     skid-mark ribbons and tyre smoke
  world/tilesWorld.ts    Google 3D Tiles via 3d-tiles-renderer
  world/practiceWorld.ts offline test track
  world/collider.ts      BVH raycasts (three-mesh-bvh) against nearby tile meshes
  debug/trace.ts         always-on ring buffer of physics steps and events
  debug/overlay.ts       collision wireframe, probe rays, contact history
  debug/panel.ts, tools.ts  the F3 panel and the window.__drift.debug API
tools/
  capture.mjs        headless (GPU) run → trace, screenshots, console, perf trace
  trace-report.mjs   summarises a trace: wall/edge episodes, stops, repro links
```

- **Rendering.** It uses three.js with `3d-tiles-renderer`. The Maps JavaScript `gmp-map-3d` element was ruled out because it has no per-frame camera control, no ground-height queries and no collision.
- **World frame.** The tiles are re-oriented so the world is a local tangent plane: +X east, +Y up, −Z north.
  - When the car gets more than 1.5 km from the origin, the frame re-centres on the car (a floating origin). The car, camera and effects all move with it.
  - Y is height above the WGS84 ellipsoid, not above sea level.
- **Ground following.**
  - Four corner rays cast down from just above each wheel's last ground height. Tree canopy and overpasses more than 0.6 m above the road are ignored.
  - A rise of more than 0.45 m between steps counts as a ledge or wall.
  - One corner that sits far from the plane of the other three (a parked car, a bollard) is rejected.
  - A spring-damper suspension that can only push lets the car crest, jump and land.
  - If no tile geometry is loaded under the car, physics pauses until it arrives.
- **Things you can drive through.** Two shape tests run on a wall hit, judged from the mesh's shape because the tiles carry no labels:
  - **Car-sized lumps on flat road** are driven through. These are parked cars baked into the mesh and moving cars smeared into translucent "ghosts". A lump qualifies when it is at most 2.2 m tall and has a top near where the probe hit it. A level ray just above roof height must pass clear over it, and the surface must be back at road level within 7 m ahead and 4 m to each side. Buses, long barriers, kerb walls and facades all fail one of these.
  - **Overpass and skyway curtains** (the mesh drapes them down to the road) are recognised by a deck 3.5–9 m up that ends within about 40 m. Skyways can be up to 14 m tall, but only if they end within 9 m.
- **Detail around the car.** A `LoadRegionPlugin` sphere just ahead of the car keeps the finest level of detail loaded there.
- **Collision speed.** BVHs are built lazily, closest meshes first, so each ray only tests a few nearby meshes.

### Camera distance

Google's public tiles stop at a leaf `geometricError` of about 2 m. City textures come out at roughly 10–30 cm per texel. At a 40° field of view, the camera rests 65 m from the car, which is about the closest distance before texels are visibly magnified. At 40 m the image turns noticeably to mush.

The camera pulls back with speed, up to 140 m. The scroll wheel scales the distance between 0.6× and 2.5×. The pitch is 34° below the horizon by default, looking well ahead. **C** steps through 46°, 58°, 70° and 82° (nearly straight down), then wraps.

## Debugging collisions

### Debug panel (F3, or **Debug tools** in the menu)

- **Wireframe** draws the collision meshes around the car, coloured by height relative to the car's ground. The bands match the physics thresholds: blue is a drop, green is car level, yellow is a ledge at bumper height (the wall rays fire at 0.7 m), red is a wall, and magenta is the 3.5–9 m band the overpass test looks for decks in.
- **Fill** cycles off → **height** (with 1 m contour lines) → **slope** (green is drivable, yellow too steep to drive, red counts as a wall).
- **Photo** turns the photorealistic textures off, leaving only the overlay.
- **Probes** shows, for the last physics step:
  - the four ground probes (green ground, red ledge, grey miss, blue drop);
  - the five wall rays, coloured by verdict, with a tick where the car outline ends and the hit normal;
  - the car footprint.
- **Contacts** leaves a marker wherever the car hit a wall (red) or stopped at an edge (orange ledge, blue drop).
- **Classifier** shows the overpass and car-blob tests' samples along recent wall hits: skirt samples in yellow, far-side samples in cyan, the deck start as a white cross, and magenta, teal or red for overpass, car blob or wall.
- **Time** runs physics at 1×, ¼× or ⅒×, or freezes it. **Step** advances one 1/120 s step.
- The legend in the panel lists every colour.

### Traces

The game always records the last 60 s of physics steps:
- position, velocity, heading and input;
- ground probe states, edge stops, and the wall the solver pushed against (with its hit point, normal and tile error).

It also records events:
- every overpass decision, with its samples;
- spawns, resets and rebases;
- console warnings and errors;
- 2 Hz performance and tile samples, including the car's lat/lon.

Recording is always on, so you can save a trace after something odd happens:
- **F9** saves it. Under `pnpm dev` the dev server writes it to `traces/` (gitignored) and copies the path to the clipboard. Elsewhere the browser downloads it.
- **F8** drops a marker, such as "the wall was here", before you save.
- API keys and session tokens are stripped from everything recorded, and the dev server scrubs again on write.

```sh
pnpm trace:report traces/drift-20261021-142233.json            # summary
pnpm trace:report traces/drift-….json --window -6:-3           # per-step frames, 6–3 s before the save
```

The report lists each wall or edge episode with:
- the speed before and after, with STOP flagged when the car lost over half its speed;
- which ray hit what, how high above the ground, the normal and the incidence angle;
- the overpass classifier's verdict for that spot;
- a **repro link** that respawns 2 s earlier, with the same heading, height and speed.

### Headless capture

```sh
pnpm capture "/?practice" --drive "W:3,W+A:1.5,W+Space:0.4,W+A:2" --debug wire,probes,history
pnpm capture "/?lat=44.97889&lon=-93.24472&bearing=14&top=1" --drive "W:16" --shots 4 --perf
```

This runs headless Chrome with GPU flags (ANGLE/D3D11), starting a dev server if none is running.
- It drives with the given keys and saves the trace, a screenshot and the page console. `--shots` adds periodic screenshots and `--perf` adds a Chrome performance trace.
- It then prints the report.
- `--setup "g.physics.reset(...)"` runs code in the page first; `g` is `window.__drift`.
- In the console, `__drift.debug` exposes `exportTrace()`, `save()`, `mark()`, `set({ wire: true })`, `setTimeScale()`, `stepOnce()` and `reproLink()`.
- Every real-tile capture is one billable root tileset load.

### Google Maps Platform terms

- The Google Maps logo and the data attribution line (sorted by frequency, from the tiles' `copyright` fields) are shown whenever tiles are on screen.
- Tiles are only held in memory. There is no IndexedDB or service-worker caching and no prefetching outside the normal level-of-detail loading.
- Collision uses the meshes currently loaded for display; nothing derived from them is stored.
