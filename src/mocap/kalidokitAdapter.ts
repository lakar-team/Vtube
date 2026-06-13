import type {
  FaceLandmarkerResult,
  HandLandmarkerResult,
  NormalizedLandmark,
  PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { Face, Hand, Pose } from "kalidokit";
import {
  ARKIT_BLENDSHAPE_NAMES,
  emptyFrame,
  zeroEuler,
  type ArkitBlendshapeName,
  type DebugLandmarks,
  type EulerRotation,
  type FingerSegment,
  type HandRotations,
  type MocapFrame,
  type PitchCalibration,
  type TorsoPitchSource,
} from "./types";
import { clamp } from "../utils/math";

/**
 * Kalidokit adapter for @mediapipe/tasks-vision results.
 *
 * QUIRK — Kalidokit predates tasks-vision. It was written against the older
 * @mediapipe/holistic API, whose `runtime: "mediapipe"` mode expects:
 *   Face.solve(faceLandmarks468+, { runtime, video })
 *   Pose.solve(poseWorldLandmarks, poseImageLandmarks, { runtime, video })
 * Fortunately the tasks-vision output is shape-compatible:
 *   - faceResult.faceLandmarks[0]  -> 478 normalized {x,y,z} points
 *     (holistic produced 468; Kalidokit only indexes points that exist in
 *     both sets, so the extra iris points are harmless — and iris tracking
 *     still works because tasks-vision face model includes them).
 *   - poseResult.worldLandmarks[0] -> 33 metric {x,y,z,visibility} points
 *     (equivalent to holistic's `poseWorldLandmarks` / `za`).
 *   - poseResult.landmarks[0]      -> 33 normalized {x,y,z,visibility}.
 * Kalidokit's TypeScript types are stricter than its runtime needs, hence
 * the casts below.
 *
 * SIDE / MIRROR CONVENTION (important — verified against Kalidokit source):
 * Kalidokit's solvers are "pre-mirrored": their output is meant to be applied
 * DIRECTLY to the avatar for mirror behaviour (avatar acts as your
 * reflection). Proof from kalidokit/dist/PoseSolver/calcArms.js: its
 * `UpperArm.r` is computed from landmarks 11/13 — MediaPipe's LEFT shoulder/
 * elbow. The subject's left arm drives the rig's RIGHT arm, i.e. the on-screen
 * mirror side. Legs are the same (calcLegs uses 23/25 for the "right" leg).
 *
 * HANDS: HandLandmarker's `handedness` labels do NOT follow the old holistic
 * "labels assume a mirrored selfie image" rule — on our unmirrored video,
 * tasks-vision reports the subject's anatomical side (label "Left" = your
 * left hand; verified empirically — trusting the holistic rule put every
 * hand on the opposite avatar side from its pose-driven arm). To be robust
 * against either convention we don't trust the label when a pose is tracked:
 * each detected hand is matched to the nearest pose wrist landmark (15 =
 * subject left, 16 = subject right) in image space. The label is only the
 * fallback when the pose isn't visible. A subject-LEFT hand then drives the
 * avatar's RIGHT side — the same pre-mirrored convention as the pose arms.
 *
 * So: with `mirror: true` (the default VTuber UX) every Kalidokit output is
 * used AS-IS. With `mirror: false` we swap left/right pairs and mirror each
 * euler (flip yaw/roll). Earlier revisions had this backwards for the body
 * (swapped when mirroring), which un-mirrored arms/hands relative to the
 * face and made tracked movement look inverted.
 *
 * The 52 MediaPipe blendshapes are the exception: their names are in the
 * SUBJECT's anatomical frame (eyeBlinkLeft = your left eye), so they swap on
 * `mirror: true` instead.
 */

type KalidokitLandmarks = Parameters<typeof Face.solve>[0];
type KalidokitHandLandmarks = Parameters<typeof Hand.solve>[0];

const UPPER_BODY_POSE_INDICES = [11, 12, 13, 14, 15, 16] as const; // shoulders/elbows/wrists
const LOWER_BODY_POSE_INDICES = [23, 24, 25, 26, 27, 28] as const; // hips/knees/ankles

/** Min mean visibility of hips/knees/ankles before we trust leg solving. */
const LEG_VISIBILITY_THRESHOLD = 0.6;

/**
 * Min weighted visibility score for one arm's shoulder/elbow/wrist chain to
 * drive that arm. Shoulder and elbow dominate (0.5/0.35); wrist contributes
 * only 0.15 so a wrist occluded at face level can't disable the whole arm.
 * Lowered from 0.55 so extreme arm positions (raised to face, behind head)
 * don't drop out when the wrist landmark has reduced visibility.
 */
const ARM_VISIBILITY_THRESHOLD = 0.40;

/**
 * Max image-space distance (in image-height units, aspect-corrected) between
 * a detected hand's wrist and the nearest pose wrist before we distrust the
 * geometric side match and fall back to the handedness label. A hand shoved
 * at the lens can detach visually from its (occluded, hallucinated) pose arm.
 */
const HAND_ANCHOR_MAX_DIST = 0.35;

/**
 * When a hand's bounding-box diagonal exceeds this multiple of the shoulder
 * width it is very close to the lens: the palm-plane wrist solve degrades
 * badly there, so the wrist is dropped (eases back) while fingers — which
 * Kalidokit solves scale-free — are kept.
 */
const HAND_SIZE_WRIST_LIMIT = 1.3;

/** Absolute fallback for the same check when no pose is tracked. */
const HAND_SIZE_ABS_LIMIT = 0.55;

function mirrorEuler(e: EulerRotation): EulerRotation {
  // Mirroring about the vertical axis flips yaw and roll, keeps pitch.
  return { x: e.x, y: -e.y, z: -e.z };
}

function midpoint3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/**
 * Maps VRM humanoid finger-bone segment names to the corresponding key
 * suffix in Kalidokit's `Hand.solve` result (e.g. result[`${side}IndexProximal`]).
 * The thumb is special-cased: Kalidokit's 3-segment thumb
 * (Proximal/Intermediate/Distal) maps onto VRM's
 * Metacarpal/Proximal/Distal.
 */
const FINGER_KALIDOKIT_SUFFIX: Record<FingerSegment, string> = {
  thumbMetacarpal: "ThumbProximal",
  thumbProximal: "ThumbIntermediate",
  thumbDistal: "ThumbDistal",
  indexProximal: "IndexProximal",
  indexIntermediate: "IndexIntermediate",
  indexDistal: "IndexDistal",
  middleProximal: "MiddleProximal",
  middleIntermediate: "MiddleIntermediate",
  middleDistal: "MiddleDistal",
  ringProximal: "RingProximal",
  ringIntermediate: "RingIntermediate",
  ringDistal: "RingDistal",
  littleProximal: "LittleProximal",
  littleIntermediate: "LittleIntermediate",
  littleDistal: "LittleDistal",
};

interface SolvedHand {
  fingers: HandRotations;
  wrist: EulerRotation | null;
}

/**
 * Solve one hand's 21 landmarks via Kalidokit and remap onto VRM finger-bone
 * segment names plus the wrist. `side` is the AVATAR side in mirror
 * convention (the subject's left hand solves as "Right" — see header
 * comment); un-mirroring (if any) is applied afterwards by the caller.
 */
function solveHand(
  landmarks: KalidokitHandLandmarks,
  side: "Left" | "Right",
): SolvedHand {
  const rigged = Hand.solve(landmarks, side) as unknown as Record<
    string,
    EulerRotation | undefined
  > | null;

  const out: SolvedHand = { fingers: {}, wrist: null };
  if (!rigged) return out;

  for (const segment of Object.keys(FINGER_KALIDOKIT_SUFFIX) as FingerSegment[]) {
    const key = `${side}${FINGER_KALIDOKIT_SUFFIX[segment]}`;
    const rot = rigged[key];
    if (rot) out.fingers[segment] = { x: rot.x, y: rot.y, z: rot.z };
  }

  const wrist = rigged[`${side}Wrist`];
  if (wrist) out.wrist = { x: wrist.x, y: wrist.y, z: wrist.z };

  return out;
}

function mirrorHand(hand: HandRotations): HandRotations {
  const out: HandRotations = {};
  for (const segment of Object.keys(hand) as FingerSegment[]) {
    const rot = hand[segment];
    if (rot) out[segment] = mirrorEuler(rot);
  }
  return out;
}

/**
 * Mirror left/right-paired ARKit + VRM-preset expression channels in place.
 * Any channel name ending in "Left" that has a "...Right" counterpart gets
 * swapped (covers blinkLeft/blinkRight, browDownLeft/Right,
 * eyeLookInLeft/Right, etc).
 */
function mirrorExpressions(expr: MocapFrame["expressions"]): void {
  for (const key of Object.keys(expr) as ArkitBlendshapeName[]) {
    if (!key.endsWith("Left")) continue;
    const rightKey = (key.slice(0, -4) + "Right") as keyof MocapFrame["expressions"];
    if (!(rightKey in expr)) continue;
    const tmp = expr[key as keyof MocapFrame["expressions"]];
    expr[key as keyof MocapFrame["expressions"]] = expr[rightKey];
    expr[rightKey] = tmp;
  }
}

export interface SolveOptions {
  /** Mirror mode: avatar behaves like your reflection (default UX). */
  mirror: boolean;
  /** Solve legs/hips from the lower-body landmarks when visible. */
  trackLegs: boolean;
  /** Which torso-pitch (bow) estimator to use. */
  torsoPitchSource: TorsoPitchSource;
  /**
   * Upright reference for the apparent-size pitch estimator: torso length /
   * shoulder width while standing straight (from body calibration, or a
   * running max maintained by useMocap). null = no reference yet, size
   * estimator stays at 0.
   */
  refTorsoRatio: number | null;
  /**
   * Per-user bow calibration (center + gains) from the body pose sequence.
   * null = uncalibrated: center 0, gains 1 (raw estimator output).
   */
  pitchCalib: PitchCalibration | null;
  /** Timestamp in seconds. */
  t: number;
}

/**
 * Magnitude of the apparent-size (foreshortening) pitch estimate for a
 * measured torso ratio against the upright reference, including the soft
 * knee that keeps acos's infinite slope at 1 from turning resting jitter
 * into degrees of pitch. Shared with calibration.ts, which inverts this
 * mapping at the bow pose to derive the per-user size gain.
 */
export function apparentSizePitchMag(ratio: number, refRatio: number): number {
  let mag = Math.acos(clamp(ratio / refRatio, 0, 1));
  const KNEE = 0.25;
  if (mag < KNEE) mag = (mag * mag) / KNEE;
  return mag;
}

export interface SolveResult {
  frame: MocapFrame;
  debug: DebugLandmarks;
}

export function solveMocapFrame(
  faceResult: FaceLandmarkerResult | null,
  poseResult: PoseLandmarkerResult | null,
  handResult: HandLandmarkerResult | null,
  video: HTMLVideoElement,
  { mirror, trackLegs, torsoPitchSource, refTorsoRatio, pitchCalib, t }: SolveOptions,
): SolveResult {
  const frame = emptyFrame(t);
  const debug: DebugLandmarks = { face: null, pose: null, leftHand: null, rightHand: null };

  // Wrist up/down (z) from the pose solver — it sees the whole forearm so
  // it's steadier than the hand solver's palm-plane estimate. Captured in the
  // pose section, blended into the wrists after the hand section (the same
  // split the Kalidokit reference rig uses).
  let poseHandZ: { left: number; right: number } | null = null;

  // ---------------------------------------------------------------- face
  const faceLm = faceResult?.faceLandmarks?.[0];
  const blendCategories = faceResult?.faceBlendshapes?.[0]?.categories;

  if (faceLm && faceLm.length > 0) {
    debug.face = faceLm;

    // Blendshape lookup: categoryName -> score (0..1).
    const blend = new Map<string, number>();
    if (blendCategories) {
      for (const c of blendCategories) blend.set(c.categoryName, c.score);
    }

    const riggedFace = Face.solve(faceLm as unknown as KalidokitLandmarks, {
      runtime: "mediapipe",
      video,
      // We do our own smoothing (One Euro) and use MediaPipe's blendshape
      // blinks, so disable Kalidokit's internal blink stabilization.
      smoothBlink: false,
    });

    if (riggedFace) {
      frame.faceTracked = true;
      frame.head = {
        x: riggedFace.head.x,
        y: riggedFace.head.y,
        z: riggedFace.head.z,
      };
      frame.pupil = {
        x: clamp(riggedFace.pupil.x, -1, 1),
        y: clamp(riggedFace.pupil.y, -1, 1),
      };

      // Mouth vowels from Kalidokit (designed for VRM aa/ih/ou/ee/oh)...
      const shape = riggedFace.mouth.shape;
      frame.expressions.aa = clamp(shape.A, 0, 1);
      frame.expressions.ih = clamp(shape.I, 0, 1);
      frame.expressions.ou = clamp(shape.U, 0, 1);
      frame.expressions.ee = clamp(shape.E, 0, 1);
      frame.expressions.oh = clamp(shape.O, 0, 1);

      // ...but blinks from MediaPipe's ARKit blendshapes, which are far more
      // robust than landmark-distance blinks (glasses, head tilt, lighting).
      // Fall back to Kalidokit's eye solve if blendshapes are missing.
      const blinkL = blend.get("eyeBlinkLeft");
      const blinkR = blend.get("eyeBlinkRight");
      // NOTE on sides: MediaPipe blendshape names are in the SUBJECT's frame
      // (eyeBlinkLeft = your anatomical left eye). Kalidokit eye.l/r are in
      // image space. We keep subject frame here; mirroring is handled below.
      frame.expressions.blinkLeft =
        blinkL !== undefined ? clamp(blinkL, 0, 1) : clamp(1 - riggedFace.eye.l, 0, 1);
      frame.expressions.blinkRight =
        blinkR !== undefined ? clamp(blinkR, 0, 1) : clamp(1 - riggedFace.eye.r, 0, 1);

      // Reinforce jaw-open with the dedicated blendshape (Kalidokit's A is
      // derived from lip distance and can underestimate with beards).
      const jawOpen = blend.get("jawOpen");
      if (jawOpen !== undefined) {
        frame.expressions.aa = clamp(Math.max(frame.expressions.aa, jawOpen * 0.9), 0, 1);
      }

      // Full 52-channel ARKit blendshape passthrough — raw 0..1 values from
      // MediaPipe, in the subject's anatomical frame. These drive eyebrows,
      // cheeks, tongue, jaw direction, etc on models that expose matching
      // VRM 1.0 expressions / "Perfect Sync" custom expressions
      // (see vrm/expressionMap.ts). Models without these channels simply
      // never get a mapping for them — no-op.
      for (const name of ARKIT_BLENDSHAPE_NAMES) {
        const score = blend.get(name);
        if (score !== undefined) frame.expressions[name] = clamp(score, 0, 1);
      }

      frame.confidence.face = 1;
    }
  }

  // ---------------------------------------------------------------- pose
  const poseWorld = poseResult?.worldLandmarks?.[0];
  const poseImage = poseResult?.landmarks?.[0];

  if (poseWorld && poseImage && poseWorld.length >= 33) {
    debug.pose = poseImage;

    // Tracking confidence: mean visibility of the upper-body joints we use.
    let vis = 0;
    for (const i of UPPER_BODY_POSE_INDICES) {
      vis += poseImage[i]?.visibility ?? 0;
    }
    frame.confidence.pose = vis / UPPER_BODY_POSE_INDICES.length;

    // Separate confidence for the lower body: a seated webcam user has
    // perfectly good arm tracking while hips/knees are out of frame.
    let legVis = 0;
    for (const i of LOWER_BODY_POSE_INDICES) {
      legVis += poseImage[i]?.visibility ?? 0;
    }
    frame.confidence.legs = legVis / LOWER_BODY_POSE_INDICES.length;
    const legsVisible = trackLegs && frame.confidence.legs > LEG_VISIBILITY_THRESHOLD;

    const riggedPose = Pose.solve(
      poseWorld as unknown as Parameters<typeof Pose.solve>[0],
      poseImage as unknown as Parameters<typeof Pose.solve>[1],
      {
        runtime: "mediapipe",
        video,
        // Leg solving from a desk camera produces garbage, so it's gated on
        // lower-body visibility (and the user's toggle).
        enableLegs: legsVisible,
      },
    );

    if (riggedPose && frame.confidence.pose > 0.5) {
      frame.poseTracked = true;
      // Kalidokit hard-zeroes Spine.x and Hips.rotation.x ("temp fix for
      // inaccurate X axis" in its calcHips), so a bow never reached the torso
      // — only the head/neck bent. We recover torso pitch ourselves, two ways:
      //
      // 1. "z" — geometric pitch of the world-landmark hip->shoulder vector.
      //    World y grows downward and z shrinks toward the camera, so bowing
      //    forward drives dz negative; atan2 is 0 upright and negative when
      //    bowing, matching the head.x convention (pitch down = negative) so
      //    the same per-model sign mapping applies downstream. |dy| is used
      //    so a flipped y convention can't pin the angle at the clamp.
      //    Weakness: monocular z is heavily compressed — deep bows underread.
      //
      // 2. "size" — image-space foreshortening: bowing shrinks the apparent
      //    hip->shoulder distance while shoulder width stays constant, so
      //    pitch ≈ acos(ratio / uprightRatio). Both lengths scale together
      //    with camera distance, so stepping closer doesn't read as a bow.
      //    Direction is borrowed from the z estimator (foreshortening alone
      //    can't tell forward from backward). Torso yaw shrinks the shoulder
      //    width, INFLATING the ratio — which clamps to 0 pitch, a safe
      //    failure (no false bows while turned).
      const shoulderMid = midpoint3(poseWorld[11], poseWorld[12]);
      const hipMid = midpoint3(poseWorld[23], poseWorld[24]);
      const worldPitchRaw = clamp(
        Math.atan2(
          shoulderMid.z - hipMid.z,
          Math.abs(shoulderMid.y - hipMid.y),
        ),
        -1.6,
        1.6,
      );
      // Calibration: subtract the upright reading (camera-angle bias) and
      // scale by the measured-bow gain (monocular z compression).
      const worldPitch = clamp(
        (worldPitchRaw - (pitchCalib?.worldCenter ?? 0)) *
          (pitchCalib?.worldGain ?? 1),
        -1.6,
        1.6,
      );

      // Image-space lengths in image-height units (x re-scaled by aspect so
      // horizontal and vertical distances are commensurable).
      const aspect = (video.videoWidth || 640) / (video.videoHeight || 480);
      const dist2d = (
        a: { x: number; y: number },
        b: { x: number; y: number },
      ) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
      const shoulderWidth = dist2d(poseImage[11], poseImage[12]);
      const torsoLen = dist2d(
        midpoint3(poseImage[11], poseImage[12]),
        midpoint3(poseImage[23], poseImage[24]),
      );
      frame.torsoRatio = shoulderWidth > 1e-4 ? torsoLen / shoulderWidth : 0;

      let sizePitch = 0;
      if (refTorsoRatio && refTorsoRatio > 0.2 && frame.torsoRatio > 0) {
        const mag =
          apparentSizePitchMag(frame.torsoRatio, refTorsoRatio) *
          (pitchCalib?.sizeGain ?? 1);
        // Foreshortening alone can't tell forward from backward — borrow the
        // direction from the (calibrated) world-z estimator.
        sizePitch = clamp(worldPitch <= 0 ? -mag : mag, -1.4, 1.4);
      }

      const torsoPitch =
        torsoPitchSource === "z"
          ? worldPitch
          : torsoPitchSource === "size"
            ? sizePitch
            : Math.abs(sizePitch) > Math.abs(worldPitch)
              ? sizePitch
              : worldPitch;

      frame.spineDebug = {
        worldPitch,
        sizePitch,
        worldPitchRaw,
        ratio: frame.torsoRatio,
        refRatio: refTorsoRatio ?? 0,
      };

      // Per-arm gating (see types.ts). Mirror convention: frame.arms.left*
      // is solved from the subject's RIGHT arm landmarks (12/14/16) and
      // vice versa, so the gates pair up the same way.
      // Weighted: shoulder 0.50, elbow 0.35, wrist 0.15. The wrist is often
      // occluded when the arm is raised to face height or behind the head;
      // giving it only 15% weight keeps the arm tracked from shoulder+elbow.
      const armVis = (s: number, e: number, w: number) =>
        (poseImage[s]?.visibility ?? 0) * 0.50 +
        (poseImage[e]?.visibility ?? 0) * 0.35 +
        (poseImage[w]?.visibility ?? 0) * 0.15;
      frame.armsTracked = {
        left: armVis(12, 14, 16) > ARM_VISIBILITY_THRESHOLD,
        right: armVis(11, 13, 15) > ARM_VISIBILITY_THRESHOLD,
      };

      frame.spine = {
        x: torsoPitch,
        y: riggedPose.Spine.y,
        z: riggedPose.Spine.z,
      };
      frame.arms = {
        leftUpperArm: { ...riggedPose.LeftUpperArm },
        leftLowerArm: { ...riggedPose.LeftLowerArm },
        rightUpperArm: { ...riggedPose.RightUpperArm },
        rightLowerArm: { ...riggedPose.RightLowerArm },
      };

      // Hips: rotation from the 3D hip line; position is a rough translation
      // estimate — x from where the hips sit in the image, z from the
      // apparent spine length (Kalidokit's depth proxy: walking toward the
      // camera grows the spine in image space). We add our own y from the
      // image-space hip height so crouches/jumps translate the avatar.
      // All of it is relative — the rig layer only applies it against a
      // body-calibrated reference position.
      poseHandZ = {
        left: riggedPose.LeftHand.z,
        right: riggedPose.RightHand.z,
      };

      const hipsRot = riggedPose.Hips.rotation ?? zeroEuler();
      const hipCenterY =
        ((poseImage[23]?.y ?? 0.5) + (poseImage[24]?.y ?? 0.5)) / 2;
      frame.hips = {
        rotation: { x: hipsRot.x, y: hipsRot.y, z: hipsRot.z },
        position: {
          x: riggedPose.Hips.position.x,
          // Image y grows downward; flip so "up" is positive.
          y: -(hipCenterY - 0.5),
          z: riggedPose.Hips.position.z,
        },
      };

      if (legsVisible) {
        frame.legsTracked = true;
        frame.legs = {
          leftUpperLeg: { ...riggedPose.LeftUpperLeg },
          leftLowerLeg: { ...riggedPose.LeftLowerLeg },
          rightUpperLeg: { ...riggedPose.RightUpperLeg },
          rightLowerLeg: { ...riggedPose.RightLowerLeg },
        };
      }
    }
  }

  // ---------------------------------------------------------------- hands
  const handLm = handResult?.landmarks;
  const handedness = handResult?.handedness;
  if (handLm && handedness) {
    // Pose wrist anchors for geometric side matching (see header comment) —
    // image space, same coordinates as the hand landmarks. Each side is
    // usable independently (one wrist can be occluded by its own hand).
    const aspect = (video.videoWidth || 640) / (video.videoHeight || 480);
    const poseWristL = poseImage?.[15]; // subject's anatomical LEFT wrist
    const poseWristR = poseImage?.[16]; // subject's anatomical RIGHT wrist
    // Lower threshold (was 0.5): when the arm is raised, the pose wrist
    // landmark near the face often has reduced visibility; still usable as an
    // anchor for side-matching even at moderate confidence.
    const usable = (p: NormalizedLandmark | undefined) =>
      frame.poseTracked && p != null && (p.visibility ?? 0) > 0.35 ? p : null;
    const anchorL = usable(poseWristL);
    const anchorR = usable(poseWristR);

    const dist = (a: NormalizedLandmark, b: NormalizedLandmark) =>
      Math.hypot((a.x - b.x) * aspect, a.y - b.y);

    // Shoulder width (image space) for the oversized-hand check.
    const shoulderW =
      frame.poseTracked && poseImage
        ? dist(poseImage[11], poseImage[12])
        : 0;

    const detected: Array<{
      lm: NormalizedLandmark[];
      score: number;
      /** Handedness label says subject-left (anatomical on unmirrored video). */
      labelLeft: boolean;
      dL: number;
      dR: number;
      /** Geometric match is close enough to trust over the label. */
      anchored: boolean;
    }> = [];
    for (let i = 0; i < handLm.length; i++) {
      const lm = handLm[i];
      const label = handedness[i]?.[0]?.categoryName;
      const score = handedness[i]?.[0]?.score ?? 0;
      if (!lm || lm.length < 21) continue;
      if (label !== "Left" && label !== "Right") continue;
      const dL = anchorL ? dist(lm[0], anchorL) : Number.POSITIVE_INFINITY;
      const dR = anchorR ? dist(lm[0], anchorR) : Number.POSITIVE_INFINITY;
      detected.push({
        lm,
        score,
        labelLeft: label === "Left",
        dL,
        dR,
        anchored: Math.min(dL, dR) <= HAND_ANCHOR_MAX_DIST,
      });
    }

    // Which subject side is each hand? With two hands and both pose wrists
    // trustworthy, pick the joint assignment with the smaller total wrist
    // distance so the two hands can never land on the same side.
    let subjectLeft: boolean[];
    if (detected.length === 2 && detected[0].anchored && detected[1].anchored) {
      subjectLeft =
        detected[0].dL + detected[1].dR <= detected[0].dR + detected[1].dL
          ? [true, false]
          : [false, true];
    } else {
      subjectLeft = detected.map((h) => (h.anchored ? h.dL <= h.dR : h.labelLeft));
    }

    for (let i = 0; i < detected.length; i++) {
      const { lm, score } = detected[i];
      // Mirror convention (as-is application): the subject's LEFT hand drives
      // the avatar's RIGHT side — the same side of the screen, matching the
      // pre-mirrored pose-solver arms.
      const avatarSide = subjectLeft[i] ? "Right" : "Left";
      const { fingers, wrist: solvedWrist } = solveHand(
        lm as unknown as KalidokitHandLandmarks,
        avatarSide,
      );

      // Oversized hand = very close to the lens: the palm-plane wrist solve
      // is noise there, so drop it (the rig eases the wrist back) but keep
      // the fingers, which Kalidokit solves scale-free.
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const p of lm) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const handDiag = Math.hypot((maxX - minX) * aspect, maxY - minY);
      const tooClose =
        shoulderW > 1e-4
          ? handDiag > shoulderW * HAND_SIZE_WRIST_LIMIT
          : handDiag > HAND_SIZE_ABS_LIMIT;
      const wrist = tooClose ? null : solvedWrist;

      if (avatarSide === "Left") {
        debug.leftHand = lm;
        frame.hands.left = fingers;
        frame.hands.leftWrist = wrist;
        frame.hands.leftTracked = true;
        frame.confidence.leftHand = score;
      } else {
        debug.rightHand = lm;
        frame.hands.right = fingers;
        frame.hands.rightWrist = wrist;
        frame.hands.rightTracked = true;
        frame.confidence.rightHand = score;
      }
    }
  }

  // Wrist z (waving the hand left/right about the forearm axis): the hand
  // solver's own z is a coarse palm-plane estimate scaled ~2.3x, which the
  // Kalidokit reference rig discards entirely in favour of the pose solver's
  // forearm-based value. Same here: pose z when tracked, neutral otherwise.
  // Pose "LeftHand" is the avatar-left side (subject's right hand), matching
  // frame.hands.left — both pre-mirrored, so they pair directly. The pose z
  // is only trusted while that arm's landmarks are visible (an occluded
  // forearm produces hallucinated values).
  if (frame.hands.leftWrist) {
    frame.hands.leftWrist.z = frame.armsTracked.left ? poseHandZ?.left ?? 0 : 0;
  }
  if (frame.hands.rightWrist) {
    frame.hands.rightWrist.z = frame.armsTracked.right ? poseHandZ?.right ?? 0 : 0;
  }

  // -------------------------------------------------------------- mirror
  //
  // Kalidokit pose/hand/face output and MediaPipe handedness labels are
  // already in mirror convention (see header comment). mirror === true means
  // "use as-is". mirror === false un-mirrors: swap every left/right pair and
  // flip yaw/roll on every rotation.
  if (!mirror) {
    frame.head = mirrorEuler(frame.head);
    frame.spine = mirrorEuler(frame.spine);

    frame.arms = {
      leftUpperArm: mirrorEuler(frame.arms.rightUpperArm),
      leftLowerArm: mirrorEuler(frame.arms.rightLowerArm),
      rightUpperArm: mirrorEuler(frame.arms.leftUpperArm),
      rightLowerArm: mirrorEuler(frame.arms.leftLowerArm),
    };
    frame.armsTracked = {
      left: frame.armsTracked.right,
      right: frame.armsTracked.left,
    };

    frame.legs = {
      leftUpperLeg: mirrorEuler(frame.legs.rightUpperLeg),
      leftLowerLeg: mirrorEuler(frame.legs.rightLowerLeg),
      rightUpperLeg: mirrorEuler(frame.legs.leftUpperLeg),
      rightLowerLeg: mirrorEuler(frame.legs.leftLowerLeg),
    };

    frame.hips = {
      rotation: mirrorEuler(frame.hips.rotation),
      position: {
        x: -frame.hips.position.x,
        y: frame.hips.position.y,
        z: frame.hips.position.z,
      },
    };

    const { left, right, leftWrist, rightWrist, leftTracked, rightTracked } = frame.hands;
    frame.hands = {
      left: right ? mirrorHand(right) : null,
      right: left ? mirrorHand(left) : null,
      leftWrist: rightWrist ? mirrorEuler(rightWrist) : null,
      rightWrist: leftWrist ? mirrorEuler(leftWrist) : null,
      leftTracked: rightTracked,
      rightTracked: leftTracked,
    };
    const { leftHand, rightHand } = frame.confidence;
    frame.confidence.leftHand = rightHand;
    frame.confidence.rightHand = leftHand;
    const { leftHand: dbgL, rightHand: dbgR } = debug;
    debug.leftHand = dbgR;
    debug.rightHand = dbgL;
  } else {
    // MediaPipe blendshape names are subject-frame, so mirror mode is the
    // case that swaps them. Pupil x drives a camera-space gaze target (not a
    // bone), so its mirror flip is independent of the convention above.
    mirrorExpressions(frame.expressions);
    frame.pupil = { x: -frame.pupil.x, y: frame.pupil.y };
  }

  // When pose is lost, keep body channels at zero (the rig layer eases
  // toward a relaxed pose instead of freezing mid-air).
  if (!frame.poseTracked) {
    frame.spine = zeroEuler();
  }

  return { frame, debug };
}
