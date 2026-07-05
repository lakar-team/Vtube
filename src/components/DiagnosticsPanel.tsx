import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { FKPositions, LoadedModel } from "../render/GlbBoneDriver";
import {
  staticChecks, captureCalibration, applyFix, exportCorrectedRecipe,
  type DiagIssue, type CalibReport,
} from "../diag/rigDiagnostics";

/**
 * Bridge between DiagnosticsPanel and RoomViewport's render loop: set
 * `collecting = true` (with `samples`/`startedAt` reset) to ask the render
 * loop to start pushing this frame's FKPositions into `samples`. The render
 * loop flips `collecting` back to false once ~1s of frames has been buffered.
 * Same on-demand-buffer pattern as the existing frameRef/debugLandmarksRef refs.
 */
export interface CalibrationRequest {
  collecting: boolean;
  samples: FKPositions[];
  startedAt: number | null;
}

const COLLECT_MS = 1000;
const COUNTDOWN_FROM = 3;

type Phase = "idle" | "countdown" | "collecting" | "reviewing";

export interface DiagnosticsPanelProps {
  /** Currently loaded GLB model, or null if none/still loading. */
  model: LoadedModel | null;
  /** Shared with RoomViewport's render loop — see CalibrationRequest. */
  calibRequestRef: MutableRefObject<CalibrationRequest | null>;
  /** Pause/unpause live bone driving (bubbles up to the Rules Inspector's pauseBoneDriving flag). */
  onSetPause: (paused: boolean) => void;
}

export function DiagnosticsPanel({ model, calibRequestRef, onSetPause }: DiagnosticsPanelProps) {
  const [staticIssues, setStaticIssues] = useState<DiagIssue[]>([]);
  const [bannerVisible, setBannerVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdownN, setCountdownN] = useState(COUNTDOWN_FROM);
  const [report, setReport] = useState<CalibReport | null>(null);
  const lastSamplesRef = useRef<FKPositions[]>([]);
  const pausedByUsRef = useRef(false);

  // Re-run static checks whenever a (new) model finishes loading.
  useEffect(() => {
    if (!model) { setBannerVisible(false); return; }
    const issues = staticChecks(model);
    setStaticIssues(issues);
    setBannerVisible(true);
    if (issues.length === 0) {
      const t = window.setTimeout(() => setBannerVisible(false), 5000);
      return () => window.clearTimeout(t);
    }
  }, [model]);

  // Reset the calibration flow whenever the model changes out from under it.
  useEffect(() => {
    setPhase("idle");
    setReport(null);
    calibRequestRef.current = null;
    if (pausedByUsRef.current) { onSetPause(false); pausedByUsRef.current = false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // Countdown ticker: 3, 2, 1, then hand off to the render loop to collect.
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdownN <= 0) {
      calibRequestRef.current = { collecting: true, samples: [], startedAt: null };
      setPhase("collecting");
      return;
    }
    const t = window.setTimeout(() => setCountdownN((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [phase, countdownN, calibRequestRef]);

  // Poll for the render loop finishing the FK buffer, then run calibration.
  useEffect(() => {
    if (phase !== "collecting") return;
    const poll = window.setInterval(() => {
      const req = calibRequestRef.current;
      if (!req || req.collecting) return;
      window.clearInterval(poll);
      lastSamplesRef.current = req.samples;
      const rep = model ? captureCalibration(model, req.samples) : { rows: [], fixes: [] };
      setReport(rep);
      setPhase("reviewing");
    }, 100);
    return () => window.clearInterval(poll);
  }, [phase, model, calibRequestRef]);

  const startCalibration = () => {
    if (!model?.vtubeRig || phase !== "idle") return;
    pausedByUsRef.current = true;
    onSetPause(true);
    setCountdownN(COUNTDOWN_FROM);
    setPhase("countdown");
  };

  const cancelCalibration = () => {
    calibRequestRef.current = null;
    setPhase("idle");
    setReport(null);
    if (pausedByUsRef.current) { onSetPause(false); pausedByUsRef.current = false; }
  };

  const applyFixes = () => {
    if (!model?.vtubeRig || !report || report.fixes.length === 0) return;
    for (const fix of report.fixes) applyFix(model.vtubeRig, fix);
    if (pausedByUsRef.current) { onSetPause(false); pausedByUsRef.current = false; }
    // Re-score against the SAME buffered T-pose samples so the table reflects
    // the fix immediately, with no need for another countdown/collection pass.
    setReport(captureCalibration(model, lastSamplesRef.current));
  };

  const downloadRecipe = () => {
    if (!model?.vtubeRig) return;
    const json = exportCorrectedRecipe(model.vtubeRig);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vtubeRig-corrected.json";
    a.click();
    URL.revokeObjectURL(url);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!model) return null;

  const hasWarn = staticIssues.some((iss) => iss.severity === "warn");
  const bannerClass = staticIssues.length === 0 ? "ok" : hasWarn ? "warn" : "info";

  return (
    <div className="diag-panel">
      {bannerVisible && (
        <div className={`diag-banner ${bannerClass}`}>
          {staticIssues.length === 0 ? (
            <span>rig check: no issues found</span>
          ) : (
            <>
              <div className="diag-banner-title">
                rig check: {staticIssues.length} issue{staticIssues.length === 1 ? "" : "s"}
                {!hasWarn && " (info only — model still moves correctly)"}
              </div>
              <ul className="diag-issue-list">
                {staticIssues.map((iss, i) => (
                  <li key={i} className={iss.severity === "info" ? "diag-issue-info" : undefined}>{iss.message}</li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="btn diag-dismiss" onClick={() => setBannerVisible(false)}>×</button>
        </div>
      )}

      {phase === "idle" && (
        <button
          type="button"
          className="btn diag-calibrate-btn"
          data-wizard="calibrate-btn"
          onClick={startCalibration}
          disabled={!model.vtubeRig}
        >
          Calibrate (T-pose)
        </button>
      )}

      {(phase === "countdown" || phase === "collecting") && (
        <div className="diag-countdown-overlay" aria-hidden="true">
          {phase === "countdown" ? (
            <>
              <div className="diag-countdown-num">{countdownN}</div>
              <div className="diag-countdown-label">Hold a T-pose…</div>
            </>
          ) : (
            <div className="diag-countdown-label">Capturing…</div>
          )}
          <button type="button" className="btn" onClick={cancelCalibration}>cancel</button>
        </div>
      )}

      {phase === "reviewing" && report && (
        <div className="diag-report">
          <div className="diag-report-header">
            <span>T-pose calibration ({report.rows.length} driven bones checked)</span>
            <button type="button" className="btn diag-dismiss" onClick={cancelCalibration}>×</button>
          </div>
          <table className="diag-table">
            <thead>
              <tr><th>bone</th><th>joint pair</th><th>error°</th><th>suggestion</th></tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.boneName}>
                  <td>{r.boneName}</td>
                  <td>{r.jointFrom && r.jointTo ? `${r.jointFrom} → ${r.jointTo}` : "—"}</td>
                  <td className={r.errDeg > 20 ? "bad" : undefined}>{r.errDeg.toFixed(1)}</td>
                  <td>{r.suggestion ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="diag-report-actions">
            <button type="button" className="btn primary" onClick={applyFixes} disabled={report.fixes.length === 0}>
              Apply suggested fixes ({report.fixes.length})
            </button>
            <button type="button" className="btn" onClick={downloadRecipe}>
              Download corrected recipe JSON
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
