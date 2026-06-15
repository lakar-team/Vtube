import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { MocapFrame } from "../mocap/types";
import type { BodyCalibration } from "../mocap/bodyCalibration";
import type { MocapState } from "../mocap/useMocap";
import type { ExpressionMapping } from "../vrm/expressionMap";
import { fmtFixed, radToDeg } from "../utils/math";

export interface DebugHUDProps {
  state: MocapState;
  rawFrameRef: MutableRefObject<MocapFrame | null>;
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Body-size calibration (metric scale + derived real-world sizes). */
  calibrationRef: MutableRefObject<BodyCalibration | null>;
  /** Per-model blendshape support summary, once the VRM has loaded. */
  expressionMap?: ExpressionMapping | null;
}

/** Centimeters, rounded; em-dash when unavailable. */
function cm(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toFixed(0);
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
  /** Body-size calibration readout. */
  calibrated: boolean;
  metersPerUnit: number;
  statureCm: number | null;
  headCm: number | null;
  uArmCm: number | null;
  lArmCm: number | null;
  uLegCm: number | null;
  lLegCm: number | null;
  shoulderCm: number | null;
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
  calibrationRef,
  expressionMap,
}: DebugHUDProps) {
  const [sample, setSample] = useState<HudSample | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const raw = rawFrameRef.current;
      const sm = frameRef.current;
      if (!raw || !sm) return;

      // Body-size calibration (metric scale anchored to entered height + the
      // real-world sizes derived from worldLandmarks).
      const cal = calibrationRef.current;

      setSample({
        calibrated: cal?.calibrated ?? false,
        metersPerUnit: cal?.metersPerUnit ?? 1,
        statureCm: cal?.measuredStatureCm ?? null,
        headCm: cal?.headDiameterCm ?? null,
        uArmCm: cal?.upperArmCm ?? null,
        lArmCm: cal?.lowerArmCm ?? null,
        uLegCm: cal?.upperLegCm ?? null,
        lLegCm: cal?.lowerLegCm ?? null,
        shoulderCm: cal?.shoulderWidthCm ?? null,
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
  }, [rawFrameRef, frameRef, calibrationRef]);

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
          <span>calibration</span>
          <strong className={`hud-cell-world ${sample?.calibrated ? "ok" : "bad"}`}>
            {sample?.calibrated
              ? `scale ${sample.metersPerUnit.toFixed(3)} m/u · stature ${cm(sample.statureCm)}cm`
              : "stand back (full body) to calibrate"}
          </strong>
          <span>head ⌀</span>
          <strong className="hud-cell-world">{cm(sample?.headCm)} cm</strong>
        </div>
        <div className="hud-row">
          <span>limbs (cm)</span>
          <strong className="hud-cell-world">
            arm {cm(sample?.uArmCm)}/{cm(sample?.lArmCm)} · leg{" "}
            {cm(sample?.uLegCm)}/{cm(sample?.lLegCm)} · shoulders {cm(sample?.shoulderCm)}
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
