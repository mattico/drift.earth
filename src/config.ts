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

  // Longitudinal
  topSpeed: 46,
  topSpeedReverse: 12,
  engineAccel: 9.5,
  brakeDecel: 16,
  reverseAccel: 5,
  rollingDecel: 0.35,
  dragK: 0.0006,
  engineBrake: 0.8,
  handbrakeDecel: 4,

  // Steering
  steerMax: 0.62,
  steerSpeedFalloff: 18, // δmax = steerMax / (1 + |v| / falloff)
  steerRate: 4.5,
  steerReturn: 7,

  // Lateral grip / drift
  aLatGrip: 14,
  gripRate: 10,
  muGrip: 1.6,
  muDrift: 1.6, // lateral grip while sliding: how hard a drift can turn
  muHandbrake: 0.45,
  throttleDriftLoss: 0.25,
  driftYawMax: 2.8,
  driftAlign: 4, // how strongly the slip angle is pulled toward its target
  driftAlignMax: 1.2, // …capped at this yaw rate (rad/s)
  // Slip angle held at full throttle / full handbrake (they add), and the cap.
  driftAngleThrottle: 45 * (Math.PI / 180),
  driftAngleHandbrake: 30 * (Math.PI / 180),
  driftAngleMax: 75 * (Math.PI / 180),
  // Extra yaw (rad/s) from full throttle / full handbrake while sliding.
  driftThrottleYaw: 0.6,
  driftHandbrakeYaw: 0.9,
  // How fast a slide turns the velocity toward the nose (rad/s), reached at
  // driftCarveAngle of slip, and the speed lost per second at 90° of slip.
  driftCarve: 1.5,
  driftCarveAngle: 40 * (Math.PI / 180),
  driftScrub: 0.3,
  driftFeatherTau: 0.12,
  driftEntryTime: 0.35, // drift yaw authority ramps in over this long
  // After a drift starts, the handbrake adds no extra angle or rotation for
  // this long, then fades its oversteer in over driftHandbrakeRamp.
  driftHandbrakeDelay: 0.3,
  driftHandbrakeRamp: 0.2,
  driftHoldSteer: 0.35, // steering (either way) needed to hold the full angle
  tauYawGrip: 0.06,
  tauYawDrift: 0.22,
  driftKeep: 0.45,
  driftEnterSpeed: 8,
  driftEnterSlip: 0.25,
  driftExitSlip: 0.08,
  driftExitTime: 0.3,
  driftExitSpeed: 5,
  gripRecoverTime: 0.4,

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
  impactThreshold: 5,
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
