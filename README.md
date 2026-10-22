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

- **Map Tiles API** (required). Billing counts one request per root tileset load, which is roughly one per location you start. The free tier is 1,000 per month. The minimap uses the same API's 2D roadmap tiles, billed separately per tile (100,000 free per month); it loads a few dozen per minute of driving.
- **Places API (New)** (optional). Only the place search box uses it.

The key ships to the browser, so restrict it by HTTP referrer, for example `http://localhost:5173/*` plus your production origin. If `.env` has no key, the menu asks for one and stores it in `localStorage`.

`?practice` runs an offline test track that needs no key.

### Deep links

`/?lat=44.97889&lon=-93.24472&bearing=14&top=1` starts at that spot.
- `bearing` is a compass heading.
- `top=1` spawns on the highest surface, such as a bridge deck. Without it, the game looks for the lowest flat ground nearby so you don't start on a roof.
- `h=218.3` spawns on the surface closest to that height (metres above the WGS84 ellipsoid). `mph=55` (or `kmh=90`) starts already moving. Repro links from the debug tools use both.
- `debug` opens the debug panel; `debug=wire,probes,history` also picks the overlay layers (see below).

## Controls

| | Keyboard | Gamepad |
|---|---|---|
| Throttle | W / ↑ | RT |
| Brake / reverse | S / ↓ | LT |
| Steer | A D / ← → | Left stick |
| Handbrake (drift) | Space | A |
| Shift down / up (switches to manual) | Q / E | LB / RB |
| Automatic / manual | T, or click AUTO/MANUAL | View |
| Reset to a recent spot | R | Y |
| Camera tilt preset | C | D-pad ← / → |
| Look around (eases back when let go) | | Right stick |
| Zoom | Mouse wheel, + / − | D-pad ↑ / ↓ |
| Menu / pause | Esc | Menu |
| Mute | M | |
| Debug panel | F3 or ` | |
| Mark the debug trace | F8 | |
| Save the debug trace | F9 | |

Any controller the browser gives the standard mapping works (Xbox, PlayStation, Switch Pro and most others in Chrome, Edge and Firefox); press a button so the browser reveals it. In the menu, the D-pad or left stick moves between buttons, A selects and B goes back (or resumes). The on-screen hints switch to the controller once you use it.

**Minimap:** a heading-up road map sits in the bottom left (top left on touch screens), zooming out with speed. It doesn't appear on the practice track.

**Seeing through cover:** when something hides the car from the camera (an overpass deck, a tunnel, a building), it shows through as a translucent, rim-lit ghost.

On touch devices an on-screen steering pad and GAS, BRAKE and DRIFT buttons appear. Tap AUTO/MANUAL on the gear selector to switch; in manual, ▼▲ buttons appear under it.

**Gearbox:** the engine makes 470 N·m at 4,500–5,000 rpm and holds about 395 hp from 7,500 rpm to its 8,500 rpm redline, with a limiter at 8,800. The six-speed box runs out at 54, 75, 96, 116, 135 and 153 mph; top speed is about 115 mph, limited by drag. 0–60 mph takes 4.2 s; traction control keeps a straight-line launch from just spinning the rear tyres, and switches itself off as soon as you steer.
- **Automatic** is the default. It shifts later the harder you press, judging by road speed rather than the spinning rear wheels, and holds its gear while sliding so feathering the throttle doesn't short-shift it.
- **Manual:** pressing Q or E switches to manual. Each shift cuts drive for 0.14 s. Downshifts are never refused: one that would over-rev holds the engine on the limiter with no drive and, off the throttle, engine braking drags at the rear wheels until the speed comes down. In 1st the car sits on the limiter early. The tach rim glows yellow near redline and red on the limiter.
- **Engine braking** grows with rpm, so a lower gear slows the car harder.
- **The gear matters for drifting.** Wheelspin is what keeps the rear sliding, and a high gear can't deliver it. Held at full throttle with a little steering into the slide, a drift holds about 49° in 2nd, 34° in 3rd and 18° in 4th, and straightens in 5th.

**Drifting** isn't a mode. The car is a rigid body on two tyres (front and rear axles) with real slip: tyre force rises with slip to a peak and then falls away as the tyre slides. The front and rear tyres share one grip budget between braking or drive and cornering. Front–rear load shifts as the car brakes and accelerates. The rear wheels spin up against the engine's inertia through the gear ratio. The game calls it a drift whenever the car's slip angle passes 12°, which is what scoring, smoke and the camera react to. Ways to start one:
- **Power over:** in 1st–3rd, steer in and floor it. The rear tyres spin, lose their sideways grip and step out.
- **Handbrake:** locks the rear wheels (and dips the clutch, so the engine revs), so they slide instead of gripping. Pull it while turning; tap it to feather.
- **Lift-off or trail braking:** lifting or braking moves weight onto the front, so a car turning near the limit gets a little loose.

Once sliding:
- **Throttle sets the angle.** More wheelspin means less rear grip and more angle; lifting lets the rear grip and the car straightens. Tapping the key feathers it.
- **Steering is relative to where the car is going.** The front wheels follow the direction of travel by themselves, the way a car's caster pulls them, so a slide countersteers itself. Steering into the slide pulls the nose in and adds angle; steering out takes angle off, or flicks the car into a slide the other way. With the wheel centred and the throttle eased, it straightens up.
- **The angle bends the line.** A sliding car's tyres turn its path, and big angles scrub speed.
- **Past about 55°** a stability assist pushes the car back toward the slide, so even full lock and full throttle peak around 75° instead of spinning.

**Sound** is synthesized as you drive:
- **Engine:** an inline six fired cylinder by cylinder in an AudioWorklet. Each firing is a combustion pulse sized by throttle, with slight differences between cylinders and from cycle to cycle, so it idles lumpily and wails smoothly at the top. The pulses go through exhaust resonances and soft saturation, with intake roar under load. The limiter stutters, a hard upshift pops, and lifting off from high revs crackles on the overrun.
- **Transmission:** gear whine at the gear-mesh frequency, which changes with each gear (reverse whines loudest), differential whine with road speed, and a clunk on each shift.
- **Tyres and road:** front and rear squeal, pitched by how fast each axle slides (a standing burnout squeals too), a rasp from wheelspin, rolling noise and wind with speed, and a thud on landing.

Browsers only start audio after a key press or click; a gamepad button doesn't count.

**Scoring:** drifting earns points for speed × slip angle. The multiplier rises every 2 s you hold a drift. A drift chain banks 1.2 s after it ends. Hitting a wall hard during the chain loses it.

## How it works

```
src/
  main.ts            boot, API key, deep links, menu wiring
  audio.ts           synthesized engine (AudioWorklet), transmission, tyres, road and wind
  game.ts            phases (locating → driving ⇄ paused), fly-in spawn, fixed-step loop, rebasing
  camera.ts          top-down chase camera
  input.ts           keyboard, gamepad (with menu navigation) and touch
  minimap.ts         heading-up 2D roadmap in the corner
  config.ts          every tunable number
  car/physics.ts     tyre-force chassis (slip, load transfer, wheelspin), ground following, wall response
  car/drivetrain.ts  torque curve, gearbox (auto/manual), clutch, rev limiter, engine braking
  car/carModel.ts    procedural low-poly car, see-through ghost, blob shadow
  car/effects.ts     skid-mark ribbons and tyre smoke
  world/tilesWorld.ts    Google 3D Tiles via 3d-tiles-renderer
  world/practiceWorld.ts offline test track
  world/collider.ts      BVH raycasts (three-mesh-bvh) against nearby tile meshes
  world/mapTiles.ts      2D map tile sessions and Web Mercator, for the minimap
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
  - **Wide underpasses and tunnel portals** are too deep for that test. With no road under the cover, it must be at most 14 m up at the face and at least 5 m up 4–20 m in, which parking decks aren't. It also mustn't rise more than 3 m from the face to 4–20 m in: a tunnel's lid runs on at about the portal's height (within 1 m at Lowry Hill and Lyndale), but behind a building's overhang the cover jumps to the roof, and the hollow shell has nothing inside to hit. The face must also lean toward the car. Level rays at 1.5, 3 and 4.5 m must meet it at least 0.6 m nearer at the top, with downward-facing normals. Deck edges and portals lean that way; facades are vertical. The mesh has floors under some buildings but not others, so road under a cover proves nothing by itself. Where the road is reconstructed under the cover (stacked freeway decks), it must run on for 60 m or come out. The cover must also look like a deck: flat (within 1.5 m) at 5–14 m up, a slab with its underside in the mesh, or a leaning face. Where there's none, as in tunnels and covered roadways that photogrammetry can't see into, tunnel mode starts. Measured on the Lowry Hill tunnel, Glenwood Ave under I-94 and Lyndale Ave under I-394, against one-storey shops, parking ramps and a downtown building.
  - **Inside a tunnel** the car runs on a virtual road. It starts at the road's grade over the last 8–16 m before the portal (not the ground under the car, which can tilt several percent cresting a bump) and keeps its clearance under the cover. For the first 20 m, faces count as the entry curtain if the cover beyond them is at about the portal's clearance. Every 8 m a scan looks up to 220 m ahead for the exit road (walkable, near road height, open above), and the road ramps to meet it, at most 8%. While under the cover, a face ahead counts as the exit curtain if the road resumes within 20 m behind it. Tunnel mode ends once there's nothing overhead, on real ground or the virtual road. There are no side walls in the mesh, so nothing stops a car steering off the tunnel's line.
- **Detail around the car.** A `LoadRegionPlugin` sphere just ahead of the car keeps the finest level of detail loaded there.
- **Collision speed.** BVHs are built lazily, closest meshes first, so each ray only tests a few nearby meshes.
- **Seeing through cover.** The car's ghost is a second copy of it, drawn only where it fails the depth test (something is in front) and only once per pixel. Each pixel goes to the first ghost part drawn there: cabin, roof and stripes first, then the shell (the tyres have none: they dip into the road and would glint through it). The car itself draws after the world and marks its visible pixels in the stencil buffer, so the ghost never shows over the car.

### Camera distance

Google's public tiles stop at a leaf `geometricError` of about 2 m. City textures come out at roughly 10–30 cm per texel. At a 40° field of view, the camera rests 65 m from the car, which is about the closest distance before texels are visibly magnified. At 40 m the image turns noticeably to mush.

The camera pulls back with speed, up to 140 m. The scroll wheel scales the distance between 0.6× and 2.5×. The pitch is 34° below the horizon by default, looking well ahead. **C** (or D-pad →) steps through 46°, 58°, 70° and 82° (nearly straight down), then wraps; D-pad ← steps back. On a controller the right stick swings the camera around the car and tilts it (stick up looks toward the horizon); 1.5 s after you let go it eases back behind the car.

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
- **Tyres** draws each axle's tyre force (1 m per kN; green while gripping, orange while sliding), the front wheels' heading (cyan) and the car's velocity (white). The stats under the buttons give the slip angles, axle loads, rear wheel speed and road-wheel angle.
- **Time** runs physics at 1×, ¼× or ⅒×, or freezes it. **Step** advances one 1/120 s step.
- The legend in the panel lists every colour.

### Traces

The game always records the last 60 s of physics steps:
- position, velocity, heading and input;
- engine rpm and gear, rear wheel speed, road-wheel angle, slip angles and yaw rate;
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

### Handling

```sh
pnpm handling                  # every scenario
pnpm handling drift --timeline # matching scenarios, with slip°/yaw°/km/h every 0.25 s
```

This runs the car physics on a flat plane through scripted inputs (grip, braking, launch, power-over and handbrake drifts, held drifts in each gear, reversing) and prints the slip angle held, yaw rate, speed, path turned and time spent drifting. No browser or tiles are needed, so run it after changing any tuning in `src/config.ts`.

### Google Maps Platform terms

- The Google Maps logo and the data attribution line (sorted by frequency, from the tiles' `copyright` fields) are shown whenever tiles are on screen. The minimap shows the map data copyright for its area, from the Map Tiles viewport API.
- Tiles are only held in memory. There is no IndexedDB or service-worker caching and no prefetching outside the normal level-of-detail loading.
- Collision uses the meshes currently loaded for display; nothing derived from them is stored.
