// Central tuning values. Units are SI (metres, seconds, radians) unless noted.

export const PHYSICS = {
  dt: 1 / 120,
  maxSubsteps: 12,

  // Body / footprint
  wheelbase: 2.6,
  halfWidth: 0.9,
  halfLength: 2.15,
  cornerX: 0.78, // ground-probe offsets (≈ wheel contact patches)
  cornerZ: 1.3,

  // Chassis: a single-track ("bicycle") model with a tyre at each axle. Mass
  // and engine come from DRIVETRAIN; drag and rolling resistance are per kg.
  topSpeed: 50, // roughly where drag balances power; scales camera pull-back
  topSpeedReverse: 12,
  reverseAccel: 5,
  rollingDecel: 0.35,
  dragK: 0.00135,
  yawInertia: 2100, // kg·m²
  cgToFront: 1.25, // centre of mass to front axle (rear is wheelbase − this)
  cgHeight: 0.5, // sets how much load braking and power shift between axles
  // Chassis integration substeps per physics step (tyre forces are stiff).
  substeps: 3,

  // Tyres. Force rises with slip to μ·load at the peak slip angle (lateral) or
  // ratio (longitudinal, wheel vs road speed), then falls to `slide`·peak when
  // sliding. Combined slip shares one friction budget, so a spinning or locked
  // rear wheel has little sideways grip left: that is what lets the rear step
  // out under power or the handbrake.
  muFront: 1.4,
  muRear: 1.5, // drive and braking…
  muRearSide: 1.5, // …and cornering
  peakSlipAngle: 7 * (Math.PI / 180),
  peakSlipRatio: 0.12,
  slideFront: 0.8,
  slideRear: 0.72,
  // Below this speed (m/s) slip is measured against it instead, so the tyres
  // act like stiff dampers when nearly stopped rather than chattering.
  tyreMinSpeed: 3,

  // Steering. The command is a road-wheel angle (speed-scaled, rate-limited so
  // digital input feels analogue) added to a caster-like self-alignment: with
  // the wheel centred, the front tyres point along their direction of travel,
  // so a sliding car countersteers itself and the input steers relative to the
  // path, as an experienced driver's hands would.
  steerMax: 0.62,
  steerSpeedFalloff: 18, // δmax = steerMax / (1 + |v| / falloff)
  steerRate: 4.5,
  steerReturn: 7,
  steerAlign: 1, // 0 = none, 1 = front tyres fully trail the direction of travel
  wheelLock: 52 * (Math.PI / 180), // road-wheel angle limit, countersteer included

  // Brakes. The foot brake has ABS (never locks); the handbrake locks the rear
  // and disengages the clutch while it is held.
  brakeDecel: 16, // m/s² the foot brake asks for…
  brakeFront: 0.65, // …front share
  absLimit: 0.92, // braking force cap as a share of the tyre's grip
  handbrakeForce: 1.0, // rear brake force at full pull, × weight
  pedalTau: 0.1, // throttle and handbrake smoothing, so tapping a key feathers

  // Stability control: yaw acceleration (rad/s² per rad of rear slip past its
  // peak, never more than reverses the yaw) when the rear lets go without the
  // driver asking: no handbrake, wheelspin or drift for stabilityOff seconds.
  stability: 120,
  stabilityOff: 1,

  // Past this slip angle a yaw torque (rad/s² per rad over) helps the car back
  // from a spin, so a keyboard driver can over-rotate and still recover.
  spinAngle: 55 * (Math.PI / 180),
  spinAssist: 25,

  // Drift detection, read off the slide for scoring, smoke and the camera.
  driftEnterSpeed: 8,
  driftEnterSlip: 12 * (Math.PI / 180),
  driftExitSlip: 6 * (Math.PI / 180),
  driftExitTime: 0.3,
  driftExitSpeed: 5,

  // Ground following on photogrammetry
  stepUp: 0.6, // ray origin above current corner height: canopy/overpasses above this are ignored
  probeDepth: 3.0,
  maxStep: 0.45, // a rise above this between steps is a wall, not a kerb
  dropHeight: 3, // a leading wheel over a drop deeper than this is an edge: treat it as a wall
  minGroundNormalY: 0.64, // ≈ 50° max slope
  outlierThreshold: 0.5,
  maxTilt: 25 * (Math.PI / 180),
  suspensionK: 180,
  suspensionC: 19,
  airborneGap: 0.2,
  slopeGravity: 0.6,
  slopeDeadzone: 0.06,
  freezeAfterMiss: 0.25,

  // Walls
  wallProbeHeight: 0.7,
  wallRestitution: 0.15,
  wallFriction: 0.3,
  wallMaxNormalY: 0.6,
  // Photogrammetry drapes a solid-looking "curtain" from overpass decks to the road,
  // hidden from the top-down camera by the deck. A wall hit is treated as an overpass
  // when, past it, a flat deck this high runs no further than overpassMaxDepth
  // before the surface drops back to about road level.
  overpassMinDeck: 3.5,
  overpassMaxDeck: 9,
  overpassDeckTolerance: 2,
  overpassMaxDepth: 41,
  overpassSkirt: 10,
  // Skyways (Minneapolis has miles of them) have roofs up to ~14 m but are only
  // a few metres deep, so a taller deck is allowed when it ends this soon.
  skywayMaxDeck: 14,
  skywayMaxDepth: 9,
  // Car-sized lumps on flat road (baked parked cars, smeared "ghost" cars) are
  // driven through: no taller than blobMaxHeight, road again within
  // blobMaxDepth ahead and blobMaxHalfWidth to each side, nothing overhead.
  blobMaxHeight: 2.2,
  blobMaxDepth: 7,
  blobMaxHalfWidth: 4,
  blobRoadTol: 0.3,
  blobTopSlack: 0.3, // a blob's top must be within this of where the probe hit it
  blobGroundNormalY: 0.97, // only on near-flat ground (roads), not ramps or hills
  // Portals: wide underpasses, covered roadways and tunnels, where the deck runs
  // on too far for the overpass test. Measured on Minneapolis's Lowry Hill
  // tunnel, I-394 under the ABC ramps, Glenwood Ave under I-94 and Lyndale Ave
  // under I-394, against one-storey shops and parking ramps.
  // A cover is the lowest surface at least portalMinCover above the road.
  portalMinCover: 3.5,
  // Road visible under the cover (reconstructed): it must run on under a cover
  // up to portalMaxCoverFloored for portalFloorRun or come out, and the cover
  // must look like a deck: flat and low enough to drive under (at most
  // portalMaxCover at the face, median at least portalMinClearance), a slab
  // (top and underside) over portalSlabShare of the run, or a leaning face.
  portalMaxCoverFloored: 40,
  portalFloorTol: 1,
  portalFloorRun: 60,
  portalSlabShare: 0.3,
  portalDeckFlatness: 1.5, // or a flat cover: 10th–90th percentile height within this
  // No road under it (photogrammetry can't see in): the cover must be at most
  // portalMaxCover at the face and its median 4–20 m in at least
  // portalMinClearance (parking decks are lower), and the face must lean
  // toward the car the way a deck edge or tunnel portal does (building facades
  // are vertical): level rays 1.5, 3 and 4.5 m up must meet it portalLean
  // nearer at the top, and one must face downward.
  portalMaxCover: 14,
  portalMinClearance: 5,
  portalLean: 0.6,
  portalLeanNy: -0.35,
  // Inside a tunnel the road is missing, so the car runs on a virtual road:
  // keeping its clearance under the cover, ramping to meet the exit road once a
  // scan ahead finds it, and never steeper than tunnelMaxGrade.
  tunnelMaxGrade: 0.08,
  tunnelEntryGrace: 20, // metres past the portal where every face is still its curtain
  tunnelExitTol: 1.2, // exit road within this of the virtual road
  tunnelScanEvery: 8,
  tunnelScanRange: 220,
  tunnelMaxLength: 1200,
  impactThreshold: 5,
};

/**
 * Engine and gearbox. 420 N·m peak at 5000 rpm, 354 hp peak at 7100.
 * Redline speeds: 77, 106, 137, 165, 191, 217 km/h (top speed is drag-limited).
 */
export const DRIVETRAIN = {
  mass: 1250,
  wheelRadius: 0.33,
  finalDrive: 3.9,
  gears: [3.1, 2.25, 1.75, 1.45, 1.25, 1.1],
  reverse: 3.3,
  efficiency: 0.88,
  idleRpm: 900,
  redline: 7500,
  limiter: 7800,
  /** Fuel cut each time the limiter is hit (s). */
  limiterCut: 0.06,
  /** Below this wheel rpm the clutch slips; at full throttle the engine holds launchRpm. */
  clutchRpm: 1300,
  launchRpm: 4200,
  /** rpm → N·m. */
  torque: [
    [800, 260],
    [1500, 320],
    [2500, 385],
    [3500, 440],
    [4500, 470],
    [5000, 470],
    [5800, 455],
    [6500, 430],
    [7200, 390],
    [7800, 360],
  ] as Array<[number, number]>,
  /** Engine braking torque at redline, scaling with rpm (stronger in lower gears). */
  engineBrakeTorque: 95,
  /** Rotating inertia (kg·m²): both rear wheels and axles; the engine's, felt through the gear ratio. */
  wheelInertia: 2.2,
  engineInertia: 0.2,
  shiftTime: 0.14,
  /** Auto box: shift up / down at these rpm, from light to full throttle. */
  autoUpRpm: [3800, 7200],
  autoDownRpm: [1600, 4300],
  /** Minimum time between automatic shifts. */
  autoHold: 0.6,
};

export const CAMERA = {
  fov: 40,
  // ~65 m is about as close as Google's public LOD allows before textures go soft
  // (leaf texels ~10–30 cm in cities; see README "Camera distance").
  distance: 65,
  distancePerSpeed: 0.9,
  maxDistance: 140,
  minZoom: 0.6,
  maxZoom: 2.5,
  // Pitch is measured down from the horizon: 90° would be straight top-down.
  // The first is the default; C steps toward top-down, then wraps.
  pitchPresets: [34, 46, 58, 70, 82].map((d) => d * (Math.PI / 180)),
  pitchSpeedBonus: 6 * (Math.PI / 180),
  yawTau: 0.35,
  targetTau: 0.08,
  distanceTau: 0.6,
  lookAheadTime: 0.35,
  lookAheadMax: 14,
  forwardBias: 0.12,
};

export const TILES = {
  errorTarget: 10,
  regionRadius: 110,
  regionErrorTarget: 1,
  regionLookAhead: 1.5,
  rebaseDistance: 1500,
  cacheMaxBytes: 0.8 * 2 ** 30,
  cacheMinBytes: 0.6 * 2 ** 30,
};

export const SCORING = {
  pointsFactor: 0.5,
  /** A wall hit harder than this (m/s into the wall) ends the drift chain. */
  crashImpact: 3,
  multiplierStep: 2,
  maxMultiplier: 5,
  bankDelay: 1.2,
};
