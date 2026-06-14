import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

/**
 * MediaPipe Tasks Vision setup — REAL landmark tracking.
 *
 * This replaces the old AI Studio prototype's fake "pixel differencing across
 * tracking quadrants" approach with actual ML models:
 * - FaceLandmarker: 478 face landmarks + 52 ARKit-style blendshapes
 *   (eyeBlinkLeft, jawOpen, mouthPucker, ...) per frame.
 * - PoseLandmarker: 33 body landmarks (normalized + metric world coords),
 *   of which we use the upper body.
 *
 * The WASM runtime and .task model files are fetched from Google's CDN on
 * first load (~10 MB total, cached by the browser afterwards). If you need
 * fully-offline operation, download the files and serve them from /public —
 * see SETUP.md "Offline models".
 */

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// "full" pose model: noticeably better 3D (z) accuracy than "lite", which
// matters for full-body tracking and for telling whether a hand is in front
// of or behind the torso (dance moves). Costs a few ms more per frame; swap
// back to pose_landmarker_lite if a low-end machine can't hold frame rate.
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

// HandLandmarker: 21 landmarks per hand, up to 2 hands. Used for finger
// rigging via Kalidokit's Hand solver.
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export interface Landmarkers {
  face: FaceLandmarker;
  pose: PoseLandmarker;
  hand: HandLandmarker;
  close: () => void;
}

export async function createLandmarkers(): Promise<Landmarkers> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);

  const [face, pose, hand] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: FACE_MODEL_URL,
        // Force CPU for the face model. On some GPUs/browsers the face model
        // with blendshapes silently returns 0 faces on the GPU delegate — and
        // because it's silent (init succeeds, inference just yields an empty
        // result) MediaPipe's GPU→CPU auto-fallback never triggers. Leaving the
        // delegate unset let auto-select pick GPU and hit exactly that trap:
        // pose/hands (GPU) tracked fine while the face produced no landmarks,
        // so the skeleton viewport's face overlay never appeared. CPU is the
        // reliable path; for a single face the few-ms cost is well worth it
        // (face landmarks + blendshapes are the feature this app depends on).
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      // Lower thresholds so marginal angles / lighting still detect.
      minFaceDetectionConfidence: 0.3,
      minFacePresenceConfidence: 0.3,
      minTrackingConfidence: 0.5,
      // The blendshapes are the key feature: direct, calibrated-ish 0..1
      // ARKit coefficients for blinks/jaw/mouth — far more reliable than
      // deriving them geometrically from landmark distances.
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    }),
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: POSE_MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: HAND_MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
  ]);

  return {
    face,
    pose,
    hand,
    close: () => {
      face.close();
      pose.close();
      hand.close();
    },
  };
}
