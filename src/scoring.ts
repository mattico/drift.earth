import { SCORING as S } from './config';

export interface ScoreState {
  total: number;
  best: number;
  /** Points accumulating in the current (unbanked) drift chain. */
  combo: number;
  multiplier: number;
  angleDeg: number;
  drifting: boolean;
}

const BEST_KEY = 'drift.earth:best';

/** Drift chains bank after a short grace period; a hard wall hit throws the chain away. */
export class DriftScore {
  total = 0;
  best = readBest();
  combo = 0;
  private chainTime = 0;
  private grace = 0;
  private angle = 0;
  private active = false;
  onBank?: (points: number) => void;
  onFail?: (lost: number) => void;

  /** `scraping`: touching a wall earns nothing (no farming points along barriers). */
  tick(dt: number, drifting: boolean, speed: number, slip: number, scraping = false): void {
    const angleDeg = Math.abs(slip) * (180 / Math.PI);
    this.angle = angleDeg;
    if (drifting && speed > 6 && angleDeg > 8 && !scraping) {
      this.active = true;
      this.grace = S.bankDelay;
      this.chainTime += dt;
      this.combo += speed * angleDeg * S.pointsFactor * this.multiplier * dt;
    } else if (this.active) {
      this.grace -= dt;
      if (this.grace <= 0) this.bank();
    }
  }

  get multiplier(): number {
    return Math.min(S.maxMultiplier, 1 + Math.floor(this.chainTime / S.multiplierStep));
  }

  crash(): void {
    if (!this.active || this.combo < 1) return;
    const lost = Math.round(this.combo);
    this.reset();
    this.onFail?.(lost);
  }

  private bank(): void {
    const pts = Math.round(this.combo);
    this.total += pts;
    if (this.total > this.best) {
      this.best = this.total;
      try {
        localStorage.setItem(BEST_KEY, String(this.best));
      } catch {
        // Storage can be unavailable (private mode); best score just won't persist.
      }
    }
    this.reset();
    if (pts > 0) this.onBank?.(pts);
  }

  private reset(): void {
    this.active = false;
    this.combo = 0;
    this.chainTime = 0;
    this.grace = 0;
  }

  newRun(): void {
    this.reset();
    this.total = 0;
  }

  state(): ScoreState {
    return {
      total: this.total,
      best: this.best,
      combo: Math.round(this.combo),
      multiplier: this.multiplier,
      angleDeg: this.angle,
      drifting: this.active,
    };
  }
}

function readBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}
