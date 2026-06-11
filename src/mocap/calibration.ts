import {
  ARM_KEYS,
  EXPRESSION_KEYS,
  zeroEuler,
  zeroExpressions,
  type ArmRotations,
  type EulerRotation,
  type ExpressionValues,
  type MocapFrame,
} from "./types";
import { clamp } from "../utils/math";

/**
 * Neutral-pose calibration.
 *
 * Problem this solves (properly this time): nobody sits perfectly straight
 * and centered in front of their webcam, and no two webcams are mounted at
 * the same angle. Without calibration the avatar starts with a permanent
 * head tilt / lean / half-open mouth. The old prototype "snapped" the avatar
 * onto whatever the first frame happened to be; here we:
 *
 * 1. Record ~2 s of frames while the user holds a relaxed, neutral pose
 *    looking at the camera.
 * 2. Average the rotations -> those become zero-offsets (subtracted from all
 *    subsequent rotation output).
 * 3. Average the expression values -> those become per-channel baselines,
 *    and subsequent values are renormalized to use the remaining range:
 *        v' = (v - baseline) / (1 - baseline)
 *    e.g. if your resting face reads jawOpen = 0.15, the avatar's mouth now
 *    rests fully closed and still reaches 1.0 when you open wide.
 */

export const CALIBRATION_DURATION_MS = 2000;

export interface CalibrationData {
  head: EulerRotation;
  spine: EulerRotation;
  pupil: { x: number; y: number };
  arms: ArmRotations;
  expressionBaseline: ExpressionValues;
  sampleCount: number;
}

function subEuler(a: EulerRotation, b: EulerRotation): EulerRotation {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export class CalibrationRecorder {
  private samples: MocapFrame[] = [];
  private readonly startedAt: number;

  constructor(nowMs: number) {
    this.startedAt = nowMs;
  }

  /** Returns true while still recording. */
  add(frame: MocapFrame, nowMs: number): boolean {
    // Only frames with a tracked face are useful as a neutral baseline.
    if (frame.faceTracked) this.samples.push(frame);
    return nowMs - this.startedAt < CALIBRATION_DURATION_MS;
  }

  get progress(): number {
    return clamp(this.samples.length / 30, 0, 1);
  }

  finish(): CalibrationData | null {
    if (this.samples.length < 10) return null; // not enough tracked frames

    const n = this.samples.length;
    const data: CalibrationData = {
      head: zeroEuler(),
      spine: zeroEuler(),
      pupil: { x: 0, y: 0 },
      arms: {
        leftUpperArm: zeroEuler(),
        leftLowerArm: zeroEuler(),
        rightUpperArm: zeroEuler(),
        rightLowerArm: zeroEuler(),
      },
      expressionBaseline: zeroExpressions(),
      sampleCount: n,
    };

    let poseSamples = 0;
    for (const s of this.samples) {
      data.head.x += s.head.x / n;
      data.head.y += s.head.y / n;
      data.head.z += s.head.z / n;
      data.pupil.x += s.pupil.x / n;
      data.pupil.y += s.pupil.y / n;
      for (const k of EXPRESSION_KEYS) {
        data.expressionBaseline[k] += s.expressions[k] / n;
      }
      if (s.poseTracked) poseSamples++;
    }

    if (poseSamples > 5) {
      for (const s of this.samples) {
        if (!s.poseTracked) continue;
        data.spine.x += s.spine.x / poseSamples;
        data.spine.y += s.spine.y / poseSamples;
        data.spine.z += s.spine.z / poseSamples;
        // NOTE: we deliberately do NOT zero out upper-arm rotation entirely —
        // arms hanging at your sides are *supposed* to read as rotated from
        // the T-pose. We only remove the yaw/roll asymmetry caused by camera
        // placement (x stays untouched).
        for (const k of ARM_KEYS) {
          data.arms[k].y += s.arms[k].y / poseSamples;
        }
      }
    }

    // Blinks: a neutral baseline above ~0.4 means the user blinked during
    // calibration or tracking is bad; don't bake that in.
    data.expressionBaseline.blinkLeft = Math.min(data.expressionBaseline.blinkLeft, 0.4);
    data.expressionBaseline.blinkRight = Math.min(data.expressionBaseline.blinkRight, 0.4);

    return data;
  }
}

/** Remap an expression value so `baseline` becomes the new zero. */
function remapExpression(v: number, baseline: number): number {
  const usable = Math.max(1 - baseline, 0.05);
  return clamp((v - baseline) / usable, 0, 1);
}

/** Apply calibration offsets to a raw frame (no-op if calib is null). */
export function applyCalibration(
  frame: MocapFrame,
  calib: CalibrationData | null,
): MocapFrame {
  if (!calib) return frame;

  const out: MocapFrame = {
    ...frame,
    head: subEuler(frame.head, calib.head),
    spine: subEuler(frame.spine, calib.spine),
    pupil: {
      x: clamp(frame.pupil.x - calib.pupil.x, -1, 1),
      y: clamp(frame.pupil.y - calib.pupil.y, -1, 1),
    },
    expressions: { ...frame.expressions },
    arms: { ...frame.arms },
  };

  for (const k of EXPRESSION_KEYS) {
    out.expressions[k] = remapExpression(
      frame.expressions[k],
      calib.expressionBaseline[k],
    );
  }

  if (frame.poseTracked) {
    for (const k of ARM_KEYS) {
      out.arms[k] = {
        x: frame.arms[k].x,
        y: frame.arms[k].y - calib.arms[k].y,
        z: frame.arms[k].z,
      };
    }
  }

  return out;
}
