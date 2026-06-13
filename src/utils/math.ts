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

/**
 * Fixed-width variant of fmt for the debug HUD: pads to `width` characters
 * (rendered in a monospace font with `white-space: pre`) so live readouts
 * never change the layout's size as values flicker between e.g. +1.2 and
 * -123.4.
 */
export function fmtFixed(v: number, width = 6, digits = 1): string {
  return fmt(v, digits).padStart(width, " ");
}
