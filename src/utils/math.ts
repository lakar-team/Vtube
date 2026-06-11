export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Format a number for the debug HUD. */
export function fmt(v: number, digits = 1): string {
  return (v >= 0 ? "+" : "") + v.toFixed(digits);
}
