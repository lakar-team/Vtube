import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { DebugLandmarks, MocapFrame } from "../mocap/types";
import type { MocapState } from "../mocap/useMocap";
import type { ExpressionMapping } from "../vrm/expressionMap";
import { fmtFixed, radToDeg } from "../utils/math";

export interface DebugHUDProps {
  state: MocapState;
  rawFrameRef: MutableRefObject<MocapFrame | null>;
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Raw landmark arrays — used here for the metric world-landmark sanity row. */
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  /** Per-model blendshape support summary, once the VRM has loaded. */
  expressionMap?: ExpressionMapping | null;
}

/** Euclidean distance between two {x,y,z} points. */
function dist3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Meters, fixed width. */
function m(v: number | null | undefined): string {
  return v === null || v === undefined ? "  —" : v.toFixed(2);
}

interface HudSample {
  rawHead: { x: number; y: number; z: number };
  smHead: { x: number; y: number; z: number };
  rawBlinkL: number;
  smBlinkL: number;
  rawAa: number;
  smAa: number;
  faceTracked: boolean;
  poseTracked: boolean;
  legsTracked: boolean;
  leftArmTracked: boolean;
  rightArmTracked: boolean;
  leftHandTracked: boolean;
  rightHandTracked: boolean;
  /** Metric world-landmark sanity numbers (meters, pre-calibration). */
  worldShoulders: number | null;
  worldSpan: number | null;
}

/** Degrees, fixed width — readouts must never change the HUD's size. */
function deg(rad: number | undefined): string {
  return rad === undefined ? "     —" : fmtFixed(radToDeg(rad), 6);
}

/** 0..1 value, fixed width. */
function val(v: number | undefined): string {
  return v === undefined ? "   —" : v.toFixed(2).padStart(4, " ");
}

/**
 * FPS, tracking confidence, and raw-vs-smoothed channel readouts.
 * Polls the frame refs at 5 Hz instead of re-rendering at video rate.
 *
 * LAYOUT CONTRACT: the HUD lives in the page footer and the panes above it
 * are sized off the leftover space, so the HUD must keep a constant size no
 * matter what it displays. Every row/table below renders unconditionally
 * (placeholders before the first sample), every number is fixed-width, and
 * every variable label sits in a min-width cell (see index.css .hud-*).
 */
export function DebugHUD({
  state,
  rawFrameRef,
  frameRef,
  debugLandmarksRef,
  expressionMap,
}: DebugHUDProps) {
  const [sample, setSample] = useState<HudSample | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const raw = rawFrameRef.current;
      const sm = frameRef.current;
      if (!raw || !sm) return;

      // Metric world-landmark sanity check (meters, raw MediaPipe scale).
      // Shoulder width and nose→ankle span confirm worldLandmarks are flowing
      // and roughly real-sized — the basis for Phase 2 height calibration.
      const pw = debugLandmarksRef.current.poseWorld;
      let worldShoulders: number | null = null;
      let worldSpan: number | null = null;
      if (pw && pw.length >= 33) {
        worldShoulders = dist3(pw[11], pw[12]);
        const ankleMid = {
          x: (pw[27].x + pw[28].x) / 2,
          y: (pw[27].y + pw[28].y) / 2,
          z: (pw[27].z + pw[28].z) / 2,
        };
        worldSpan = dist3(pw[0], ankleMid);
      }

      setSample({
        worldShoulders,
        worldSpan,
        rawHead: raw.head,
        smHead: sm.head,
        rawBlinkL: raw.expressions.blinkLeft,
        smBlinkL: sm.expressions.blinkLeft,
        rawAa: raw.expressions.aa,
        smAa: sm.expressions.aa,
        faceTracked: raw.faceTracked,
        poseTracked: raw.poseTracked,
        legsTracked: raw.legsTracked,
        leftArmTracked: raw.armsTracked.left,
        rightArmTracked: raw.armsTracked.right,
        leftHandTracked: raw.hands.leftTracked,
        rightHandTracked: raw.hands.rightTracked,
      });
    }, 200);
    return () => clearInterval(id);
  }, [rawFrameRef, frameRef, debugLandmarksRef]);

  return (
    <div className="debug-hud">
      <div className="hud-col">
        <div className="hud-row">
          <span>status</span>
          <strong className={`hud-cell-status ${state.status === "error" ? "bad" : ""}`}>
            {state.status}
          </strong>
          <span>mocap fps</span>
          <strong className="hud-cell-fps">{state.fps}</strong>
        </div>
        <div className="hud-row">
          <span>face</span>
          <strong className={`hud-cell-conf ${sample?.faceTracked ? "ok" : "bad"}`}>
            {sample?.faceTracked ? `tracked (${state.faceConfidence.toFixed(2)})` : "lost"}
          </strong>
          <span>pose</span>
          <strong className={`hud-cell-conf ${sample?.poseTracked ? "ok" : "bad"}`}>
            {sample?.poseTracked ? `tracked (${state.poseConfidence.toFixed(2)})` : "lost"}
          </strong>
        </div>
        <div className="hud-row">
          <span>arms L/R</span>
          <strong className="hud-cell-arms">
            <span className={sample?.leftArmTracked ? "ok" : "bad"}>
              {sample?.leftArmTracked ? "ok" : "——"}
            </span>
            {" / "}
            <span className={sample?.rightArmTracked ? "ok" : "bad"}>
              {sample?.rightArmTracked ? "ok" : "——"}
            </span>
          </strong>
          <span>hands L/R</span>
          <strong className="hud-cell-arms">
            <span className={sample?.leftHandTracked ? "ok" : "bad"}>
              {sample?.leftHandTracked ? "ok" : "——"}
            </span>
            {" / "}
            <span className={sample?.rightHandTracked ? "ok" : "bad"}>
              {sample?.rightHandTracked ? "ok" : "——"}
            </span>
          </strong>
          <span>legs</span>
          <strong className={`hud-cell-conf ${sample?.legsTracked ? "ok" : "bad"}`}>
            {sample?.legsTracked
              ? `tracked (${state.legsConfidence.toFixed(2)})`
              : "out of frame"}
          </strong>
        </div>
        <div className="hud-row hud-expr-support">
          <span>blendshapes</span>
          <strong>
            {expressionMap ? `${expressionMap.map.size}/${expressionMap.total} supported` : "—"}
          </strong>
        </div>
        <div className="hud-row">
          <span>world (m)</span>
          <strong className="hud-cell-world">
            shoulders {m(sample?.worldShoulders)} · nose→ankle {m(sample?.worldSpan)}
          </strong>
        </div>
      </div>
      <table className="hud-table">
        <thead>
          <tr>
            <th>channel</th>
            <th>raw</th>
            <th>smoothed</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>head pitch / yaw / roll (deg)</td>
            <td className="num">
              {deg(sample?.rawHead.x)} / {deg(sample?.rawHead.y)} / {deg(sample?.rawHead.z)}
            </td>
            <td className="num">
              {deg(sample?.smHead.x)} / {deg(sample?.smHead.y)} / {deg(sample?.smHead.z)}
            </td>
          </tr>
          <tr>
            <td>blink L</td>
            <td className="num">{val(sample?.rawBlinkL)}</td>
            <td className="num">{val(sample?.smBlinkL)}</td>
          </tr>
          <tr>
            <td>mouth aa</td>
            <td className="num">{val(sample?.rawAa)}</td>
            <td className="num">{val(sample?.smAa)}</td>
          </tr>
        </tbody>
      </table>
      {((expressionMap && expressionMap.unsupported.length > 0) || state.error) && (
        <div className="hud-notes">
          {expressionMap && expressionMap.unsupported.length > 0 && (
            <div className="hud-warning">
              This model doesn't support {expressionMap.unsupported.length} mocap
              channel{expressionMap.unsupported.length === 1 ? "" : "s"} (skipped):{" "}
              {expressionMap.unsupported.join(", ")}
            </div>
          )}
          {state.error && <div className="hud-error">{state.error}</div>}
        </div>
      )}
    </div>
  );
}
