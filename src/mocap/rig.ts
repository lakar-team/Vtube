import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { estimateStatureUnits } from "./bodyCalibration";

/**
 * RigConfig — fixed body proportions for the 3D mannequin.
 *
 * Captured ONCE via the scale-capture workflow (replacing continuous per-frame
 * rescaling) and later editable in the Rig Tuner. All lengths in centimeters.
 * Phase 1 captures + surfaces these; later phases drive the mannequin from them
 * (forward kinematics) and add tuner / face-mesh fields.
 */
export interface RigConfig {
  // ── bone lengths (cm) ──
  neckCm: number;
  torsoCm: number;
  upperArmCm: number;
  lowerArmCm: number;
  upperLegCm: number;
  lowerLegCm: number;
  footCm: number;
  shoulderWidthCm: number;
  hipWidthCm: number;
  headDiameterCm: number;
  /** Hip height above the floor (cm) — anchors the rig in the room. */
  hipHeightCm: number;
  // ── limb thickness (cm radius) — tunable, defaults until edited ──
  neckRcm: number;
  torsoRcm: number;
  upperArmRcm: number;
  lowerArmRcm: number;
  upperLegRcm: number;
  lowerLegRcm: number;
  footRcm: number;
  jointRcm: number;
  handRcm: number;
  /** Finger bone radius (cm) — base radius, tapered per bone toward the tips. */
  fingerRcm: number;
  /** Palm half-thickness (cm) — the flattened palm slab. */
  palmRcm: number;
  /** Hand length wrist→middle-fingertip (cm) — fixes finger size from capture. */
  handLengthCm: number;
  // ── per-finger length multipliers (1 = canonical) ──
  fingerThumb: number;
  fingerIndex: number;
  fingerMiddle: number;
  fingerRing: number;
  fingerLittle: number;
  // ── eyeballs (cm), in FACE-LOCAL space (face surface anchor + R/U/F basis) ──
  eyeRcm: number;   // eyeball radius
  eyeXcm: number;   // half the eye separation (each eye at ±eyeXcm along face-right)
  eyeYcm: number;   // vertical offset above the face anchor (face-up)
  eyeZcm: number;   // small forward offset off the face surface (face-forward)
  // ── face mesh fit on the head (tunable) ──
  /** Face-mesh size multiplier relative to the head (1 = head-fit). */
  faceScale: number;
  /** Face-mesh offset from the head centre (cm): X right, Y up, Z toward viewer. */
  faceOffXcm: number;
  faceOffYcm: number;
  faceOffZcm: number;
  /** Mannequin skin tone (hex string) — head, face, torso, limbs. */
  skinHex: string;
  /** Entered standing height at capture (cm). */
  heightCm: number;
  /** Epoch ms of the capture, or null for the default (uncaptured) rig. */
  capturedAt: number | null;
}

/** Numeric (tunable) RigConfig keys — everything except the timestamp + skin hex. */
export type RigNumKey = Exclude<keyof RigConfig, "capturedAt" | "skinHex">;

/** Rough adult proportions (~170cm) — used until the user captures their own. */
export const DEFAULT_RIG: RigConfig = {
  neckCm: 8,
  torsoCm: 50,
  upperArmCm: 30,
  lowerArmCm: 25,
  upperLegCm: 45,
  lowerLegCm: 42,
  footCm: 18,
  shoulderWidthCm: 40,
  hipWidthCm: 32,
  headDiameterCm: 18,
  hipHeightCm: 90,
  neckRcm: 3.5,
  torsoRcm: 9,
  upperArmRcm: 4.5,
  lowerArmRcm: 3.3,
  upperLegRcm: 7,
  lowerLegRcm: 5,
  footRcm: 3,
  jointRcm: 4,
  handRcm: 6.5,
  fingerRcm: 0.9,
  palmRcm: 2.2,
  handLengthCm: 19,
  fingerThumb: 1,
  fingerIndex: 1,
  fingerMiddle: 1,
  fingerRing: 1,
  fingerLittle: 1,
  eyeRcm: 1.3,
  eyeXcm: 3.2,
  eyeYcm: 3,
  eyeZcm: 1.5,
  faceScale: 1,
  faceOffXcm: 0,
  faceOffYcm: 0,
  faceOffZcm: 0,
  skinHex: "#d4b080",
  heightCm: 170,
  capturedAt: null,
};

const RIG_KEY = "vtube.rigConfig";

export function loadRigConfig(): RigConfig {
  try {
    const raw = localStorage.getItem(RIG_KEY);
    if (!raw) return { ...DEFAULT_RIG };
    const parsed = JSON.parse(raw) as Partial<RigConfig>;
    // Merge over defaults so configs saved before new fields existed stay valid.
    return { ...DEFAULT_RIG, ...parsed };
  } catch {
    return { ...DEFAULT_RIG };
  }
}

export function saveRigConfig(cfg: RigConfig): void {
  try { localStorage.setItem(RIG_KEY, JSON.stringify(cfg)); } catch { /* privacy mode */ }
}

const VIS = 0.5;
type P = { x: number; y: number; z: number; visibility?: number };
function vis(p: P | undefined): p is P { return !!p && (p.visibility ?? 1) >= VIS; }
function d3(a: P, b: P): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function mid(a: P, b: P): P { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }; }

/**
 * Snapshot body proportions from ONE frame's world landmarks into a RigConfig.
 *
 * Scale is anchored to the entered height via the eye-height proxy (same as the
 * live calibration), falling back to `fallbackMetersPerUnit` if eyes/ankles
 * aren't visible. Returns null when the core torso landmarks are missing (so
 * the caller can tell the user to stand fully in frame).
 */
export function captureRigConfig(
  pw: NormalizedLandmark[] | null,
  fallbackMetersPerUnit: number,
  heightCm: number,
  capturedAt: number,
  base: RigConfig = DEFAULT_RIG,
): RigConfig | null {
  if (!pw || pw.length < 33) return null;
  if (!vis(pw[11]) || !vis(pw[12]) || !vis(pw[23]) || !vis(pw[24])) return null;

  const statureUnits = estimateStatureUnits(pw);
  const scale = statureUnits ? heightCm / 100 / statureUnits : fallbackMetersPerUnit;
  const cm = scale * 100;

  const dcm = (a: P, b: P) => d3(a, b) * cm;
  const avg = (a: number, b: number) => (a + b) / 2;

  const earMid = mid(pw[7], pw[8]);
  const shMid = mid(pw[11], pw[12]);
  const hipMid = mid(pw[23], pw[24]);
  const ankMid = vis(pw[27]) && vis(pw[28]) ? mid(pw[27], pw[28]) : null;

  return {
    // Thickness (radii) and any non-measured fields carry over from `base` so a
    // re-capture preserves the user's tuned thicknesses.
    ...base,
    neckCm: dcm(earMid, shMid),
    torsoCm: dcm(shMid, hipMid),
    upperArmCm: avg(dcm(pw[11], pw[13]), dcm(pw[12], pw[14])),
    lowerArmCm: avg(dcm(pw[13], pw[15]), dcm(pw[14], pw[16])),
    handLengthCm: avg(dcm(pw[13], pw[15]), dcm(pw[14], pw[16])) * 0.75,
    upperLegCm: avg(dcm(pw[23], pw[25]), dcm(pw[24], pw[26])),
    lowerLegCm: avg(dcm(pw[25], pw[27]), dcm(pw[26], pw[28])),
    footCm: avg(dcm(pw[27], pw[31]), dcm(pw[28], pw[32])),
    shoulderWidthCm: dcm(pw[11], pw[12]),
    hipWidthCm: dcm(pw[23], pw[24]),
    headDiameterCm: dcm(pw[7], pw[8]),
    // Vertical hip→ankle (standing) ≈ hip height above the floor.
    hipHeightCm: ankMid ? Math.abs(hipMid.y - ankMid.y) * cm : 0.53 * heightCm,
    heightCm,
    capturedAt,
  };
}
