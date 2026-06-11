/**
 * One Euro Filter — adaptive low-pass filter for noisy real-time signals.
 *
 * Reference: Casiez, Roussel, Vogel — "1€ Filter: A Simple Speed-based
 * Low-pass Filter for Noisy Input in Interactive Systems" (CHI 2012).
 * https://gery.casiez.net/1euro/
 *
 * Why this matters here: raw landmark output from MediaPipe (and therefore
 * Kalidokit's solved rotations) jitters at sub-degree scale every frame.
 * Plain exponential smoothing either lags fast head turns or lets jitter
 * through. The One Euro filter adapts its cutoff to signal speed: heavy
 * smoothing when you hold still, light smoothing when you move fast.
 *
 * Tuning intuition:
 * - minCutoff (Hz): lower = more smoothing at rest (more jitter removed,
 *   more lag on slow drift). Typical 0.5–2.
 * - beta: higher = less lag during fast motion. Typical 0.1–1.
 * - dCutoff (Hz): cutoff for the derivative estimate; 1.0 is almost always fine.
 */

export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

function smoothingFactor(dt: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

class LowPass {
  private initialized = false;
  private stored = 0;

  filter(value: number, alpha: number): number {
    if (!this.initialized) {
      this.initialized = true;
      this.stored = value;
      return value;
    }
    this.stored = alpha * value + (1 - alpha) * this.stored;
    return this.stored;
  }

  last(): number {
    return this.stored;
  }

  reset(): void {
    this.initialized = false;
    this.stored = 0;
  }
}

export class OneEuroFilter {
  private readonly x = new LowPass();
  private readonly dx = new LowPass();
  private lastTime: number | null = null;

  constructor(private params: OneEuroParams) {}

  /**
   * @param value raw sample
   * @param t timestamp in SECONDS
   */
  filter(value: number, t: number): number {
    if (this.lastTime === null) {
      this.lastTime = t;
      this.dx.filter(0, 1);
      return this.x.filter(value, 1);
    }

    let dt = t - this.lastTime;
    this.lastTime = t;
    if (dt <= 0) dt = 1 / 60; // guard against duplicate/reversed timestamps

    // Estimate (filtered) derivative of the signal.
    const rawDx = (value - this.x.last()) / dt;
    const edx = this.dx.filter(rawDx, smoothingFactor(dt, this.params.dCutoff));

    // Speed-adaptive cutoff.
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(edx);
    return this.x.filter(value, smoothingFactor(dt, cutoff));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
  }
}
