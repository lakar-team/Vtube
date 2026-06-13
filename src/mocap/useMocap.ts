import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type {
  FaceLandmarkerResult,
  HandLandmarkerResult,
  PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { createLandmarkers, type Landmarkers } from "./landmarkers";
import { solveMocapFrame } from "./kalidokitAdapter";
import { directSmoothFrame, FilterBank, smoothFrame } from "./smoothing";
import {
  applyCalibration,
  BodySequenceRecorder,
  clearStoredCalibration,
  FaceCalibrationRecorder,
  loadCalibration,
  saveCalibration,
  type BodyPoseStatus,
  type CalibrationData,
  type CalibrationMode,
} from "./calibration";
import type { DebugLandmarks, MocapFrame, TorsoPitchSource } from "./types";

export type MocapStatus = "idle" | "loading" | "running" | "error";

export interface MocapState {
  status: MocapStatus;
  error: string | null;
  fps: number;
  faceConfidence: number;
  poseConfidence: number;
  legsConfidence: number;
  /** Which calibration is currently capturing, if any. */
  calibrating: CalibrationMode | null;
  /**
   * Where the body pose sequence is (pose, countdown, capture progress).
   * Non-null exactly while calibrating === "body". The avatar demonstrates
   * `bodyPose.pose.demo` on screen for the user to copy.
   */
  bodyPose: BodyPoseStatus | null;
  faceCalibrated: boolean;
  bodyCalibrated: boolean;
}

export interface UseMocapResult {
  /** Latest SMOOTHED + CALIBRATED frame — read this in render loops. */
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Latest RAW solved frame (pre-calibration, pre-smoothing) for the HUD. */
  rawFrameRef: MutableRefObject<MocapFrame | null>;
  /** Latest landmark arrays for the webcam debug overlay. */
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  state: MocapState;
  /**
   * Start a calibration capture.
   * - "face": ~2 s neutral-expression capture (sit relaxed, look at camera).
   * - "body": guided pose sequence — the avatar demonstrates each pose
   *   (relaxed neutral, half raise, bow), each with a countdown to get into
   *   position and a ~2 s capture. Poses can be skipped individually.
   */
  calibrate: (mode: CalibrationMode) => void;
  /** Skip the current pose of the body sequence. */
  skipPose: () => void;
  /** Abort the running calibration without saving. */
  cancelCalibration: () => void;
  clearCalibration: () => void;
}

const INITIAL_STATE: MocapState = {
  status: "idle",
  error: null,
  fps: 0,
  faceConfidence: 0,
  poseConfidence: 0,
  legsConfidence: 0,
  calibrating: null,
  bodyPose: null,
  faceCalibrated: false,
  bodyCalibrated: false,
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
    torsoPitchSource: TorsoPitchSource;
    enabled: boolean;
    directMode: boolean;
  },
): UseMocapResult {
  const frameRef = useRef<MocapFrame | null>(null);
  const rawFrameRef = useRef<MocapFrame | null>(null);
  const debugLandmarksRef = useRef<DebugLandmarks>({
    face: null,
    pose: null,
    leftHand: null,
    rightHand: null,
  });

  const [state, setState] = useState<MocapState>(() => {
    const stored = loadCalibration();
    return {
      ...INITIAL_STATE,
      faceCalibrated: (stored?.faceSampleCount ?? 0) > 0,
      bodyCalibrated: stored?.body != null,
    };
  });

  // Refs for values the detection loop reads without re-subscribing.
  const mirrorRef = useRef(options.mirror);
  mirrorRef.current = options.mirror;
  const trackLegsRef = useRef(options.trackLegs);
  trackLegsRef.current = options.trackLegs;
  const torsoPitchSourceRef = useRef(options.torsoPitchSource);
  torsoPitchSourceRef.current = options.torsoPitchSource;
  const directModeRef = useRef(options.directMode);
  directModeRef.current = options.directMode;

  // Fallback upright reference for the apparent-size bow estimator when no
  // body calibration captured one: a slow-decaying running max of the
  // measured torso ratio (a person spends most of their time upright, so the
  // max is a decent stand-in for "standing straight"). The slight decay lets
  // it recover if a too-large transient ever poisons it.
  const runningRefRatioRef = useRef(0);

  const calibRef = useRef<CalibrationData | null>(null);
  const faceRecorderRef = useRef<FaceCalibrationRecorder | null>(null);
  const bodyRecorderRef = useRef<BodySequenceRecorder | null>(null);
  const bankRef = useRef<FilterBank>(new FilterBank());

  // Restore last session's calibration (camera setups rarely move).
  useEffect(() => {
    calibRef.current = loadCalibration();
  }, []);

  const calibrate = useCallback((mode: CalibrationMode) => {
    const now = performance.now();
    if (mode === "face") {
      faceRecorderRef.current = new FaceCalibrationRecorder(now);
      setState((s) => ({ ...s, calibrating: "face", bodyPose: null }));
    } else {
      const recorder = new BodySequenceRecorder(mirrorRef.current, now);
      bodyRecorderRef.current = recorder;
      setState((s) => ({ ...s, calibrating: "body", bodyPose: recorder.status(now) }));
    }
  }, []);

  const skipPose = useCallback(() => {
    const recorder = bodyRecorderRef.current;
    if (recorder) recorder.skip(performance.now());
  }, []);

  const cancelCalibration = useCallback(() => {
    faceRecorderRef.current = null;
    bodyRecorderRef.current = null;
    setState((s) => ({ ...s, calibrating: null, bodyPose: null }));
  }, []);

  const clearCalibration = useCallback(() => {
    calibRef.current = null;
    faceRecorderRef.current = null;
    bodyRecorderRef.current = null;
    bankRef.current.resetAll();
    clearStoredCalibration();
    setState((s) => ({
      ...s,
      calibrating: null,
      bodyPose: null,
      faceCalibrated: false,
      bodyCalibrated: false,
    }));
  }, []);

  useEffect(() => {
    if (!options.enabled) return;

    let cancelled = false;
    let rafId = 0;
    let landmarkers: Landmarkers | null = null;
    let lastVideoTime = -1;
    let frameCount = 0;
    let fpsWindowStart = performance.now();
    let fps = 0;
    // Last body-pose snapshot pushed to state — only re-push on a visible
    // change (pose index / phase / countdown second), not at video rate.
    let lastPoseKey = "";

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

    function finishCalibration(data: CalibrationData | null) {
      if (data) {
        calibRef.current = data;
        saveCalibration(data);
        bankRef.current.resetAll(); // offsets jumped; don't smooth across it
      }
      setState((s) => ({
        ...s,
        calibrating: null,
        bodyPose: null,
        faceCalibrated: (calibRef.current?.faceSampleCount ?? 0) > 0,
        bodyCalibrated: calibRef.current?.body != null,
      }));
    }

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

      const calibRatio = calibRef.current?.body?.torsoRatio ?? 0;
      const runningRatio = runningRefRatioRef.current;
      const { frame: raw, debug } = solveMocapFrame(faceResult, poseResult, handResult, video, {
        mirror: mirrorRef.current,
        trackLegs: trackLegsRef.current,
        torsoPitchSource: torsoPitchSourceRef.current,
        refTorsoRatio:
          calibRatio > 0 ? calibRatio : runningRatio > 0 ? runningRatio : null,
        pitchCalib: calibRef.current?.body?.pitch ?? null,
        t: nowMs / 1000,
      });

      if (raw.poseTracked && raw.torsoRatio > 0) {
        runningRefRatioRef.current = Math.max(
          raw.torsoRatio,
          runningRefRatioRef.current * (1 - 1e-4),
        );
      }

      rawFrameRef.current = raw;
      debugLandmarksRef.current = debug;

      // --- calibration capture
      const faceRecorder = faceRecorderRef.current;
      if (faceRecorder && !faceRecorder.add(raw, nowMs)) {
        const data = faceRecorder.finish(calibRef.current);
        faceRecorderRef.current = null;
        finishCalibration(data);
      }

      const bodyRecorder = bodyRecorderRef.current;
      if (bodyRecorder) {
        const running = bodyRecorder.add(raw, nowMs);
        if (!running) {
          const data = bodyRecorder.finish(calibRef.current);
          bodyRecorderRef.current = null;
          lastPoseKey = "";
          finishCalibration(data);
        } else {
          const status = bodyRecorder.status(nowMs);
          const key = status
            ? `${status.index}:${status.phase}:${status.countdown}:${Math.round(status.progress * 10)}`
            : "";
          if (key !== lastPoseKey) {
            lastPoseKey = key;
            setState((s) => ({ ...s, bodyPose: status }));
          }
        }
      }

      // --- calibrate, then smooth (direct mode: near-passthrough filter, no slew limits)
      const calibrated = applyCalibration(raw, calibRef.current);
      frameRef.current = directModeRef.current
        ? directSmoothFrame(bankRef.current, calibrated)
        : smoothFrame(bankRef.current, calibrated);

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
    calibrate,
    skipPose,
    cancelCalibration,
    clearCalibration,
  };
}
