import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { DebugLandmarks, MocapFrame, ExpressionValues, EulerRotation } from "./types";

/** One sampled instant — the exact inputs RoomViewport's GLB-driving path
 *  reads each frame (debugLandmarksRef's raw landmark arrays + the smoothed
 *  frame's expression weights). Recording these, not the higher-level
 *  Euler-rotation MocapFrame fields, means replay re-exercises the real
 *  buildCanonicalPose → FK → GlbBoneDriver code path, not a shortcut.
 *
 *  head/pupil ARE two of those higher-level fields (Kalidokit output), but
 *  are recorded verbatim anyway (not re-derived from raw landmarks on
 *  replay, the way the rest of the FK pipeline is) because GlbBoneDriver
 *  consumes them directly for head-bone and eye-gaze driving — re-deriving
 *  them during replay would mean re-running solveMocapFrame(), which needs
 *  full MediaPipe Result objects and an HTMLVideoElement, not just landmark
 *  arrays. Same treatment as expressions below, for the same reason. */
export interface RecordedFrame {
  /** Seconds since recording start. */
  t: number;
  poseWorld: NormalizedLandmark[] | null;
  leftHand: NormalizedLandmark[] | null;
  rightHand: NormalizedLandmark[] | null;
  face: NormalizedLandmark[] | null;
  expressions: ExpressionValues | null;
  head: EulerRotation | null;
  pupil: { x: number; y: number } | null;
}

export interface MocapRecording {
  version: 1;
  recordedAt: string;
  frames: RecordedFrame[];
}

function cloneLm(lm: NormalizedLandmark[] | null): NormalizedLandmark[] | null {
  if (!lm) return null;
  return lm.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }));
}

/**
 * Records a live mocap session's per-frame inputs to the GLB-driving path so
 * it can be replayed later via useMocapReplay — headlessly, deterministically,
 * without a webcam. Built for diagnosing "model X looks awkward/broken in
 * vtube" reports: capture the real motion once, then replay it against any
 * model after any code change and compare.
 *
 * Self-contained: start()/stopAndDownload() manage their own rAF loop, so no
 * wiring into RoomViewport's existing render loop is needed.
 */
export function useMocapRecorder(
  debugLandmarksRef: MutableRefObject<DebugLandmarks>,
  frameRef: MutableRefObject<MocapFrame | null>,
) {
  const [isRecording, setIsRecording] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const bufferRef = useRef<RecordedFrame[]>([]);
  const startTimeRef = useRef(0);
  const rafRef = useRef(0);

  const loop = useCallback(() => {
    rafRef.current = requestAnimationFrame(loop);
    const lm = debugLandmarksRef.current;
    bufferRef.current.push({
      t: (performance.now() - startTimeRef.current) / 1000,
      poseWorld: cloneLm(lm.poseWorld),
      leftHand: cloneLm(lm.leftHand),
      rightHand: cloneLm(lm.rightHand),
      face: cloneLm(lm.face),
      expressions: frameRef.current?.expressions ? { ...frameRef.current.expressions } : null,
      head: frameRef.current?.head ? { ...frameRef.current.head } : null,
      pupil: frameRef.current?.pupil ? { ...frameRef.current.pupil } : null,
    });
    // Cheap progress readout for the UI; not on every push to avoid extra
    // re-renders — every ~6 frames is plenty for a counter.
    if (bufferRef.current.length % 6 === 0) setFrameCount(bufferRef.current.length);
  }, [debugLandmarksRef, frameRef]);

  const start = useCallback(() => {
    bufferRef.current = [];
    setFrameCount(0);
    startTimeRef.current = performance.now();
    setIsRecording(true);
    rafRef.current = requestAnimationFrame(loop);
  }, [loop]);

  const stopAndDownload = useCallback((filename?: string) => {
    cancelAnimationFrame(rafRef.current);
    setIsRecording(false);
    setFrameCount(bufferRef.current.length);
    const recording: MocapRecording = {
      version: 1,
      recordedAt: new Date().toISOString(),
      frames: bufferRef.current,
    };
    const blob = new Blob([JSON.stringify(recording)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? `vtube-mocap-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return recording;
  }, []);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return { isRecording, frameCount, start, stopAndDownload };
}
