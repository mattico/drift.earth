// What the ground under each wheel does to the car. The world names the surface
// (World.surfaceAt); these numbers scale the car's own tires and drag, so each
// car keeps its character on every surface. Asphalt is the reference: all
// neutral, the car exactly as cars.ts tunes it. Starting points were published
// tire-on-surface friction and rolling-resistance figures, then tuned for feel
// with `pnpm handling --surfaces`.

// The order is the codes in OSM surface grids and the trace: append new ones.
export type SurfaceId = 'asphalt' | 'cobbles' | 'gravel' | 'grass' | 'sand' | 'water' | 'ford';

export interface Surface {
  /** × the car's μ (front, rear, rear sideways). */
  grip: number;
  /** × its peak slip ratio and angle: loose ground peaks later, the tire ploughing a ridge. */
  peakSlip: number;
  /**
   * 0…1: closes that share of the gap between the car's slideFront/slideRear
   * and 1. Loose ground barely loses grip past the peak, so slides are long,
   * floaty and easy to hold.
   */
  slideLift: number;
  /** Extra rolling resistance (m/s²). */
  rolling: number;
  /** Soft-ground drag (1/s: decel = drag·v), ploughing through it. */
  drag: number;
  /** Roughness: ride-height noise amplitude (m) and wavelength (m). */
  bump: number;
  bumpLength: number;
}

export const SURFACES: Record<SurfaceId, Surface> = {
  asphalt: { grip: 1, peakSlip: 1, slideLift: 0, rolling: 0, drag: 0, bump: 0, bumpLength: 1 },
  // Setts: a little less grip (polished stone), a touch of give past the
  // peak so a rear-drive car doesn't snap round on them, and a constant shake:
  // short bumps, as big as a car can show (sett joints, exaggerated a little).
  cobbles: { grip: 0.85, peakSlip: 1, slideLift: 0.2, rolling: 0.15, drag: 0, bump: 0.03, bumpLength: 0.6 },
  // Loose stones on a hard base: μ ≈ 0.6–0.7 and a later, flatter peak, so
  // slides are slower to start, long and forgiving. Not much later: the front
  // tires have to bite at the angles a driver steers a slide with, or a
  // front-drive car's slide straightens itself.
  gravel: { grip: 0.63, peakSlip: 1.4, slideLift: 0.7, rolling: 0.25, drag: 0.01, bump: 0.045, bumpLength: 1.5 },
  // Turf: μ ≈ 0.4, so braking takes twice as far; soft enough to hold the
  // speed down; flat past the peak, or a rear-drive car on the power just spins.
  grass: { grip: 0.39, peakSlip: 1.8, slideLift: 0.85, rolling: 0.2, drag: 0.03, bump: 0.06, bumpLength: 2.5 },
  // Soft sand drags a road car down: Crr ≈ 0.15 and more the faster it goes,
  // so it stops in about 5 s from 80 km/h off the throttle, and flat out it
  // labours along at about 30 km/h (the hatch) rather than bogging.
  sand: { grip: 0.65, peakSlip: 2, slideLift: 0.85, rolling: 1.3, drag: 0.3, bump: 0.04, bumpLength: 3 },
  // Deep water: next to no grip and heavy wading drag. Three wheels in it and
  // the car sinks (Game), so these only shape the moment before; a car that
  // gets out first can still crawl.
  water: { grip: 0.25, peakSlip: 1, slideLift: 0.5, rolling: 0.1, drag: 0.7, bump: 0, bumpLength: 1 },
  // A ford: a road through shallow water. Slippery and wading, but a car keeps
  // going across at a walking-to-jogging pace and never sinks. Flat past the
  // peak, like grass, or a rear-drive car on the power just spins.
  ford: { grip: 0.5, peakSlip: 1.5, slideLift: 0.8, rolling: 0.4, drag: 0.35, bump: 0.02, bumpLength: 0.8 },
};

/** Surfaces a car sinks in: three wheels on them and it's under. */
export const DEEP: ReadonlySet<SurfaceId> = new Set(['water']);
/** Loose ground the tires throw up and dig into: dust, ruts, the crunch of stones. */
export const LOOSE: ReadonlySet<SurfaceId> = new Set(['gravel', 'sand']);
/** Shown by the HUD's surface label: every surface but asphalt, what each is called there. */
export const SURFACE_LABELS: Record<SurfaceId, string> = {
  asphalt: '',
  cobbles: 'Cobbles',
  gravel: 'Gravel',
  grass: 'Grass',
  sand: 'Sand',
  water: 'Water',
  ford: 'Ford',
};

export const SURFACE_IDS = Object.keys(SURFACES) as SurfaceId[];
