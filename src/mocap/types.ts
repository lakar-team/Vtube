import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

/** Euler rotation in radians, XYZ order (matches Kalidokit output). */
export interface EulerRotation {
  x: number;
  y: number;
  z: number;
}

/** VRM expression channels we drive (VRM 1.0 preset names). */
export const EXPRESSION_KEYS = [
  "blinkLeft",
  "blinkRight",
  "aa",
  "ih",
  "ou",
  "ee",
  "oh",
] as const;

export type ExpressionKey = (typeof EXPRESSION_KEYS)[number];

export type ExpressionValues = Record<ExpressionKey, number>;

export interface ArmRotations {
  leftUpperArm: EulerRotation;
  leftLowerArm: EulerRotation;
  rightUpperArm: EulerRotation;
  rightLowerArm: EulerRotation;
}

export const ARM_KEYS = [
  "leftUpperArm",
  "leftLowerArm",
  "rightUpperArm",
  "rightLowerArm",
] as const;

export type ArmKey = (typeof ARM_KEYS)[number];

/**
 * One fully-solved mocap frame, in VRM-ready units:
 * - rotations: radians, Kalidokit conventions (sign-mapped onto bones later)
 * - expressions: 0..1 weights using VRM preset names
 * - pupil: -1..1 horizontal/vertical gaze offset
 */
export interface MocapFrame {
  /** Seconds (performance.now() / 1000). */
  t: number;
  faceTracked: boolean;
  poseTracked: boolean;
  head: EulerRotation;
  spine: EulerRotation;
  pupil: { x: number; y: number };
  expressions: ExpressionValues;
  arms: ArmRotations;
  confidence: { face: number; pose: number };
}

/** Raw landmark arrays kept around for the debug overlay. */
export interface DebugLandmarks {
  face: NormalizedLandmark[] | null;
  pose: NormalizedLandmark[] | null;
}

export function zeroEuler(): EulerRotation {
  return { x: 0, y: 0, z: 0 };
}

export function zeroExpressions(): ExpressionValues {
  return { blinkLeft: 0, blinkRight: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
}

export function emptyFrame(t = 0): MocapFrame {
  return {
    t,
    faceTracked: false,
    poseTracked: false,
    head: zeroEuler(),
    spine: zeroEuler(),
    pupil: { x: 0, y: 0 },
    expressions: zeroExpressions(),
    arms: {
      leftUpperArm: zeroEuler(),
      leftLowerArm: zeroEuler(),
      rightUpperArm: zeroEuler(),
      rightLowerArm: zeroEuler(),
    },
    confidence: { face: 0, pose: 0 },
  };
}
