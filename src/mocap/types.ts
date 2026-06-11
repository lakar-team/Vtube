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

/**
 * The full 52 ARKit-style blendshape names that MediaPipe's FaceLandmarker
 * can output (`outputFaceBlendshapes: true`). Names match
 * `faceBlendshapes[0].categories[i].categoryName` exactly, and also match
 * the "Perfect Sync" custom expression names some VRoid/VRM exports use.
 *
 * (`_neutral` is intentionally excluded — it's not a drivable channel.)
 */
export const ARKIT_BLENDSHAPE_NAMES = [
  "browDownLeft",
  "browDownRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "cheekPuff",
  "cheekSquintLeft",
  "cheekSquintRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "eyeLookInLeft",
  "eyeLookInRight",
  "eyeLookOutLeft",
  "eyeLookOutRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeSquintLeft",
  "eyeSquintRight",
  "eyeWideLeft",
  "eyeWideRight",
  "jawForward",
  "jawLeft",
  "jawOpen",
  "jawRight",
  "mouthClose",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthFunnel",
  "mouthLeft",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthPucker",
  "mouthRight",
  "mouthRollLower",
  "mouthRollUpper",
  "mouthShrugLower",
  "mouthShrugUpper",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "noseSneerLeft",
  "noseSneerRight",
  "tongueOut",
] as const;

export type ArkitBlendshapeName = (typeof ARKIT_BLENDSHAPE_NAMES)[number];

/**
 * Every channel name that can appear in `MocapFrame.expressions`: the VRM
 * vowel/blink preset names we've always driven, plus the full raw ARKit
 * blendshape set. There is intentional overlap (e.g. `eyeBlinkLeft` vs
 * `blinkLeft`) — `expressions.blinkLeft` is our best-effort blink value
 * (blendshape with Kalidokit fallback, see kalidokitAdapter), while
 * `expressions.eyeBlinkLeft` is the raw MediaPipe blendshape passthrough
 * used for "Perfect Sync" models that expose that exact channel name.
 */
export const ALL_EXPRESSION_KEYS = [
  ...EXPRESSION_KEYS,
  ...ARKIT_BLENDSHAPE_NAMES,
] as const;

export type AllExpressionKey = (typeof ALL_EXPRESSION_KEYS)[number];

export type ExpressionValues = Record<AllExpressionKey, number>;

/**
 * VRM humanoid finger-bone "segments" (without the left/right prefix), per
 * the VRM humanoid spec. Thumb has Metacarpal/Proximal/Distal (no
 * intermediate); the other four fingers have Proximal/Intermediate/Distal.
 */
export const FINGER_SEGMENTS = [
  "thumbMetacarpal",
  "thumbProximal",
  "thumbDistal",
  "indexProximal",
  "indexIntermediate",
  "indexDistal",
  "middleProximal",
  "middleIntermediate",
  "middleDistal",
  "ringProximal",
  "ringIntermediate",
  "ringDistal",
  "littleProximal",
  "littleIntermediate",
  "littleDistal",
] as const;

export type FingerSegment = (typeof FINGER_SEGMENTS)[number];

/** Per-hand finger bone rotations, keyed by segment (sparse). */
export type HandRotations = Partial<Record<FingerSegment, EulerRotation>>;

export interface HandsFrame {
  left: HandRotations | null;
  right: HandRotations | null;
  leftTracked: boolean;
  rightTracked: boolean;
}

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
  hands: HandsFrame;
  confidence: { face: number; pose: number; leftHand: number; rightHand: number };
}

/** Raw landmark arrays kept around for the debug overlay. */
export interface DebugLandmarks {
  face: NormalizedLandmark[] | null;
  pose: NormalizedLandmark[] | null;
  leftHand: NormalizedLandmark[] | null;
  rightHand: NormalizedLandmark[] | null;
}

export function zeroEuler(): EulerRotation {
  return { x: 0, y: 0, z: 0 };
}

export function zeroExpressions(): ExpressionValues {
  const out = {} as ExpressionValues;
  for (const k of ALL_EXPRESSION_KEYS) out[k] = 0;
  return out;
}

export function emptyHandsFrame(): HandsFrame {
  return { left: null, right: null, leftTracked: false, rightTracked: false };
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
    hands: emptyHandsFrame(),
    confidence: { face: 0, pose: 0, leftHand: 0, rightHand: 0 },
  };
}
