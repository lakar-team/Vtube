import type {
  FaceLandmarkerResult,
  PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { Face, Pose } from "kalidokit";
import {
  emptyFrame,
  zeroEuler,
  type DebugLandmarks,
  type EulerRotation,
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
 */

type KalidokitLandmarks = Parameters<typeof Face.solve>[0];

const UPPER_BODY_POSE_INDICES = [11, 12, 13, 14, 15, 16] as const; // shoulders/elbows/wrists

function mirrorEuler(e: EulerRotation): EulerRotation {
  // Mirroring about the vertical axis flips yaw and roll, keeps pitch.
  return { x: e.x, y: -e.y, z: -e.z };
}

export interface SolveOptions {
  /** Mirror mode: avatar behaves like your reflection (default UX). */
  mirror: boolean;
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
  video: HTMLVideoElement,
  { mirror, t }: SolveOptions,
): SolveResult {
  const frame = emptyFrame(t);
  const debug: DebugLandmarks = { face: null, pose: null };

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

    const riggedPose = Pose.solve(
      poseWorld as unknown as Parameters<typeof Pose.solve>[0],
      poseImage as unknown as Parameters<typeof Pose.solve>[1],
      {
        runtime: "mediapipe",
        video,
        // Webcam VTubing is seated/upper-body; leg solving from a desk
        // camera produces garbage, so keep it off.
        enableLegs: false,
      },
    );

    if (riggedPose && frame.confidence.pose > 0.5) {
      frame.poseTracked = true;
      frame.spine = {
        x: riggedPose.Spine.x,
        y: riggedPose.Spine.y,
        z: riggedPose.Spine.z,
      };
      frame.arms = {
        leftUpperArm: { ...riggedPose.LeftUpperArm },
        leftLowerArm: { ...riggedPose.LeftLowerArm },
        rightUpperArm: { ...riggedPose.RightUpperArm },
        rightLowerArm: { ...riggedPose.RightLowerArm },
      };
    }
  }

  // -------------------------------------------------------------- mirror
  if (mirror) {
    frame.head = mirrorEuler(frame.head);
    frame.spine = mirrorEuler(frame.spine);
    frame.pupil = { x: -frame.pupil.x, y: frame.pupil.y };

    const { blinkLeft, blinkRight } = frame.expressions;
    frame.expressions.blinkLeft = blinkRight;
    frame.expressions.blinkRight = blinkLeft;

    frame.arms = {
      leftUpperArm: mirrorEuler(frame.arms.rightUpperArm),
      leftLowerArm: mirrorEuler(frame.arms.rightLowerArm),
      rightUpperArm: mirrorEuler(frame.arms.leftUpperArm),
      rightLowerArm: mirrorEuler(frame.arms.leftLowerArm),
    };
  }

  // When pose is lost, keep arms at zero (the rig layer eases toward a
  // relaxed pose instead of freezing mid-air).
  if (!frame.poseTracked) {
    frame.spine = zeroEuler();
  }

  return { frame, debug };
}
