// The cars. Each one's chassis, tyres, steering, brakes and drivetrain; its body
// model (carModel.ts) and engine sound (audio.ts) are looked up by its id.
// Units are SI (metres, seconds, radians, newtons) unless noted.

export type CarId = 'hatch' | 'muscle';

/** Which axle the engine drives. */
export type DriveLayout = 'rwd' | 'fwd';

export interface ChassisSpec {
  mass: number;
  // Body / footprint
  wheelbase: number;
  halfWidth: number;
  halfLength: number;
  /** Ground-probe offsets (≈ wheel contact patches). */
  cornerX: number;
  cornerZ: number;

  /** Roughly where drag balances power; scales camera pull-back. */
  topSpeed: number;
  topSpeedReverse: number;
  reverseAccel: number;
  rollingDecel: number;
  dragK: number;
  /** kg·m² */
  yawInertia: number;
  /** Centre of mass to front axle (rear is wheelbase − this). */
  cgToFront: number;
  /** Sets how much load braking and power shift between axles. */
  cgHeight: number;

  // Tyres. Force rises with slip to μ·load at the peak slip angle (lateral) or
  // ratio (longitudinal, wheel vs road speed), then falls to `slide`·peak when
  // sliding. Combined slip shares one friction budget, so a spinning or locked
  // wheel has little sideways grip left: that is what lets the rear step out
  // under power or the handbrake (and washes a front-drive car's nose wide).
  /** Front, every way (a front-drive car's fronts drive and brake on it too). */
  muFront: number;
  /** Rear drive (rear-drive cars) and braking… */
  muRear: number;
  /** …and cornering. */
  muRearSide: number;
  peakSlipAngle: number;
  peakSlipRatio: number;
  slideFront: number;
  slideRear: number;

  // Steering. The command is a road-wheel angle (speed-scaled, rate-limited so
  // digital input feels analogue) added to a caster-like self-alignment: with
  // the wheel centred, the front tyres point along their direction of travel,
  // so a sliding car countersteers itself and the input steers relative to the
  // path, as an experienced driver's hands would.
  steerMax: number;
  /** δmax = steerMax / (1 + |v| / falloff) */
  steerSpeedFalloff: number;
  steerRate: number;
  steerReturn: number;
  /** 0 = none, 1 = front tyres fully trail the direction of travel. */
  steerAlign: number;
  /** Road-wheel angle limit, countersteer included. */
  wheelLock: number;

  // Brakes. The foot brake has ABS (never locks); the handbrake locks the rear.
  /** m/s² the foot brake asks for… */
  brakeDecel: number;
  /** …front share. */
  brakeFront: number;
  /** Braking force cap as a share of the tyre's grip. */
  absLimit: number;
  /** Rear brake force at full pull, × weight. */
  handbrakeForce: number;

  // Stability control: yaw acceleration (rad/s² per rad of rear slip past its
  // peak, never more than reverses the yaw) when the rear lets go without the
  // driver asking: no handbrake, wheelspin or drift for stabilityOff seconds.
  // (A front-drive car's wheelspin doesn't count, nor a slide unless the
  // handbrake started it.)
  stability: number;
  stabilityOff: number;
  /** Rear slip angle it lets the car reach first (default peakSlipAngle): a sport mode, so lift-off slides happen. */
  stabilitySlip?: number;
  /**
   * Traction control, 0 (none) … 1: limits drive to what the driven tyres can
   * take while the wheel is near centre (steer, and it lets them spin). With
   * none, flooring a low gear spins the tyres up: a burnout.
   */
  tractionControl: number;
}

export interface DrivetrainSpec {
  wheelRadius: number;
  finalDrive: number;
  gears: number[];
  reverse: number;
  efficiency: number;
  idleRpm: number;
  redline: number;
  limiter: number;
  /** Fuel cut each time the limiter is hit (s). */
  limiterCut: number;
  /** Pulling away in 1st or reverse, the clutch slips below this wheel rpm; at full throttle the engine holds launchRpm. */
  clutchRpm: number;
  launchRpm: number;
  /** rpm → N·m (at full boost, for a turbo engine). */
  torque: Array<[number, number]>;
  /** A turbocharger; leave out for a naturally aspirated engine. */
  turbo?: TurboSpec;
  /** Engine braking torque at redline, scaling with rpm (stronger in lower gears). */
  engineBrakeTorque: number;
  /**
   * Rotating inertia (kg·m²): both driven wheels and axles (a front-drive car's
   * free-rolling rear pair is taken as the same); the engine's, felt through
   * the gear ratio.
   */
  wheelInertia: number;
  engineInertia: number;
  shiftTime: number;
  /** Auto box: shift up / down at these rpm, from light to full throttle. */
  autoUpRpm: [number, number];
  autoDownRpm: [number, number];
  /** Minimum time between automatic shifts. */
  autoHold: number;
}

/**
 * Turbo boost, 0…1, chases a target set by rpm and throttle: the exhaust has to
 * spin the turbine up (lag) and the blow-off valve dumps the pressure the moment
 * the throttle closes. Torque blends from the off-boost share of the curve to
 * all of it as boost builds.
 */
export interface TurboSpec {
  /** Full throttle builds boost from this rpm, all of it by `fullRpm` (smoothstep between). */
  onsetRpm: number;
  fullRpm: number;
  /** Spool-up time constant (s), at `fullRpm`; quicker above it, slower below. */
  spool: number;
  /** Time constant (s) the blow-off valve vents boost with on lift-off or a shift. */
  vent: number;
  /** Share of the torque curve that boost makes: off boost the engine has (1 − share) of it. */
  share: number;
}

export interface CarSpec {
  id: CarId;
  name: string;
  /** One line for the car picker. */
  blurb: string;
  drive: DriveLayout;
  /** Body colour. */
  paint: number;
  chassis: ChassisSpec;
  drivetrain: DrivetrainSpec;
}

const DEG = Math.PI / 180;

/**
 * Rear-drive V8 coupe. 470 N·m peak at 4500–5000 rpm, about 395 hp at the 7250
 * redline. Redline speeds: 75, 103, 132, 159, 185, 210 km/h = 46, 64, 82, 99,
 * 115, 131 mph (top speed is drag-limited, about 115 mph).
 */
const MUSCLE: CarSpec = {
  id: 'muscle',
  name: 'Muscle car',
  blurb: 'Rear-drive V8. Power-over drifts all day.',
  drive: 'rwd',
  paint: 0xff3b30,
  chassis: {
    mass: 1250,
    wheelbase: 2.6,
    halfWidth: 0.9,
    halfLength: 2.15,
    cornerX: 0.78,
    cornerZ: 1.3,
    topSpeed: 50,
    topSpeedReverse: 12,
    reverseAccel: 5,
    rollingDecel: 0.35,
    dragK: 0.00135,
    yawInertia: 2100,
    cgToFront: 1.25,
    cgHeight: 0.5,
    muFront: 1.4,
    muRear: 1.5,
    muRearSide: 1.5,
    peakSlipAngle: 7 * DEG,
    peakSlipRatio: 0.12,
    slideFront: 0.8,
    slideRear: 0.72,
    steerMax: 0.62,
    steerSpeedFalloff: 18,
    steerRate: 4.5,
    steerReturn: 7,
    steerAlign: 1,
    wheelLock: 52 * DEG,
    brakeDecel: 16,
    brakeFront: 0.65,
    absLimit: 0.92,
    handbrakeForce: 1.0,
    stability: 120,
    stabilityOff: 1,
    tractionControl: 0,
  },
  drivetrain: {
    wheelRadius: 0.33,
    finalDrive: 3.9,
    gears: [3.1, 2.25, 1.75, 1.45, 1.25, 1.1],
    reverse: 3.3,
    efficiency: 0.88,
    idleRpm: 900,
    redline: 7250,
    limiter: 7500,
    limiterCut: 0.06,
    clutchRpm: 1300,
    launchRpm: 4200,
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
      [7500, 375],
    ],
    engineBrakeTorque: 95,
    wheelInertia: 2.2,
    engineInertia: 0.2,
    shiftTime: 0.14,
    autoUpRpm: [3600, 7000],
    autoDownRpm: [1500, 3900],
    autoHold: 0.6,
  },
};

/**
 * Front-drive turbo hot hatch, after a Focus ST. 2.3 L turbo four: 420 N·m from
 * 3000 to 4000 rpm on full boost, about 300 hp at 6800 and still 280 at the 8500
 * redline. Redline speeds: 75, 137, 207, 272, 342, 407 km/h = 47, 85, 129, 169,
 * 213, 253 mph (top speed is drag-limited, about 154 mph). Front-heavy: it grips and
 * understeers on the power, and lifting off mid-corner lets the rear come round.
 */
const HATCH: CarSpec = {
  id: 'hatch',
  name: 'Hot hatch',
  blurb: 'Front-drive turbo four. Lift off or pull the handbrake to rotate it.',
  drive: 'fwd',
  paint: 0xff6a13,
  chassis: {
    mass: 1430,
    wheelbase: 2.7,
    halfWidth: 0.925,
    halfLength: 2.195,
    cornerX: 0.79,
    cornerZ: 1.35,
    topSpeed: 67,
    topSpeedReverse: 12,
    reverseAccel: 5,
    rollingDecel: 0.35,
    dragK: 0.00034,
    yawInertia: 2650,
    // About 60% of the weight on the front.
    cgToFront: 1.08,
    cgHeight: 0.6,
    muFront: 1.27,
    muRear: 1.4,
    // As much rear grip as front: neutral off the throttle, so the load that
    // lifting off moves forward lets the rear go.
    muRearSide: 1.27,
    peakSlipAngle: 7 * DEG,
    peakSlipRatio: 0.12,
    slideFront: 0.86,
    slideRear: 0.8,
    steerMax: 0.62,
    steerSpeedFalloff: 18,
    steerRate: 4.5,
    steerReturn: 7,
    steerAlign: 1,
    wheelLock: 52 * DEG,
    brakeDecel: 16,
    brakeFront: 0.68,
    absLimit: 0.92,
    handbrakeForce: 0.85,
    // Softer and later than the muscle car's, so lift-off slides get going.
    stability: 60,
    stabilityOff: 1.3,
    tractionControl: 1,
    stabilitySlip: 15 * DEG,
  },
  drivetrain: {
    wheelRadius: 0.335,
    finalDrive: 3.82,
    gears: [3.727, 2.048, 1.357, 1.032, 0.821, 0.69],
    reverse: 3.5,
    efficiency: 0.9,
    idleRpm: 850,
    redline: 8500,
    limiter: 8700,
    limiterCut: 0.06,
    // Slips until 1st is well under way, so the launch stays on boost.
    clutchRpm: 2000,
    launchRpm: 3500,
    // Full boost; with none (low rpm, lag, part throttle) it has 55% of this.
    // Torque tails off gently up top, so power holds near 280–300 hp to the
    // redline and revving it out pays.
    torque: [
      [800, 250],
      [1500, 330],
      [2000, 380],
      [2500, 410],
      [3000, 420],
      [4000, 420],
      [4500, 410],
      [5000, 395],
      [5500, 375],
      [6000, 352],
      [6500, 328],
      [7000, 305],
      [7500, 282],
      [8000, 258],
      [8500, 235],
      [8700, 225],
    ],
    turbo: { onsetRpm: 1400, fullRpm: 2900, spool: 0.35, vent: 0.08, share: 0.45 },
    engineBrakeTorque: 70,
    wheelInertia: 2.0,
    engineInertia: 0.17,
    shiftTime: 0.15,
    autoUpRpm: [3800, 8200],
    autoDownRpm: [1500, 4000],
    autoHold: 0.6,
  },
};

export const CARS: Record<CarId, CarSpec> = { hatch: HATCH, muscle: MUSCLE };
export const CAR_IDS = Object.keys(CARS) as CarId[];
export const DEFAULT_CAR: CarId = 'hatch';

export function isCarId(s: string | null | undefined): s is CarId {
  return !!s && Object.hasOwn(CARS, s);
}
