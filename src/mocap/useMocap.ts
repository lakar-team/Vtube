import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type {
  FaceLandmarkerResult,
  HandLandmarkerResult,
  PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { createLandmarkers, type Landmarkers } from "./landmarkers";
import { solveMocapFrame } from "./kalidokitAdapter";
import { FilterBank, smoothFrame } from "./smoothing";
import {
  applyCalibration,
  CalibrationRecorder,
  clearStoredCalibration,
  loadCalibration,
  saveCalibration,
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
  /** Seconds left in the pre-capture countdown (body mode), 0 when capturing. */
  calibrationCountdown: number;
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
   * - "body": 3 s countdown, then ~2 s T-pose capture (stand, arms straight
   *   out to the sides) — zeroes the body solve against the model's rest
   *   pose and sets the hip-translation reference.
   */
  calibrate: (mode: CalibrationMode) => void;
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
  calibrationCountdown: 0,
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
 * (fps/confidence/status) is committed to state, at 4 Hz.
 */
export function useMocap(
  videoRef: RefObject<HTMLVideoElement | null>,
  options: {
    mirror: boolean;
    trackLegs: boolean;
    torsoPitchSource: TorsoPitchSource;
    enabled: boolean;
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

  // Fallback upright reference for the apparent-size bow estimator when no
  // body calibration captured one: a slow-decaying running max of the
  // measured torso ratio (a person spends most of their time upright, so the
  // max is a decent stand-in for "standing straight"). The slight decay lets
  // it recover if a too-large transient ever poisons it.
  const runningRefRatioRef = useRef(0);

  const calibRef = useRef<CalibrationData | null>(null);
  const recorderRef = useRef<CalibrationRecorder | null>(null);
  const bankRef = useRef<FilterBank>(new FilterBank());

  // Restore last session's calibration (camera setups rarely move).
  useEffect(() => {
    calibRef.current = loadCalibration();
  }, []);

  const calibrate = useCallback((mode: CalibrationMode) => {
    recorderRef.current = new CalibrationRecorder(mode, performance.now());
    setState((s) => ({
      ...s,
      calibrating: mode,
      calibrationCountdown: mode === "body" ? 3 : 0,
    }));
  }, []);

  const clearCalibration = useCallback(() => {
    calibRef.current = null;
    recorderRef.current = null;
    bankRef.current.resetAll();
    clearStoredCalibration();
    setState((s) => ({
      ...s,
      calibrating: null,
      calibrationCountdown: 0,
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
    let lastShownCountdown = -1;

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

      const calibRatio = calibRef.current?.body?.torsoRatio ?? 0;
      const runningRatio = runningRefRatioRef.current;
      const { frame: raw, debug } = solveMocapFrame(faceResult, poseResult, handResult, video, {
        mirror: mirrorRef.current,
        trackLegs: trackLegsRef.current,
        torsoPitchSource: torsoPitchSourceRef.current,
        refTorsoRatio:
          calibRatio > 0 ? calibRatio : runningRatio > 0 ? runningRatio : null,
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
      const recorder = recorderRef.current;
      if (recorder) {
        const stillRecording = recorder.add(raw, nowMs);

        // Surface the body-mode countdown at 1 Hz granularity.
        const countdown = Math.ceil(recorder.countdownLeft(nowMs));
        if (countdown !== lastShownCountdown) {
          lastShownCountdown = countdown;
          setState((s) => ({ ...s, calibrationCountdown: countdown }));
        }

        if (!stillRecording) {
          const data = recorder.finish(calibRef.current);
          recorderRef.current = null;
          lastShownCountdown = -1;
          if (data) {
            calibRef.current = data;
            saveCalibration(data);
            bankRef.current.resetAll(); // offsets jumped; don't smooth across it
          }
          setState((s) => ({
            ...s,
            calibrating: null,
            calibrationCountdown: 0,
            faceCalibrated: (calibRef.current?.faceSampleCount ?? 0) > 0,
            bodyCalibrated: calibRef.current?.body != null,
          }));
        }
      }

      // --- calibrate, then smooth
      const calibrated = applyCalibration(raw, calibRef.current);
      frameRef.current = smoothFrame(bankRef.current, calibrated);

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
    clearCalibration,
  };
}
