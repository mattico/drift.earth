// What the ground under each wheel does to the car. The world names the surface
// (World.surfaceAt); these numbers scale the car's own tires and drag, so each
// car keeps its character on every surface. Asphalt is the reference: all
// neutral, the car exactly as cars.ts tunes it. Starting points were published
// tire-on-surface friction and rolling-resistance figures, then tuned for feel
// with `pnpm handling --surfaces`.

export type SurfaceId = 'asphalt' | 'cobbles' | 'gravel' | 'grass' | 'sand' | 'water';

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
  // Soft sand bogs a road car down: Crr ≈ 0.15 and more the faster it goes,
  // so it stops in about 4 s from 80 km/h off the throttle and crawls on it.
  sand: { grip: 0.6, peakSlip: 2, slideLift: 0.85, rolling: 1.2, drag: 0.55, bump: 0.04, bumpLength: 3 },
  // Shallow water: next to no grip and heavy wading drag, but the tires still
  // find enough of the bed to crawl out at walking pace (sinking is for later).
  water: { grip: 0.25, peakSlip: 1, slideLift: 0.5, rolling: 0.1, drag: 0.7, bump: 0, bumpLength: 1 },
};

export const SURFACE_IDS = Object.keys(SURFACES) as SurfaceId[];
