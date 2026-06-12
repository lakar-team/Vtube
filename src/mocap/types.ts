import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

/** Euler rotation in radians, XYZ order (matches Kalidokit output). */
export interface EulerRotation {
  x: number;
  y: number;
  z: number;
}

/**
 * How torso pitch (bowing) is estimated — see kalidokitAdapter.
 * - "z":      geometric pitch from MediaPipe's world-landmark depth. Direct,
 *             but monocular z is heavily compressed so deep bows underread.
 * - "size":   image-space foreshortening (apparent hip->shoulder distance vs
 *             shoulder width — the classic apparent-size monocular depth cue).
 *             Robust magnitude, needs an upright reference ratio.
 * - "hybrid": whichever of the two reports the larger magnitude (default).
 */
export const TORSO_PITCH_SOURCES = ["hybrid", "size", "z"] as const;
export type TorsoPitchSource = (typeof TORSO_PITCH_SOURCES)[number];

/** Live internals of the torso-pitch estimators, for the debug HUD. */
export interface SpinePitchDebug {
  /** Pitch (rad) from the world-landmark z estimator. */
  worldPitch: number;
  /** Pitch (rad) from the apparent-size (foreshortening) estimator. */
  sizePitch: number;
  /** Measured torso length / shoulder width (image space). */
  ratio: number;
  /** Upright reference ratio in use (0 = none yet). */
  refRatio: number;
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
  /**
   * Wrist (VRM `leftHand`/`rightHand` bone) rotations. Solved from the hand
   * landmarks (Kalidokit `Hand.solve` -> `${side}Wrist`), with the up/down
   * component reinforced by the pose solver's `LeftHand`/`RightHand` output
   * when the pose is tracked.
   */
  leftWrist: EulerRotation | null;
  rightWrist: EulerRotation | null;
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

export interface LegRotations {
  leftUpperLeg: EulerRotation;
  leftLowerLeg: EulerRotation;
  rightUpperLeg: EulerRotation;
  rightLowerLeg: EulerRotation;
}

export const LEG_KEYS = [
  "leftUpperLeg",
  "leftLowerLeg",
  "rightUpperLeg",
  "rightLowerLeg",
] as const;

export type LegKey = (typeof LEG_KEYS)[number];

/**
 * Hips solve output.
 * - rotation: hip yaw/roll from the 3D hip line (radians, Kalidokit space).
 * - position: rough hip translation in solver space. x = lateral offset from
 *   image center, y = vertical offset (our own estimate from the image-space
 *   hip height; Kalidokit leaves y at 0), z = depth proxy derived from the
 *   apparent spine length (closer to camera = longer spine = larger z).
 *   These are RELATIVE units, only meaningful against a calibrated reference
 *   (see calibration.ts body calibration); the rig layer applies
 *   (position - reference) * scale to the hips bone.
 */
export interface HipsFrame {
  rotation: EulerRotation;
  position: { x: number; y: number; z: number };
}

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
  /** Lower body (hips/knees/ankles) visible enough to drive legs. */
  legsTracked: boolean;
  head: EulerRotation;
  spine: EulerRotation;
  pupil: { x: number; y: number };
  expressions: ExpressionValues;
  arms: ArmRotations;
  /**
   * Per-arm landmark visibility gate (avatar frame, same sides as `arms`).
   * A hand thrust at the lens occludes its own arm; the occluded side flails
   * while the other arm is still perfectly tracked, so arms gate separately.
   */
  armsTracked: { left: boolean; right: boolean };
  legs: LegRotations;
  hips: HipsFrame;
  hands: HandsFrame;
  /**
   * Measured torso length / shoulder width in image space (0 when pose is
   * untracked). Captured during body calibration as the upright reference
   * for the apparent-size torso-pitch estimator.
   */
  torsoRatio: number;
  /** Torso-pitch estimator internals for the HUD (null when pose untracked). */
  spineDebug: SpinePitchDebug | null;
  confidence: { face: number; pose: number; legs: number; leftHand: number; rightHand: number };
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
  return {
    left: null,
    right: null,
    leftWrist: null,
    rightWrist: null,
    leftTracked: false,
    rightTracked: false,
  };
}

export function zeroLegs(): LegRotations {
  return {
    leftUpperLeg: zeroEuler(),
    leftLowerLeg: zeroEuler(),
    rightUpperLeg: zeroEuler(),
    rightLowerLeg: zeroEuler(),
  };
}

export function zeroHips(): HipsFrame {
  return { rotation: zeroEuler(), position: { x: 0, y: 0, z: 0 } };
}

export function emptyFrame(t = 0): MocapFrame {
  return {
    t,
    faceTracked: false,
    poseTracked: false,
    legsTracked: false,
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
    armsTracked: { left: false, right: false },
    legs: zeroLegs(),
    hips: zeroHips(),
    hands: emptyHandsFrame(),
    torsoRatio: 0,
    spineDebug: null,
    confidence: { face: 0, pose: 0, legs: 0, leftHand: 0, rightHand: 0 },
  };
}
