# drift.earth

An arcade drifting game played on Google's Photorealistic 3D Tiles. The camera looks down from slightly behind the car, about as close as the tile data's resolution allows.

The default start is a street in downtown Minneapolis. Press **Esc** for the menu, where you can pick another city, search any place, or paste coordinates or a Google Maps link.

## Running it

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # type-check + production build into dist/
```

Code edits hot-update without reloading the page: the new code takes over the loaded world, so the tiles aren't fetched (or billed) again, and the car, camera, menu, minimap, debug panel and unsaved tuning carry on where they were. Edits to the world's own code (`tilesWorld.ts`, `practiceWorld.ts`, `meshBounds.ts`, `hot.ts`) still reload the page, and `TILES` numbers in `config.ts` apply from the next place loaded.

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

### Deploying to GitHub Pages

CI (`.github/workflows/ci.yml`) type-checks, runs `pnpm handling` and builds on every push and pull request. Pushes to the default branch (`main`) also deploy to GitHub Pages.

1. Push the repository to GitHub, with `main` as its default branch.
2. In the repository, open **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Optionally add an Actions secret `MAPS_API_KEY`: a key restricted by HTTP referrer to the Pages origin (`https://<you>.github.io/*`). Deploys build it in, so visitors can drive without a key of their own. Without it, the site asks visitors for theirs. Anyone can read a key in a public site's JavaScript, and the referrer restriction only stops other web pages using it, so also cap the Map Tiles API's daily quota in Cloud Console.

The site appears at `https://<you>.github.io/<repo>/`; `BASE_PATH` sets the path the build is served from (CI takes it from the Pages settings, and it is `/` by default).

Link previews (Open Graph and Twitter cards in `index.html`) show `public/og.jpg`, a 1200×630 shot of the hot hatch drifting on the practice track. Scrapers need absolute URLs, so the build fills in the site's address from `SITE_URL`, which CI sets from the Pages settings.

`pnpm check:key` fails if `dist/` contains any API key other than the one it is told to expect (`ALLOWED_KEY`, which CI sets to the secret), and never prints a key. A local `pnpm build` builds in the key from `.env`, so don't publish a local `dist/` by hand. To build without it, run `MAPS_API_KEY= VITE_GOOGLE_MAPS_KEY= pnpm build`, or in PowerShell 7 `$env:MAPS_API_KEY=''; $env:VITE_GOOGLE_MAPS_KEY=''; pnpm build` (Windows PowerShell 5.1 deletes a variable set to `''`, so `.env` would win; `pnpm check:key` catches that).

### Deep links

`/?lat=44.97889&lon=-93.24472&bearing=14&top=1` starts at that spot.
- `bearing` is a compass heading.
- `top=1` spawns on the highest surface, such as a bridge deck. Without it, the game looks for the lowest flat ground nearby so you don't start on a roof.
- `h=218.3` spawns on the surface closest to that height (metres above the WGS84 ellipsoid). `mph=55` (or `kmh=90`) starts already moving. Repro links from the debug tools use both.
- `debug` opens the debug panel; `debug=wire,probes,history` also picks the overlay layers (`wire`, `height` or `slope`, `nophoto`, `probes`, `history`, `overpass`, `tires`, `trail`, `gauges`; see below).
- `car=muscle` (or `car=hatch`) drives that car without changing the one picked in the menu.

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
| Put the car on the nearest road | Hold R | Hold Y |
| Camera tilt preset | C (wraps round) | D-pad ← / → (stops at either end) |
| Look around (eases back when let go) | Drag with the mouse | Right stick |
| Ease back on or off | | R3 |
| Zoom | Mouse wheel, + / − | D-pad ↑ / ↓ |
| Menu / pause | Esc | Menu |
| Mute | M | |
| Debug panel | F3 or ` | |
| Mark the debug trace | F8 | |
| Save the debug trace | F9 | |

Any controller the browser gives the standard mapping works (Xbox, PlayStation, Switch Pro and most others in Chrome, Edge and Firefox); press a button so the browser reveals it. In the menu, the D-pad or left stick moves between buttons, A selects and B goes back (or resumes). The on-screen hints switch to the controller once you use it.

**Minimap:** a heading-up road map sits in the bottom left (top left on touch screens), zooming out with speed. It doesn't appear on the practice track.

**Back to the road:** stuck in a building or lost in a car park? Hold reset (R, Y or ⟲) for half a second: where a tap goes back to a recent spot, a hold puts the car on the nearest real road, facing along it in the direction closest to where you were heading. The pause menu has the same as **Back to road**. Roads come from OpenStreetMap (below); the spot is checked against the 3D mesh first (flat ground under all four wheels, nothing parked there or under it, not a roof over the road, no wall), sliding along the street or trying the next road if it isn't clear.

**Seeing through cover:** when something hides the car from the camera (an overpass deck, a tunnel, a building), it shows through as a translucent, rim-lit ghost.

On touch devices an on-screen steering pad and GAS, BRAKE and DRIFT buttons appear. Tap AUTO/MANUAL on the gear selector to switch; in manual, ▼▲ buttons appear under it.

The brake key and the touch BRAKE button are on/off, so the brake builds to full over 0.4 s instead of stamping on it: tap to brake lightly. A trigger brakes as far as it's pressed.

### Cars

Pick a car in the menu (it's remembered). Both have six-speed boxes and the same controls. Their numbers are in `src/car/cars.ts`, and the debug panel's **Tuning** tab edits them live (see below).

| | Hot hatch (default) | Muscle car |
|---|---|---|
| Layout | front engine, front-wheel drive, 60% of the weight on the front | front engine, rear-wheel drive |
| Engine | 2.3 L turbo four: 420 N·m from 3,000–4,000 rpm on boost, about 300 hp at 6,800 rpm and still 280 at the 8,500 rpm redline | V8: 470 N·m at 4,500–5,000 rpm, about 395 hp at the 7,250 rpm redline |
| Mass | 1,430 kg | 1,250 kg |
| Gears run out at | 47, 85, 129, 169, 213, 253 mph | 46, 64, 82, 99, 115, 131 mph |
| Top speed (drag) | about 154 mph | about 115 mph |
| 0–60 mph | 5.7 s | 4.8 s (spinning the rear tires) |

- **Hot hatch:** after a Focus ST. The turbo builds boost with a little lag, faster high in the rev range, and vents it the moment you lift. It grips hard and understeers on the power: wheelspin and drive both use the front tires' grip. Traction control holds the front wheels near peak slip while the wheel is centred. Stability control lets the rear reach 15° before it steps in, more gently than the muscle car's.
- **Muscle car:** no traction control. Floored in 1st it does a rolling burnout; in 2nd it hooks up in a straight line and lets go with moderate steering, so a blip of the handbrake is the easy way in.

**Gearbox:**
- **Automatic** is the default. It shifts later the harder you press, judging by road speed rather than the spinning wheels, and holds its gear while sliding or on the handbrake, so feathering the throttle doesn't short-shift it.
- **Manual:** pressing Q or E switches to manual. Each shift cuts drive for about 0.15 s. Downshifts are never refused: one that would over-rev holds the engine on the limiter with no drive and, off the throttle, engine braking drags at the driven wheels until the speed comes down. In 1st the car sits on the limiter early. The tach rim glows yellow near redline and red on the limiter.
- **The clutch** slips while pulling away in 1st or reverse; in a higher gear it stays in until the engine would drop below idle.
- **Engine braking** grows with rpm, so a lower gear slows the car harder.

**Drifting** isn't a mode. The car is a rigid body on two tires (front and rear axles) with real slip: tire force rises with slip to a peak and then falls away as the tire slides. Each axle's tires share one grip budget between braking or drive and cornering. Front–rear load shifts as the car brakes and accelerates. The driven wheels spin up against the engine's inertia through the gear ratio; the others roll free, or lock under the handbrake. The game calls it a drift whenever the car's slip angle passes 12°, which is what scoring, smoke and the camera react to. Ways to start one:
- **Handbrake:** locks the rear wheels so they slide instead of gripping. Pull it while turning; tap it to feather. On the muscle car it also dips the clutch, so the engine revs; the hot hatch stays on the power, since its front wheels drive.
- **Power over (muscle car):** in 1st–3rd, steer in and floor it. The rear tires spin, lose their sideways grip and step out.
- **Lift-off or trail braking:** lifting or braking moves weight onto the front, so a car turning near the limit gets loose. The front-heavy hatch does this readily: lift mid-corner and the rear comes round 10–15°.

Once sliding:
- **Throttle sets the angle.** In the muscle car, more wheelspin means less rear grip and more angle; lifting lets the rear grip and the car straightens. In the hatch it's the other way round: the driven fronts pull the car straight, so stay off the power or feather it to hold the slide, and floor it to come out. Tapping the key feathers it.
- **Gear matters in the muscle car.** Wheelspin is what keeps the rear sliding, and a high gear can't deliver it. Held at full throttle with a little steering into the slide, a drift holds about 42° in 2nd, 34° in 3rd and 18° in 4th, and straightens in 5th.
- **Steering is relative to where the car is going.** The front wheels follow the direction of travel by themselves, the way a car's caster pulls them, so a slide countersteers itself. Steering into the slide pulls the nose in and adds angle; steering out takes angle off, or flicks the car into a slide the other way. With the wheel centred and the throttle eased, it straightens up.
- **The angle bends the line.** A sliding car's tires turn its path, and big angles scrub speed.
- **Over-rotate and it spins.** Nothing pushes the car back from a big angle. Full lock and full throttle out of a handbrake turn can spin the muscle car, and holding the handbrake too long at full lock can spin either; countersteer and ease off to catch it.

**Sound** is synthesized as you drive:
- **Engine:** fired cylinder by cylinder in an AudioWorklet. Each firing is a combustion pulse sized by throttle, with slight differences between cylinders and from cycle to cycle, into exhaust pipes that each have their own resonance (a tuned delay loop), a muffle that opens with load and light saturation. The limiter stutters, a hard upshift pops, and lifting off from high revs crackles on the overrun.
  - **Muscle car:** a cross-plane V8 with true dual exhausts. Each bank fires at uneven intervals (270°, 180°, 90°, 180°) into its own pipe, which gives the burble and keeps a low body even at 7,000 rpm. Intake roar comes in under load.
  - **Hot hatch:** a turbo four firing evenly every 180° into a single exhaust, with a gruff induction growl under load. A turbo whistle rises with boost, the blow-off valve sighs when you lift at boost, and it pops more eagerly on the overrun.
- **Transmission:** gear whine at the gear-mesh frequency, which changes with each gear (reverse whines loudest), differential whine with road speed, and a clunk on each shift.
- **Tires and road:** front and rear squeal, pitched by how fast each axle slides (a standing burnout squeals too), a rasp from wheelspin, rolling noise and wind with speed, and a thud on landing.

Browsers only start audio after a key press or click; a gamepad button doesn't count.

**Scoring:** drifting earns points for speed × slip angle. The multiplier rises every 2 s you hold a drift. A drift chain banks 1.2 s after it ends. Hitting a wall hard during the chain loses it.

### Surfaces

Each wheel knows what it's on, and the tires change with it. Every surface scales the car's own grip and drag, so each car keeps its character; asphalt leaves it exactly as tuned. The numbers are in `src/car/surfaces.ts`.

| | Grip | What it does |
|---|---|---|
| Asphalt | 1× | The reference. |
| Cobbles | 0.85× | A little less grip, and a constant shake through the body. |
| Gravel | 0.63× | Grip peaks later and falls off less past the peak, so slides are slower to start, long and forgiving. Braking takes about 1.45× as far and getting to 62 mph (100 km/h) about 1.6× as long. Bumpy. |
| Grass | 0.39× | Braking takes twice as far, and the soft ground holds the speed down (about half asphalt's after 20 s flat out). Flat past the peak, like gravel. Bumpier. |
| Sand | 0.6× | Soft: off the throttle the car stops in about 4 s from 50 mph, and on it the car crawls (9–13 mph). |
| Water | 0.25× | Next to no grip and heavy wading drag: enough to crawl out at walking pace. |

- When a wheel crosses onto another surface, its axle eases over to it in about 0.1 s, so the boundary doesn't jolt. Traction control, ABS and stability control work to the grip under them.
- With one side on soft ground, that side drags and slews the car toward it: a little on gravel, hard in sand or water. Running two wheels wide onto the verge takes a correction.
- A slide counts as a drift (for scoring, smoke and the camera) at the same angle on every surface, so drifting on gravel scores as it does on asphalt.
- Rough surfaces shake the body with position-fixed bumps of a few centimetres, the same each time you pass. The shake is drawn as it is (not eased like the rest of the body's pitch and roll) and moves the ride height, but not the ground plane the physics leans on. Bumps coming faster than 20 a second fade, as the tires and springs soak them up.
- On the practice track, the east–west street the car starts on (z = 31) carries on east out of the city as a gravel road, to a gravel oval with an asphalt infield. Around it are a cobbled straight, a sand pit, a grass field and a pond. On real tiles everything is asphalt for now.
- The debug panel shows the surface under each wheel (front-left/right, rear-left/right) and each axle's grip; traces record it too.
- `pnpm handling --surface gravel` runs every scenario on gravel; `pnpm handling --surfaces` compares all of them (see **Handling** below).

## How it works

```
src/
  main.ts            boot, API key, deep links, menu wiring, hot updates
  hot.ts             dev only: clears the page between hot updates
  audio.ts           synthesized engine (AudioWorklet), transmission, tires, road and wind
  game.ts            phases (locating → driving ⇄ paused), fly-in spawn, fixed-step loop, rebasing
  camera.ts          top-down chase camera
  input.ts           keyboard, gamepad (with menu navigation) and touch
  minimap.ts         heading-up 2D roadmap in the corner
  config.ts          world, ground, camera and scoring numbers
  car/cars.ts        the cars: chassis, tires, steering, brakes, stability, drivetrain
  car/presets.ts     tuning presets: format, validation, storage
  car/physics.ts     tire-force chassis (slip, load transfer, wheelspin; front or rear drive), ground following, wall response
  car/surfaces.ts    what asphalt, cobbles, gravel, grass, sand and water do to the tires
  car/drivetrain.ts  torque curve, turbo, gearbox (auto/manual), clutch, rev limiter, engine braking
  car/carModel.ts    procedural low-poly cars (the muscle car's body), see-through ghost, blob shadow
  car/hatchBody.ts   the hot hatch's body and wheels
  car/effects.ts     skid-mark ribbons and tire smoke
  world/tilesWorld.ts    Google 3D Tiles via 3d-tiles-renderer
  world/practiceWorld.ts offline test track
  world/collider.ts      BVH raycasts (three-mesh-bvh) against nearby tile meshes
  world/mapTiles.ts      2D map tile sessions and Web Mercator, for the minimap
  world/osmRoads.ts      OpenStreetMap vector tiles (OpenFreeMap): loading, decoding, projection
  world/roads.ts         road centrelines in a spatial hash: nearest road, walking along one
  world/roadSnap.ts      picks a clear spot on the nearest road for "back to road"
  debug/trace.ts         always-on ring buffer of physics steps and events
  debug/overlay.ts       collision wireframe, probe rays, contact history, tire and trail layers, roads
  debug/panel.ts, tools.ts  the F3 panel and the window.__drift.debug API
  debug/tuning.ts        the panel's Tuning tab: live car numbers and presets
  debug/tuningPlots.ts   the Tuning tab's tire, gearing and steering plots
  debug/gauges.ts        live gauges over the game view, and the driver-aid switches
  debug/scope.ts         the panel's Scope tab: telemetry strip charts, ghosts, handling diagram
  debug/manoeuvres.ts    the Scope tab's scripted test manoeuvres
tools/
  capture.mjs        headless (GPU) run → trace, screenshots, console, perf trace
  trace-report.mjs   summarises a trace: wall/edge episodes, stops, repro links
  roads.mjs          road data at every preset spot, and the spot search on a synthetic street
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
  - **Vehicle-sized lumps on the road** are driven through. These are parked cars, vans and small trucks baked into the mesh, and moving cars smeared into translucent "ghosts". A lump qualifies when it is at most 3 m tall and has a top near where the probe hit it. A ray just above roof height, along the road's slope, must pass clear over it. The surface must be back at road level within 10 m ahead and 4 m to each side. Heights are measured from the plane of the road the car is on, so on a hill the road beyond a lump still counts as road. A car's length in, one road sample ends a lump, so each car in a bumper-to-bumper row counts on its own. Buses, long barriers, kerb walls, planters and facades all fail one of these.
  - **Overpass and skyway curtains** (the mesh drapes them down to the road) are recognised by a deck 3.5–9 m up that ends within about 40 m. Skyways can be up to 14 m tall, but only if they end within 9 m.
  - **Wide underpasses and tunnel portals** are too deep for that test. With no road under the cover, it must be at most 14 m up at the face and at least 5 m up 4–20 m in, which parking decks aren't. It also mustn't rise more than 3 m from the face to 4–20 m in: a tunnel's lid runs on at about the portal's height (within 1 m at Lowry Hill and Lyndale), but behind a building's overhang the cover jumps to the roof, and the hollow shell has nothing inside to hit. The face must also lean toward the car. Level rays at 1.5, 3 and 4.5 m must meet it at least 0.6 m nearer at the top, with downward-facing normals. Deck edges and portals lean that way; facades are vertical. The mesh has floors under some buildings but not others, so road under a cover proves nothing by itself. Where the road is reconstructed under the cover (stacked freeway decks), it must run on for 60 m or come out. The cover must also look like a deck: flat (within 1.5 m) at 5–14 m up, a slab with its underside in the mesh, or a leaning face. Where there's none, as in tunnels and covered roadways that photogrammetry can't see into, tunnel mode starts. Measured on the Lowry Hill tunnel, Glenwood Ave under I-94 and Lyndale Ave under I-394, against one-storey shops, parking ramps and a downtown building.
  - **Inside a tunnel** the car runs on a virtual road. It starts at the road's grade over the last 8–16 m before the portal (not the ground under the car, which can tilt several percent cresting a bump) and keeps its clearance under the cover. For the first 20 m, faces count as the entry curtain if the cover beyond them is at about the portal's clearance. Every 8 m a scan looks up to 220 m ahead for the exit road (walkable, near road height, open above), and the road ramps to meet it, at most 8%. While under the cover, a face ahead counts as the exit curtain if the road resumes within 20 m behind it. Tunnel mode ends once there's nothing overhead, on real ground or the virtual road. There are no side walls in the mesh, so nothing stops a car steering off the tunnel's line.
- **Detail around the car.** A `LoadRegionPlugin` sphere just ahead of the car keeps the finest level of detail loaded there.
- **Collision speed.** BVHs are built lazily, closest meshes first, so each ray only tests a few nearby meshes.
- **Seeing through cover.** The car's ghost is a second copy of it, drawn only where it fails the depth test (something is in front) and only once per pixel. Each pixel goes to the first ghost part drawn there: cabin, roof and stripes first, then the shell (the tires have none: they dip into the road and would glint through it). The car itself draws after the world and marks its visible pixels in the stencil buffer, so the ghost never shows over the car.

### Camera distance

Google's public tiles stop at a leaf `geometricError` of about 2 m. City textures come out at roughly 10–30 cm per texel. At a 40° field of view, the camera rests 65 m from the car, which is about the closest distance before texels are visibly magnified. At 40 m the image turns noticeably to mush.

The camera pulls back with speed, up to 140 m. The scroll wheel scales the distance between 0.6× and 2.5×. The pitch is 34° below the horizon by default, looking well ahead. **C** steps through 46°, 58°, 70° and 82° (nearly straight down), then wraps. On a controller, D-pad → and ← step up and down the same presets and stop at either end. The right stick swings the camera around the car and tilts it (stick up looks toward the horizon); 1.5 s after you let go it eases back behind the car. **R3** turns that easing back off (the view stays where you leave it) or on again; the choice is remembered.

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
- **Tires** draws each axle's tire force (1 m per kN; green while gripping, orange while sliding), the front wheels' heading (cyan) and the car's velocity (white). The stats under the buttons give the slip angles, axle loads, rear wheel speed and road-wheel angle. It also shows:
  - a slip wedge at each axle, from where the wheels point to where the contact patch is travelling: green well under the tire's peak slip angle, amber near it, red past it (the rear one is drawn behind the car, so the body doesn't hide it);
  - a load bar over each axle against its static load (white tick), showing weight transfer under braking and throttle;
  - the arc the car is on (radius = speed ÷ yaw rate), with its centre marked within 60 m;
  - a band round the centre of mass from the body's heading to its velocity, ticked every 10°: the drift angle.
- **Trail** draws the last 18 s of driving on the ground, each stretch coloured by the first of these that applied: airborne, stability control, ABS, traction control, both axles / rear / front sliding, drifting on gripping tires, or plain grip.
- **Gauges** puts a live telemetry cluster at the top right, which stays up with the panel closed:
  - friction circles for each axle: the grip ellipse from μ × load, the force now with a 1 s trail, and the share of grip in use;
  - a 10 s g-g diagram;
  - the steering input against the rate-limited command and the actual road-wheel angle over the last 2 s, and the raw pedals beside what the car took from them;
  - ABS, TC and ESC lamps, stability control's re-arm countdown and a drift light;
  - the drivetrain: gear, engine rpm against the driven wheels' rpm (the gap is clutch slip), boost, the limiter, drive force and wheelspin.

  **Click the ABS, TC or ESC lamp to switch that aid off** (or on again; `__drift.debug.setAssist('abs', false)` from the console). Off, ABS lets the wheels lock, traction control never cuts drive and stability control never corrects yaw. The preset's numbers stay as they are. The switches last until the page reloads, and traces record them.
- **Time** runs physics at 1×, ¼× or ⅒×, or freezes it. **Step** advances one 1/120 s step.
- The legend in the panel lists every colour.

### Tuning and presets (the panel's **Tuning** tab)

Every number of the car being driven, grouped (chassis, tires, steering, brakes, stability, engine, gearbox, turbo), with a slider and a number box each. Angles show in degrees and speeds in mph. The gears and the torque curve have their own editors (add or remove a gear or a curve point), and the curve plots torque and power. Changes take effect at once. ● marks values not yet saved; an amber label marks values changed from stock.

Three more plots sit at the top of their groups. They use the same formulas as the sim and redraw as you edit:
- **Tires:** cornering μ against slip angle, front and rear, with drive and braking μ against slip ratio beside it. The live dots are each axle's actual cornering force ÷ load, so a dot below the curve is grip spent on wheelspin or braking.
- **Gearbox:** the rpm sawtooth the auto box takes at full throttle (shift bands, redline, limiter, and where each upshift drops the revs). Below it is thrust per gear against rolling resistance and drag, marking the real top speed next to the Top speed (camera) field.
- **Steering:** the lock full input asks for against speed, under the wheel lock, with the road-wheel angle and the driver's part of it live.

- **Presets** belong to a car. Each car has a read-only **Stock** preset and any number of your own: **Save**, **Save as** (also duplicates), **Rename**, **Delete**, **Reset** (back to the last save) and **Stock** (the stock values). The active preset for each car is remembered and loaded when you drive it.
- **Export** downloads the preset (or all of them) as JSON; **Copy JSON** puts it on the clipboard. **Import** takes a file or pasted JSON. Imports are checked strictly: unknown fields are dropped, every number must be in a sane range, the gears must descend and the torque curve's rpm ascend, and missing fields take the stock values, so older presets keep loading.
- A save or export is refused while the numbers break a rule between fields, such as an idle above the redline.
- Typing in the panel doesn't drive the car. Enter applies a value and hands the keys back; Esc puts the old value back.
- Traces record the car's numbers and the preset's name, and log every edit.

Presets are stored in the browser (`localStorage`); export them to keep or share them.

### Telemetry (the panel's **Scope** tab)

- **Strip charts** of the last 5, 10 or 30 s of the trace. Pick a channel preset (Balance, Steering, Grip, Aids, Drivetrain, Pedals, Forces) or any channels. Values show in display units, with the peak slip angle, stability control's slip allowance and the redline drawn in. Hover to read every channel at that moment; with time frozen, hover to scrub.
- **Pin** keeps the window as a dashed ghost (up to five), to compare a change in the Tuning tab against the run before it.
- **Tests** drives scripted manoeuvres: step steer, sine with dwell, J-turn, 0–100 km/h, 100–0 and a ramp steer.
  - They are timed in physics steps, so slow motion and stepping still work.
  - On the practice track they start on open ground past the city blocks.
  - Any player input, a hit or Esc aborts one.
  - Each run is pinned and lined up on its start beside earlier runs, and its metrics go in a table and the trace.
  - The ramp steer also feeds the **Handling** view: road-wheel angle against lateral g, with the understeer gradient (°/g).
- From the console: `__drift.debug.scope.run('step-steer')` resolves to the run's metrics.

### Traces

The game always records the last 60 s of physics steps:
- position, velocity, heading and input;
- engine rpm and gear, rear wheel speed, road-wheel angle, slip angles and yaw rate;
- tire loads, forces and sliding, body acceleration, the smoothed pedals and steering, what ABS, traction and stability control did, boost, torque and drive force;
- ground probe states, edge stops, and the wall the solver pushed against (with its hit point, normal and tile error).

It also records events:
- every overpass decision, with its samples;
- spawns, resets, road teleports (with every spot tried and why it was turned down) and rebases;
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
- `--setup "g.physics.reset(...)"` runs code in the page first; `g` is `window.__drift`. `g.teleportToRoad()` puts the car on the nearest road and returns the search; `--debug roads` draws the road centrelines and the spots it tried.
- In the console, `__drift.debug` exposes `exportTrace()`, `save()`, `mark()`, `set({ wire: true })`, `setTimeScale()`, `stepOnce()`, `reproLink()`, `setAssist()`, `tuning` and `scope`.
- Every real-tile capture is one billable root tileset load.

### Handling

```sh
pnpm handling                  # every scenario, for the default car (the hot hatch)
pnpm handling --car muscle     # the muscle car
pnpm handling drift --timeline # matching scenarios, with slip°/yaw°/km/h every 0.25 s
pnpm handling --surface gravel # every scenario on gravel (or cobbles, grass, sand, water)
pnpm handling --surfaces       # every surface against asphalt
```

This runs the car physics on a flat plane through scripted inputs (grip, braking, launch, power-over and handbrake drifts, held drifts in each gear, reversing) and prints the slip angle held, yaw rate, speed, path turned, time spent drifting and the driven wheels' mean wheelspin. Scenarios for one layout (lift-off and handbrake tricks for front drive, burnouts and 2nd-gear breakaway for rear drive) only run for such a car, or for any with `--all`. No browser or tiles are needed, so run it after changing any tuning in `src/car/cars.ts` or `src/car/surfaces.ts`.

`--surfaces` prints one line per surface, each number also as a multiple of asphalt's: the tires' sideways grip at full lock from 60 km/h (in g), braking from 100 km/h to a stop, 0–100 km/h, the speed after 20 s flat out, coasting to a stop from 80 km/h, drift time, slip held and peak slip across the drift scenarios, how many of them spun, and how long a scripted driver keeps a handbrake drift going (steering against the angle, tapping the handbrake, and on the muscle car working the throttle).

### Roads

```sh
pnpm roads             # every preset spot
pnpm roads Shibuya     # matching spots
```

Road centrelines come from [OpenFreeMap](https://openfreemap.org)'s OpenStreetMap vector tiles (OpenMapTiles schema, zoom 14, no key), never from Google's tiles. The game loads the tile under the car and any neighbour within 300 m, keeps the 9 most recent, and drops footways, cycle paths, rail, ferries, construction and tunnels. `© OpenMapTiles © OpenStreetMap contributors` joins the attribution line once road data has loaded. The practice track has its own street grid. `pnpm roads` checks the spot search on a synthetic street, then loads the real tiles around every preset spot and reports the nearest drivable road (it should be a few metres away; over 25 m fails).

### Google Maps Platform terms

- The Google Maps logo and the data attribution line (sorted by frequency, from the tiles' `copyright` fields) are shown whenever tiles are on screen. The minimap shows the map data copyright for its area, from the Map Tiles viewport API.
- Tiles are only held in memory. There is no IndexedDB or service-worker caching and no prefetching outside the normal level-of-detail loading.
- Collision uses the meshes currently loaded for display; nothing derived from them is stored.
- Road positions come from OpenStreetMap, not from the tiles. The 3D mesh is only raycast at run time to check a spot is clear, the same way collision uses it.
