// Central tuning values. Units are SI (metres, seconds, radians) unless noted.

export const PHYSICS = {
  dt: 1 / 120,
  maxSubsteps: 12,

  // Car-specific values (footprint, chassis, tyres, steering, brakes,
  // stability control, drivetrain) live in car/cars.ts.
  // Chassis integration substeps per physics step (tyre forces are stiff).
  substeps: 3,
  // Below this speed (m/s) slip is measured against it instead, so the tyres
  // act like stiff dampers when nearly stopped rather than chattering.
  tyreMinSpeed: 3,
  pedalTau: 0.1, // throttle and handbrake smoothing, so tapping a key feathers

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
  // Vehicle-sized lumps on the road (baked parked cars, vans and small trucks,
  // smeared "ghost" cars) are driven through: no taller than blobMaxHeight,
  // road again within blobMaxDepth ahead and blobMaxHalfWidth to each side,
  // nothing overhead. Heights are measured from the plane of the road the car
  // is on, so hills don't count as lumps.
  blobMaxHeight: 3,
  blobMaxDepth: 10,
  blobRowGap: 3.5, // past this far in, one road sample ends a lump (parked bumper to bumper)
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
  // …and that median at most portalLidRise above the cover at the face: a
  // tunnel's lid runs on at about the portal's height (measured within 1 m at
  // Lowry Hill and Lyndale), a building's cover jumps from an overhang to its
  // roof (+10 m at a Loring Park building).
  portalLidRise: 3,
  portalLean: 0.6,
  portalLeanNy: -0.35,
  // Inside a tunnel the road is missing, so the car runs on a virtual road:
  // keeping its clearance under the cover, ramping to meet the exit road once a
  // scan ahead finds it, and never steeper than tunnelMaxGrade.
  tunnelMaxGrade: 0.08,
  tunnelEntryGrace: 20, // metres past the portal where a face is still its curtain…
  tunnelGraceCover: 4, // …if the cover beyond it is within this above the portal's clearance
  tunnelExitTol: 1.2, // exit road within this of the virtual road
  tunnelScanEvery: 8,
  tunnelScanRange: 220,
  tunnelMaxLength: 1200,
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
  /** Free camera (right stick): orbit rate, tilt rate (rad/s), lowest tilt, and how long after letting go it eases back, how fast. */
  orbitRate: 2.6,
  orbitTiltRate: 1.2,
  orbitMinPitch: 8 * (Math.PI / 180),
  orbitHold: 1.5,
  orbitReturnTau: 0.5,
  /** Mouse drag: orbit and tilt (rad) per screen height dragged. */
  dragRate: 2 * Math.PI,
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
