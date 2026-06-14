import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type {
  FaceLandmarkerResult,
  HandLandmarkerResult,
  PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { createLandmarkers, type Landmarkers } from "./landmarkers";
import { solveMocapFrame } from "./kalidokitAdapter";
import { directSmoothFrame, FilterBank } from "./smoothing";
import type { DebugLandmarks, MocapFrame } from "./types";

export type MocapStatus = "idle" | "loading" | "running" | "error";

export interface MocapState {
  status: MocapStatus;
  error: string | null;
  fps: number;
  faceConfidence: number;
  poseConfidence: number;
  legsConfidence: number;
}

export interface UseMocapResult {
  /** Latest smoothed frame — read this in render loops. */
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Latest RAW solved frame (pre-smoothing) for the HUD. */
  rawFrameRef: MutableRefObject<MocapFrame | null>;
  /** Latest landmark arrays for the webcam debug overlay. */
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  state: MocapState;
}

const INITIAL_STATE: MocapState = {
  status: "idle",
  error: null,
  fps: 0,
  faceConfidence: 0,
  poseConfidence: 0,
  legsConfidence: 0,
};

/**
 * The unified mocap pipeline:
 *
 *   webcam video
 *     -> MediaPipe FaceLandmarker + PoseLandmarker + HandLandmarker
 *     -> Kalidokit Face/Pose/Hand solve (kalidokitAdapter)
 *     -> calibration offsets (calibration.ts)
 *     -> One Euro filter bank (smoothing.ts)
 *     -> frameRef (consumed by AvatarViewport each render frame)
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
  },
): UseMocapResult {
  const frameRef = useRef<MocapFrame | null>(null);
  const rawFrameRef = useRef<MocapFrame | null>(null);
  const debugLandmarksRef = useRef<DebugLandmarks>({
    face: null,
    pose: null,
    poseWorld: null,
    leftHand: null,
    rightHand: null,
  });

  const [state, setState] = useState<MocapState>(INITIAL_STATE);

  // Refs for values the detection loop reads without re-subscribing.
  const mirrorRef = useRef(options.mirror);
  mirrorRef.current = options.mirror;
  const trackLegsRef = useRef(options.trackLegs);
  trackLegsRef.current = options.trackLegs;
  const bankRef = useRef<FilterBank>(new FilterBank());

  useEffect(() => {
    if (!options.enabled) return;

    let cancelled = false;
    let rafId = 0;
    let landmarkers: Landmarkers | null = null;
    let lastVideoTime = -1;
    let frameCount = 0;
    let fpsWindowStart = performance.now();
    let fps = 0;

    setState((s) => ({ ...s, status: "loading", error: null }));

    createLandmarkers()
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

      let faceResult: FaceLandmarkerResult | null = null;
      let poseResult: PoseLandmarkerResult | null = null;
      let handResult: HandLandmarkerResult | null = null;
      try {
        faceResult = landmarkers.face.detectForVideo(video, nowMs);
        // Pose/hand get a strictly-increasing timestamp too; sharing nowMs of
        // the same frame is fine because they are independent task instances.
        poseResult = landmarkers.pose.detectForVideo(video, nowMs);
        handResult = landmarkers.hand.detectForVideo(video, nowMs);
      } catch (err) {
        // A single failed inference shouldn't kill the loop.
        console.warn("mediapipe detect error", err);
        return;
      }

      const { frame: raw, debug } = solveMocapFrame(faceResult, poseResult, handResult, video, {
        mirror: mirrorRef.current,
        trackLegs: trackLegsRef.current,
        t: nowMs / 1000,
      });

      rawFrameRef.current = raw;
      debugLandmarksRef.current = debug;

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
        }));
      }
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      landmarkers?.close();
      landmarkers = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, videoRef]);

  return {
    frameRef,
    rawFrameRef,
    debugLandmarksRef,
    state,
  };
}
