import {
  ALL_EXPRESSION_KEYS,
  ARM_KEYS,
  LEG_KEYS,
  zeroEuler,
  zeroExpressions,
  zeroLegs,
  type ArmRotations,
  type EulerRotation,
  type ExpressionValues,
  type LegRotations,
  type MocapFrame,
} from "./types";
import { clamp } from "../utils/math";

/**
 * Two-stage calibration.
 *
 * FACE ("sit relaxed, look at the camera"): nobody sits perfectly straight
 * and centered, and no two webcams are mounted at the same angle. We record
 * ~2 s of frames, average them, and:
 * 1. The averaged head/pupil rotations become zero-offsets.
 * 2. The averaged expression values become per-channel baselines, and
 *    subsequent values are renormalized to use the remaining range:
 *        v' = (v - baseline) / (1 - baseline)
 *    e.g. if your resting face reads jawOpen = 0.15, the avatar's mouth now
 *    rests fully closed and still reaches 1.0 when you open wide.
 *
 * BODY ("stand in a T-pose, arms straight out"): solves the rest-pose
 * mismatch between you and the model. A T-pose is, by VRM spec, the model's
 * exact rest pose — so whatever the solver reports while you hold one is
 * pure bias (camera angle, lens, MediaPipe quirks, Kalidokit's built-in
 * offsets). We average it and subtract it from all subsequent body output,
 * which guarantees: you in a T-pose => avatar in its rest T-pose, and every
 * movement is measured relative to that shared reference. The captured hip
 * position also becomes the reference origin for hip translation (sway /
 * crouch / walking toward the camera), which stays disabled until a body
 * calibration provides it.
 *
 * There's a countdown before the body capture so you can step back from the
 * keyboard and strike the pose.
 */

export const CALIBRATION_DURATION_MS = 2000;
export const BODY_CALIBRATION_COUNTDOWN_MS = 3000;

export type CalibrationMode = "face" | "body";

export interface BodyCalibrationData {
  spine: EulerRotation;
  arms: ArmRotations;
  legs: LegRotations;
  hipsRotation: EulerRotation;
  /** Reference standing hip position (solver units). */
  hipsPosition: { x: number; y: number; z: number };
  /**
   * Upright torso length / shoulder width (image space), the reference for
   * the apparent-size torso-pitch (bow) estimator. 0 = not captured
   * (pre-existing stored calibrations) — the estimator then falls back to a
   * running max maintained by useMocap.
   */
  torsoRatio: number;
  legSamples: number;
  sampleCount: number;
}

export interface CalibrationData {
  head: EulerRotation;
  pupil: { x: number; y: number };
  expressionBaseline: ExpressionValues;
  faceSampleCount: number;
  body: BodyCalibrationData | null;
}

export function emptyCalibration(): CalibrationData {
  return {
    head: zeroEuler(),
    pupil: { x: 0, y: 0 },
    expressionBaseline: zeroExpressions(),
    faceSampleCount: 0,
    body: null,
  };
}

function subEuler(a: EulerRotation, b: EulerRotation): EulerRotation {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export class CalibrationRecorder {
  readonly mode: CalibrationMode;
  private samples: MocapFrame[] = [];
  private readonly startedAt: number;
  private readonly captureStartsAt: number;

  constructor(mode: CalibrationMode, nowMs: number) {
    this.mode = mode;
    this.startedAt = nowMs;
    // Body calibration: give the user time to step back and strike the pose.
    this.captureStartsAt =
      nowMs + (mode === "body" ? BODY_CALIBRATION_COUNTDOWN_MS : 0);
  }

  /** Seconds left before capture begins (0 once recording). */
  countdownLeft(nowMs: number): number {
    return Math.max(0, (this.captureStartsAt - nowMs) / 1000);
  }

  /** Returns true while still recording (or counting down). */
  add(frame: MocapFrame, nowMs: number): boolean {
    if (nowMs >= this.captureStartsAt) {
      // Face mode needs a tracked face; body mode a tracked pose.
      const usable = this.mode === "face" ? frame.faceTracked : frame.poseTracked;
      if (usable) this.samples.push(frame);
    }
    return nowMs - this.captureStartsAt < CALIBRATION_DURATION_MS;
  }

  get progress(): number {
    return clamp(this.samples.length / 30, 0, 1);
  }

  /**
   * Average the captured samples into calibration data, merged over `prev`
   * (so a face calibration doesn't wipe an earlier body calibration and vice
   * versa). Returns null if too few usable frames were captured.
   */
  finish(prev: CalibrationData | null): CalibrationData | null {
    if (this.samples.length < 10) return null; // not enough tracked frames

    const out: CalibrationData = prev
      ? { ...prev, body: prev.body }
      : emptyCalibration();

    if (this.mode === "face") {
      const n = this.samples.length;
      const head = zeroEuler();
      const pupil = { x: 0, y: 0 };
      const baseline = zeroExpressions();
      for (const s of this.samples) {
        head.x += s.head.x / n;
        head.y += s.head.y / n;
        head.z += s.head.z / n;
        pupil.x += s.pupil.x / n;
        pupil.y += s.pupil.y / n;
        for (const k of ALL_EXPRESSION_KEYS) {
          baseline[k] += s.expressions[k] / n;
        }
      }
      // Blinks: a neutral baseline above ~0.4 means the user blinked during
      // calibration or tracking is bad; don't bake that in.
      baseline.blinkLeft = Math.min(baseline.blinkLeft, 0.4);
      baseline.blinkRight = Math.min(baseline.blinkRight, 0.4);

      out.head = head;
      out.pupil = pupil;
      out.expressionBaseline = baseline;
      out.faceSampleCount = n;
      return out;
    }

    // ---- body mode
    const n = this.samples.length;
    const body: BodyCalibrationData = {
      spine: zeroEuler(),
      arms: {
        leftUpperArm: zeroEuler(),
        leftLowerArm: zeroEuler(),
        rightUpperArm: zeroEuler(),
        rightLowerArm: zeroEuler(),
      },
      legs: zeroLegs(),
      hipsRotation: zeroEuler(),
      hipsPosition: { x: 0, y: 0, z: 0 },
      torsoRatio: 0,
      legSamples: 0,
      sampleCount: n,
    };

    let ratioSum = 0;
    let ratioSamples = 0;
    for (const s of this.samples) {
      if (s.torsoRatio > 0) {
        ratioSum += s.torsoRatio;
        ratioSamples++;
      }
      body.spine.x += s.spine.x / n;
      body.spine.y += s.spine.y / n;
      body.spine.z += s.spine.z / n;
      body.hipsRotation.x += s.hips.rotation.x / n;
      body.hipsRotation.y += s.hips.rotation.y / n;
      body.hipsRotation.z += s.hips.rotation.z / n;
      body.hipsPosition.x += s.hips.position.x / n;
      body.hipsPosition.y += s.hips.position.y / n;
      body.hipsPosition.z += s.hips.position.z / n;
      for (const k of ARM_KEYS) {
        body.arms[k].x += s.arms[k].x / n;
        body.arms[k].y += s.arms[k].y / n;
        body.arms[k].z += s.arms[k].z / n;
      }
      if (s.legsTracked) body.legSamples++;
    }
    if (ratioSamples > 5) body.torsoRatio = ratioSum / ratioSamples;

    // Legs are only zeroed against the T-pose if they were actually visible
    // during calibration; otherwise leave leg offsets at zero.
    if (body.legSamples > 5) {
      for (const s of this.samples) {
        if (!s.legsTracked) continue;
        for (const k of LEG_KEYS) {
          body.legs[k].x += s.legs[k].x / body.legSamples;
          body.legs[k].y += s.legs[k].y / body.legSamples;
          body.legs[k].z += s.legs[k].z / body.legSamples;
        }
      }
    }

    out.body = body;
    return out;
  }
}

/** Remap an expression value so `baseline` becomes the new zero. */
function remapExpression(v: number, baseline: number): number {
  const usable = Math.max(1 - baseline, 0.05);
  return clamp((v - baseline) / usable, 0, 1);
}

/**
 * Apply calibration offsets to a raw frame.
 *
 * Always called (even with calib == null) because it also establishes the
 * hip-translation contract: `hips.position` is converted from an absolute
 * solver position into an offset from the calibrated standing reference —
 * and zeroed when no body calibration exists, keeping the avatar planted.
 */
export function applyCalibration(
  frame: MocapFrame,
  calib: CalibrationData | null,
): MocapFrame {
  const body = calib?.body ?? null;

  const out: MocapFrame = {
    ...frame,
    head: calib ? subEuler(frame.head, calib.head) : frame.head,
    spine: body && frame.poseTracked ? subEuler(frame.spine, body.spine) : frame.spine,
    pupil: calib
      ? {
          x: clamp(frame.pupil.x - calib.pupil.x, -1, 1),
          y: clamp(frame.pupil.y - calib.pupil.y, -1, 1),
        }
      : frame.pupil,
    expressions: { ...frame.expressions },
    arms: { ...frame.arms },
    legs: { ...frame.legs },
    hips: {
      rotation:
        body && frame.poseTracked
          ? subEuler(frame.hips.rotation, body.hipsRotation)
          : frame.hips.rotation,
      position:
        body && frame.poseTracked
          ? {
              x: frame.hips.position.x - body.hipsPosition.x,
              y: frame.hips.position.y - body.hipsPosition.y,
              z: frame.hips.position.z - body.hipsPosition.z,
            }
          : { x: 0, y: 0, z: 0 },
    },
    hands: { ...frame.hands },
  };

  if (calib && calib.faceSampleCount > 0) {
    for (const k of ALL_EXPRESSION_KEYS) {
      out.expressions[k] = remapExpression(
        frame.expressions[k],
        calib.expressionBaseline[k],
      );
    }
  }

  if (body && frame.poseTracked) {
    for (const k of ARM_KEYS) {
      out.arms[k] = subEuler(frame.arms[k], body.arms[k]);
    }
    if (frame.legsTracked) {
      for (const k of LEG_KEYS) {
        out.legs[k] = subEuler(frame.legs[k], body.legs[k]);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Persistence — calibrating before every stream is tedious; keep the last
// calibration in localStorage (camera setups rarely move between sessions).

const STORAGE_KEY = "vtube.calibration.v2";

export function saveCalibration(data: CalibrationData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full / privacy mode — calibration just won't persist.
  }
}

export function loadCalibration(): CalibrationData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CalibrationData;
    // Minimal shape check: reject pre-v2 or corrupted payloads.
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!parsed.head || !parsed.expressionBaseline) return null;
    // Calibrations stored before the apparent-size bow estimator lack the
    // torso ratio; 0 = "not captured" (falls back to the running max).
    if (parsed.body && typeof parsed.body.torsoRatio !== "number") {
      parsed.body.torsoRatio = 0;
    }
    return { ...emptyCalibration(), ...parsed };
  } catch {
    return null;
  }
}

export function clearStoredCalibration(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
