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
  /** Timestamp in seconds. */
  t: number;
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
  { mirror, trackLegs, t }: SolveOptions,
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
      // — only the head/neck bent. Recover torso pitch ourselves from the
      // world-landmark hip->shoulder vector: world y grows downward and z
      // shrinks toward the camera, so bowing forward drives dz negative.
      // atan2(dz, -dy) is 0 upright and negative when bowing, matching the
      // head.x convention (pitch down = negative) so the same per-model sign
      // mapping applies downstream.
      const shoulderMid = midpoint3(poseWorld[11], poseWorld[12]);
      const hipMid = midpoint3(poseWorld[23], poseWorld[24]);
      const torsoPitch = clamp(
        Math.atan2(shoulderMid.z - hipMid.z, -(shoulderMid.y - hipMid.y)),
        -1.6,
        1.6,
      );

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
    // image space, same coordinates as the hand landmarks.
    const poseWristL = poseImage?.[15]; // subject's anatomical LEFT wrist
    const poseWristR = poseImage?.[16]; // subject's anatomical RIGHT wrist
    const anchors =
      frame.poseTracked &&
      poseWristL != null &&
      poseWristR != null &&
      (poseWristL.visibility ?? 0) > 0.5 &&
      (poseWristR.visibility ?? 0) > 0.5
        ? { left: poseWristL, right: poseWristR }
        : null;

    const dist = (a: NormalizedLandmark, b: NormalizedLandmark) =>
      Math.hypot(a.x - b.x, a.y - b.y);

    const detected: Array<{
      lm: NormalizedLandmark[];
      score: number;
      /** Handedness label says subject-left (anatomical on unmirrored video). */
      labelLeft: boolean;
      dL: number;
      dR: number;
    }> = [];
    for (let i = 0; i < handLm.length; i++) {
      const lm = handLm[i];
      const label = handedness[i]?.[0]?.categoryName;
      const score = handedness[i]?.[0]?.score ?? 0;
      if (!lm || lm.length < 21) continue;
      if (label !== "Left" && label !== "Right") continue;
      detected.push({
        lm,
        score,
        labelLeft: label === "Left",
        dL: anchors ? dist(lm[0], anchors.left) : Number.POSITIVE_INFINITY,
        dR: anchors ? dist(lm[0], anchors.right) : Number.POSITIVE_INFINITY,
      });
    }

    // Which subject side is each hand? With two hands and a tracked pose,
    // pick the joint assignment with the smaller total wrist distance so the
    // two hands can never land on the same side.
    let subjectLeft: boolean[];
    if (anchors && detected.length === 2) {
      subjectLeft =
        detected[0].dL + detected[1].dR <= detected[0].dR + detected[1].dL
          ? [true, false]
          : [false, true];
    } else {
      subjectLeft = detected.map((h) => (anchors ? h.dL <= h.dR : h.labelLeft));
    }

    for (let i = 0; i < detected.length; i++) {
      const { lm, score } = detected[i];
      // Mirror convention (as-is application): the subject's LEFT hand drives
      // the avatar's RIGHT side — the same side of the screen, matching the
      // pre-mirrored pose-solver arms.
      const avatarSide = subjectLeft[i] ? "Right" : "Left";
      const { fingers, wrist } = solveHand(
        lm as unknown as KalidokitHandLandmarks,
        avatarSide,
      );

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
  // frame.hands.left — both pre-mirrored, so they pair directly.
  if (frame.hands.leftWrist) frame.hands.leftWrist.z = poseHandZ?.left ?? 0;
  if (frame.hands.rightWrist) frame.hands.rightWrist.z = poseHandZ?.right ?? 0;

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
