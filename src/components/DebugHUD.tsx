import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { MocapFrame } from "../mocap/types";
import type { MocapState } from "../mocap/useMocap";
import type { ExpressionMapping } from "../vrm/expressionMap";
import { fmt, radToDeg } from "../utils/math";

export interface DebugHUDProps {
  state: MocapState;
  rawFrameRef: MutableRefObject<MocapFrame | null>;
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Per-model blendshape support summary, once the VRM has loaded. */
  expressionMap?: ExpressionMapping | null;
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
  leftHandTracked: boolean;
  rightHandTracked: boolean;
}

/**
 * FPS, tracking confidence, and raw-vs-smoothed channel readouts.
 * Polls the frame refs at 5 Hz instead of re-rendering at video rate.
 */
export function DebugHUD({ state, rawFrameRef, frameRef, expressionMap }: DebugHUDProps) {
  const [sample, setSample] = useState<HudSample | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const raw = rawFrameRef.current;
      const sm = frameRef.current;
      if (!raw || !sm) return;
      setSample({
        rawHead: raw.head,
        smHead: sm.head,
        rawBlinkL: raw.expressions.blinkLeft,
        smBlinkL: sm.expressions.blinkLeft,
        rawAa: raw.expressions.aa,
        smAa: sm.expressions.aa,
        faceTracked: raw.faceTracked,
        poseTracked: raw.poseTracked,
        legsTracked: raw.legsTracked,
        leftHandTracked: raw.hands.leftTracked,
        rightHandTracked: raw.hands.rightTracked,
      });
    }, 200);
    return () => clearInterval(id);
  }, [rawFrameRef, frameRef]);

  return (
    <div className="debug-hud">
      <div className="hud-row">
        <span>status</span>
        <strong className={state.status === "error" ? "bad" : ""}>{state.status}</strong>
        <span>mocap fps</span>
        <strong>{state.fps}</strong>
      </div>
      <div className="hud-row">
        <span>face</span>
        <strong className={sample?.faceTracked ? "ok" : "bad"}>
          {sample?.faceTracked ? `tracked (${state.faceConfidence.toFixed(2)})` : "lost"}
        </strong>
        <span>pose</span>
        <strong className={sample?.poseTracked ? "ok" : "bad"}>
          {sample?.poseTracked ? `tracked (${state.poseConfidence.toFixed(2)})` : "lost"}
        </strong>
      </div>
      <div className="hud-row">
        <span>left hand</span>
        <strong className={sample?.leftHandTracked ? "ok" : "bad"}>
          {sample?.leftHandTracked ? "tracked" : "lost"}
        </strong>
        <span>right hand</span>
        <strong className={sample?.rightHandTracked ? "ok" : "bad"}>
          {sample?.rightHandTracked ? "tracked" : "lost"}
        </strong>
        <span>legs</span>
        <strong className={sample?.legsTracked ? "ok" : "bad"}>
          {sample?.legsTracked ? `tracked (${state.legsConfidence.toFixed(2)})` : "out of frame"}
        </strong>
      </div>
      {sample && (
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
              <td>
                {fmt(radToDeg(sample.rawHead.x))} / {fmt(radToDeg(sample.rawHead.y))} /{" "}
                {fmt(radToDeg(sample.rawHead.z))}
              </td>
              <td>
                {fmt(radToDeg(sample.smHead.x))} / {fmt(radToDeg(sample.smHead.y))} /{" "}
                {fmt(radToDeg(sample.smHead.z))}
              </td>
            </tr>
            <tr>
              <td>blink L</td>
              <td>{sample.rawBlinkL.toFixed(2)}</td>
              <td>{sample.smBlinkL.toFixed(2)}</td>
            </tr>
            <tr>
              <td>mouth aa</td>
              <td>{sample.rawAa.toFixed(2)}</td>
              <td>{sample.smAa.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {expressionMap && (
        <div className="hud-row hud-expr-support">
          <span>blendshapes</span>
          <strong>
            {expressionMap.map.size}/{expressionMap.total} supported
          </strong>
        </div>
      )}
      {expressionMap && expressionMap.unsupported.length > 0 && (
        <div className="hud-warning">
          This model doesn't support {expressionMap.unsupported.length} mocap
          channel{expressionMap.unsupported.length === 1 ? "" : "s"} (skipped):{" "}
          {expressionMap.unsupported.join(", ")}
        </div>
      )}
      {state.error && <div className="hud-error">{state.error}</div>}
    </div>
  );
}
