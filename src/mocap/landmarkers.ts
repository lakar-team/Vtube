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

/**
 * Performance options — delegate choices + inference frame-rate caps, surfaced
 * as live toggles in the Rules Inspector so the user can A/B which combo tracks
 * fastest on their machine.
 *
 * On the delegates: MediaPipe Tasks-Vision (web) only exposes "GPU" vs "CPU".
 * "CPU" IS the WebAssembly path (SIMD auto-selected when the browser supports
 * it), so `faceWasmSimd` is the explicit WASM-CPU choice used whenever the GPU
 * toggle is off — they can't both apply (GPU wins). Re-toggling it reinitialises
 * the face model, which also clears a wedged GPU delegate.
 */
export interface PerfOptions {
  faceGpu: boolean;
  faceWasmSimd: boolean;
  poseGpu: boolean;
  handsGpu: boolean;
  /** Run FaceLandmarker inference every other camera frame (≈30fps). */
  faceCap30: boolean;
  /** Run PoseLandmarker inference every other camera frame (≈30fps). */
  poseCap30: boolean;
}

export const DEFAULT_PERF: PerfOptions = {
  faceGpu: false,      // CPU/WASM is the reliable default for the face model (see below)
  faceWasmSimd: true,
  poseGpu: true,
  handsGpu: true,
  faceCap30: false,
  poseCap30: false,
};

export async function createLandmarkers(perf: PerfOptions): Promise<Landmarkers> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  // GPU wins over WASM-SIMD when both are set; otherwise CPU (= WASM).
  const faceDelegate = perf.faceGpu ? "GPU" : "CPU";

  const [face, pose, hand] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: FACE_MODEL_URL,
        // NOTE: on some GPUs/browsers the face model with blendshapes silently
        // returns 0 faces on the GPU delegate (init succeeds, inference yields an
        // empty result, and MediaPipe's GPU→CPU auto-fallback never triggers).
        // CPU/WASM is the reliable default; the GPU toggle lets the user try it,
        // and useMocap surfaces a clear warning if it returns no detections.
        delegate: faceDelegate,
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
        delegate: perf.poseGpu ? "GPU" : "CPU",
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
        delegate: perf.handsGpu ? "GPU" : "CPU",
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
