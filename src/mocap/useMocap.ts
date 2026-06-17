import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type {
  FaceLandmarkerResult,
  HandLandmarkerResult,
  PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { createLandmarkers, DEFAULT_PERF, type Landmarkers, type PerfOptions } from "./landmarkers";
import { solveMocapFrame } from "./kalidokitAdapter";
import { directSmoothFrame, FilterBank } from "./smoothing";
import { updateBodyCalibration, type BodyCalibration } from "./bodyCalibration";
import type { DebugLandmarks, MocapFrame } from "./types";

export type MocapStatus = "idle" | "loading" | "running" | "error";

export interface MocapState {
  status: MocapStatus;
  error: string | null;
  fps: number;
  faceConfidence: number;
  poseConfidence: number;
  legsConfidence: number;
  /** Set when the Face GPU delegate is on but returns no detections (a known
   *  silent-failure mode on some systems) — shown as a clear warning. */
  faceDelegateError: string | null;
}

export interface UseMocapResult {
  /** Latest smoothed frame — read this in render loops. */
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Latest RAW solved frame (pre-smoothing) for the HUD. */
  rawFrameRef: MutableRefObject<MocapFrame | null>;
  /** Latest landmark arrays for the webcam debug overlay. */
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  /** Latest body-size calibration (metric scale + derived real-world sizes). */
  calibrationRef: MutableRefObject<BodyCalibration | null>;
  state: MocapState;
}

const INITIAL_STATE: MocapState = {
  status: "idle",
  error: null,
  fps: 0,
  faceConfidence: 0,
  poseConfidence: 0,
  legsConfidence: 0,
  faceDelegateError: null,
};

/**
 * The unified mocap pipeline:
 *
 *   webcam video
 *     -> MediaPipe FaceLandmarker + PoseLandmarker + HandLandmarker
 *     -> Kalidokit Face/Pose/Hand solve (kalidokitAdapter)
 *     -> calibration offsets (calibration.ts)
 *     -> One Euro filter bank (smoothing.ts)
 *     -> frameRef (consumed by RoomViewport each render frame)
 *
 * Results are published through refs, not state — the pipeline runs at video
 * rate and must not trigger React re-renders. Only the HUD-facing summary
 * (fps/confidence/status) is committed to state, at 4 Hz, plus discrete
 * calibration-sequence transitions (pose changes, countdown ticks at 1 Hz).
 */
export function useMocap(
  videoRef: RefObject<HTMLVideoElement | null>,
  options: {
    mirror: boolean;
    trackLegs: boolean;
    enabled: boolean;
    /** User's real standing height (cm) — anchors metric body calibration. */
    heightCm: number;
    /** Delegate + inference-rate performance options. */
    perf?: PerfOptions;
  },
): UseMocapResult {
  const perf = options.perf ?? DEFAULT_PERF;
  const frameRef = useRef<MocapFrame | null>(null);
  const rawFrameRef = useRef<MocapFrame | null>(null);
  const debugLandmarksRef = useRef<DebugLandmarks>({
    face: null,
    pose: null,
    poseWorld: null,
    poseWorldThree: null,
    leftHand: null,
    rightHand: null,
  });
  const calibrationRef = useRef<BodyCalibration | null>(null);

  const [state, setState] = useState<MocapState>(INITIAL_STATE);

  // Refs for values the detection loop reads without re-subscribing.
  const mirrorRef = useRef(options.mirror);
  mirrorRef.current = options.mirror;
  const trackLegsRef = useRef(options.trackLegs);
  trackLegsRef.current = options.trackLegs;
  const heightCmRef = useRef(options.heightCm);
  heightCmRef.current = options.heightCm;
  // Caps are read live in the loop (no landmarker rebuild); delegates are not.
  const perfRef = useRef(perf);
  perfRef.current = perf;
  const bankRef = useRef<FilterBank>(new FilterBank());

  // Changing any delegate requires rebuilding the landmarkers — key the effect
  // on just those flags so flipping a cap (read live) does NOT reinitialise.
  const delegateKey = `${perf.faceGpu}|${perf.faceWasmSimd}|${perf.poseGpu}|${perf.handsGpu}`;

  useEffect(() => {
    if (!options.enabled) return;

    let cancelled = false;
    let rafId = 0;
    let landmarkers: Landmarkers | null = null;
    let lastVideoTime = -1;
    let frameCount = 0;
    let fpsWindowStart = performance.now();
    let fps = 0;
    // For the inference caps: hold the last result on skipped frames.
    let lastFaceResult: FaceLandmarkerResult | null = null;
    let lastPoseResult: PoseLandmarkerResult | null = null;
    let infFrame = 0;
    let faceZeroStreak = 0;

    setState((s) => ({ ...s, status: "loading", error: null }));

    createLandmarkers(perfRef.current)
      .then((lm) => {
        if (cancelled) {
          lm.close();
          return;
        }
        landmarkers = lm;
        setState((s) => ({ ...s, status: "running" }));
        rafId = requestAnimationFrame(loop);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          status: "error",
          error:
            "Failed to load MediaPipe models (network required on first run): " +
            (err instanceof Error ? err.message : String(err)),
        }));
      });

    function loop() {
      if (cancelled) return;
      rafId = requestAnimationFrame(loop);

      const video = videoRef.current;
      if (!landmarkers || !video || video.readyState < 2) return;
      // Skip duplicate frames (rAF usually runs faster than the camera).
      if (video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;

      const nowMs = performance.now();
      const perfNow = perfRef.current;
      infFrame++;
      // 30fps caps: run face/pose inference every other camera frame, reusing the
      // last result in between (render stays at full rate). Hands run every frame.
      const runFace = !perfNow.faceCap30 || lastFaceResult === null || infFrame % 2 === 0;
      const runPose = !perfNow.poseCap30 || lastPoseResult === null || infFrame % 2 === 0;

      let handResult: HandLandmarkerResult | null = null;
      try {
        // Each landmarker is an independent task instance, so sharing nowMs (a
        // strictly-increasing timestamp) across them is fine.
        if (runFace) lastFaceResult = landmarkers.face.detectForVideo(video, nowMs);
        if (runPose) lastPoseResult = landmarkers.pose.detectForVideo(video, nowMs);
        handResult = landmarkers.hand.detectForVideo(video, nowMs);
      } catch (err) {
        // A single failed inference shouldn't kill the loop.
        console.warn("mediapipe detect error", err);
        return;
      }
      const faceResult = lastFaceResult;
      const poseResult = lastPoseResult;

      // Watch for the GPU-delegate "0 detections" silent failure on the face model.
      if (runFace) {
        const faces = faceResult?.faceLandmarks?.length ?? 0;
        faceZeroStreak = perfNow.faceGpu && faces === 0 ? faceZeroStreak + 1 : 0;
      }

      const { frame: raw, debug } = solveMocapFrame(faceResult, poseResult, handResult, video, {
        mirror: mirrorRef.current,
        trackLegs: trackLegsRef.current,
        t: nowMs / 1000,
      });

      rawFrameRef.current = raw;
      debugLandmarksRef.current = debug;
      calibrationRef.current = updateBodyCalibration(
        calibrationRef.current,
        debug.poseWorld,
        heightCmRef.current,
      );

      frameRef.current = directSmoothFrame(bankRef.current, raw);

      // --- fps + HUD state at 4 Hz
      frameCount++;
      if (nowMs - fpsWindowStart >= 250) {
        fps = (frameCount * 1000) / (nowMs - fpsWindowStart);
        frameCount = 0;
        fpsWindowStart = nowMs;
        setState((s) => ({
          ...s,
          fps: Math.round(fps),
          faceConfidence: raw.confidence.face,
          poseConfidence: raw.confidence.pose,
          legsConfidence: raw.confidence.legs,
          faceDelegateError: faceZeroStreak > 45
            ? "Face GPU delegate returned 0 detections — turn “Face GPU” off (use CPU/WASM)."
            : null,
        }));
      }
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      landmarkers?.close();
      landmarkers = null;
    };
    // delegateKey rebuilds the landmarkers when a GPU/WASM toggle flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, videoRef, delegateKey]);

  return {
    frameRef,
    rawFrameRef,
    debugLandmarksRef,
    calibrationRef,
    state,
  };
}
