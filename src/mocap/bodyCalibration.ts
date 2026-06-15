import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

/**
 * Body-size calibration for the 3D Room View.
 *
 * MediaPipe `worldLandmarks` are already ~metric (meters, hip-origin) but only
 * approximately scaled and lack a crown landmark. We anchor them to the user's
 * entered real height to get a reliable metric scale, then derive real-world
 * sizes (head diameter, limb lengths) used to build a correctly-proportioned
 * mannequin.
 *
 * Scale is estimated from eye height (eyes→ankles distance) divided by the
 * adult anthropometric ratio eye-height/stature ≈ 0.936 — this avoids needing
 * the (unavailable) crown landmark. `metersPerUnit` is EMA-smoothed and holds
 * its last good value when the full body isn't in frame (webcam upper-body
 * use), so a single full-body "stand back" frame calibrates the session.
 */

const VIS = 0.5;
const EYE_HEIGHT_RATIO = 0.936; // floor→eye height / stature, adult mean
const SCALE_SMOOTH = 0.1;       // EMA factor for metersPerUnit stability

export interface BodyCalibration {
  /** worldLandmark units (≈meters) → real meters. EMA-smoothed, last-good held. */
  metersPerUnit: number;
  /** True once at least one full-body frame has anchored the scale. */
  calibrated: boolean;
  /** Fresh stature this frame in cm (≈ entered height once converged), else null. */
  measuredStatureCm: number | null;
  /** Real-world derived sizes (cm); null when that segment isn't visible. */
  headDiameterCm: number | null;
  shoulderWidthCm: number | null;
  upperArmCm: number | null;
  lowerArmCm: number | null;
  upperLegCm: number | null;
  lowerLegCm: number | null;
}

export function emptyCalibration(): BodyCalibration {
  return {
    metersPerUnit: 1, // worldLandmarks already ≈ meters — sane default pre-calibration
    calibrated: false,
    measuredStatureCm: null,
    headDiameterCm: null,
    shoulderWidthCm: null,
    upperArmCm: null,
    lowerArmCm: null,
    upperLegCm: null,
    lowerLegCm: null,
  };
}

type P = { x: number; y: number; z: number; visibility?: number };

function vis(p: P | undefined): p is P {
  return !!p && (p.visibility ?? 1) >= VIS;
}
function d3(a: P, b: P): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function mid(a: P, b: P): P {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/** Stature in world units from eye height, when eyes + ankles are visible. */
function estimateStatureUnits(pw: NormalizedLandmark[]): number | null {
  const eyeL = pw[2], eyeR = pw[5], ankL = pw[27], ankR = pw[28];
  if (!vis(eyeL) || !vis(eyeR) || !vis(ankL) || !vis(ankR)) return null;
  const eyeHeight = d3(mid(eyeL, eyeR), mid(ankL, ankR));
  if (eyeHeight < 1e-3) return null;
  return eyeHeight / EYE_HEIGHT_RATIO;
}

/**
 * Update the rolling calibration from the latest world landmarks + entered
 * height. Returns a fresh BodyCalibration (carries scale forward from `prev`).
 */
export function updateBodyCalibration(
  prev: BodyCalibration | null,
  pw: NormalizedLandmark[] | null,
  heightCm: number,
): BodyCalibration {
  const base = prev ?? emptyCalibration();
  let metersPerUnit = base.metersPerUnit;
  let calibrated = base.calibrated;
  let measuredStatureCm: number | null = null;

  if (pw && pw.length >= 33 && heightCm > 0) {
    const statureUnits = estimateStatureUnits(pw);
    if (statureUnits && statureUnits > 1e-3) {
      const target = heightCm / 100 / statureUnits;
      metersPerUnit = calibrated
        ? metersPerUnit + SCALE_SMOOTH * (target - metersPerUnit)
        : target; // snap on first measurement, then ease
      calibrated = true;
      measuredStatureCm = statureUnits * metersPerUnit * 100;
    }
  }

  const cm = metersPerUnit * 100;
  const seg = (i: number, j: number): number | null => {
    if (!pw) return null;
    const a = pw[i], b = pw[j];
    return vis(a) && vis(b) ? d3(a, b) * cm : null;
  };
  // Average the L/R pair, ignoring a side that's out of frame.
  const avg = (l: number | null, r: number | null): number | null => {
    if (l !== null && r !== null) return (l + r) / 2;
    return l ?? r;
  };

  return {
    metersPerUnit,
    calibrated,
    measuredStatureCm,
    headDiameterCm: seg(7, 8),                      // ear-to-ear head width
    shoulderWidthCm: seg(11, 12),
    upperArmCm: avg(seg(11, 13), seg(12, 14)),
    lowerArmCm: avg(seg(13, 15), seg(14, 16)),
    upperLegCm: avg(seg(23, 25), seg(24, 26)),
    lowerLegCm: avg(seg(25, 27), seg(26, 28)),
  };
}
