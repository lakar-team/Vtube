import { useEffect, useRef, useState } from "react";
import { emptyFrame, type DebugLandmarks, type MocapFrame } from "./types";
import type { BodyCalibration } from "./bodyCalibration";
import type { MocapRecording, RecordedFrame } from "./useMocapRecorder";
import type { MocapState, UseMocapResult } from "./useMocap";

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
 * Drop-in replacement for useMocap: instead of reading a live webcam through
 * MediaPipe, replays a recording captured by useMocapRecorder. Returns the
 * exact same ref shapes useMocap does, so RoomViewport (and everything
 * downstream — buildCanonicalPose, FK, GlbBoneDriver) needs zero changes to
 * consume either source. Only the `mocap = ...` line in App.tsx switches
 * between useMocap(...) and useMocapReplay(...).
 *
 * Loops continuously once it reaches the end of the recording, advancing by
 * wall-clock elapsed time matched against each frame's recorded `t` — same
 * timing character a live session has, just deterministic and camera-free.
 * This is the headless half of the self-diagnosing loop: record once, then
 * drive any model through identical motion via Claude in Chrome after every
 * code change, with no need to redo the camera test each time.
 *
 * Known gap: poseWorldThree (Vector3 form of poseWorld, computed in
 * kalidokitAdapter) is not recorded and is left null here. RoomViewport's
 * GLB-driving path reads debugLandmarksRef.poseWorld directly and doesn't
 * touch poseWorldThree, so this doesn't affect that path — but the
 * procedural-skeleton / face-mesh debug views might want it; add it to
 * RecordedFrame + recompute here if those views need replay too.
 */
export function useMocapReplay(
  recording: MocapRecording | null,
  enabled: boolean,
): UseMocapResult {
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

  useEffect(() => {
    if (!enabled || !recording || recording.frames.length === 0) {
      setState((s) => ({ ...s, status: "idle" }));
      return;
    }

    let cancelled = false;
    let rafId = 0;
    const frames = recording.frames;
    const duration = Math.max(frames[frames.length - 1].t, 1 / 30);

    setState((s) => ({ ...s, status: "running", error: null }));

    function applyFrame(rf: RecordedFrame) {
      debugLandmarksRef.current = {
        face: rf.face,
        pose: null,
        poseWorld: rf.poseWorld,
        poseWorldThree: null,
        leftHand: rf.leftHand,
        rightHand: rf.rightHand,
      };
      const base = frameRef.current ?? emptyFrame(rf.t);
      const next: MocapFrame = {
        ...base,
        t: rf.t,
        poseTracked: !!rf.poseWorld,
        expressions: rf.expressions ?? base.expressions,
        head: rf.head ?? base.head,
        pupil: rf.pupil ?? base.pupil,
      };
      frameRef.current = next;
      rawFrameRef.current = next;
    }

    const startWall = performance.now();
    let frameCount = 0;
    let fpsWindowStart = startWall;
    // Start the scan near wherever the last loop left off — recordings are
    // short (a few hundred frames for a 10-15s clip) so a linear scan from
    // index 0 each time would also be fine, but this avoids the O(n) rescan.
    let lastIdx = 0;

    function loop() {
      if (cancelled) return;
      rafId = requestAnimationFrame(loop);

      const elapsed = ((performance.now() - startWall) / 1000) % duration;
      let idx = elapsed >= frames[lastIdx]?.t ? lastIdx : 0;
      while (idx < frames.length - 1 && frames[idx + 1].t <= elapsed) idx++;
      lastIdx = idx;
      applyFrame(frames[idx]);

      frameCount++;
      const nowMs = performance.now();
      if (nowMs - fpsWindowStart >= 250) {
        const fps = (frameCount * 1000) / (nowMs - fpsWindowStart);
        frameCount = 0;
        fpsWindowStart = nowMs;
        setState((s) => ({ ...s, fps: Math.round(fps) }));
      }
    }
    rafId = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [enabled, recording]);

  return { frameRef, rawFrameRef, debugLandmarksRef, calibrationRef, state };
}
