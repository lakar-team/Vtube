import { useEffect, useRef, useState } from "react";
import { WebcamView } from "./components/WebcamView";
import { AvatarViewport, type ViewMode } from "./components/AvatarViewport";
import { SkeletonViewport } from "./components/SkeletonViewport";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { DebugHUD } from "./components/DebugHUD";
import { useWebcam } from "./hooks/useWebcam";
import { useMocap } from "./mocap/useMocap";
import { TORSO_PITCH_SOURCES, type TorsoPitchSource } from "./mocap/types";
import { BODY_POSE_SEQUENCE, type CalibrationPoseDef } from "./mocap/calibration";
import type { ExpressionMapping } from "./vrm/expressionMap";

type DisplayMode = "avatar" | "skeleton" | "both";
const DISPLAY_MODE_KEY = "vtube.displayMode";

const PITCH_SOURCE_KEY = "vtube.torsoPitchSource";
const DIRECT_MODE_KEY = "vtube.directMode";

function loadPitchSource(): TorsoPitchSource {
  try {
    const v = localStorage.getItem(PITCH_SOURCE_KEY) as TorsoPitchSource | null;
    return v && TORSO_PITCH_SOURCES.includes(v) ? v : "hybrid";
  } catch {
    return "hybrid";
  }
}

function loadDirectMode(): boolean {
  try {
    const v = localStorage.getItem(DIRECT_MODE_KEY);
    // Default to true — direct mode is the new intended experience.
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function loadDisplayMode(): DisplayMode {
  try {
    const v = localStorage.getItem(DISPLAY_MODE_KEY) as DisplayMode | null;
    return v === "avatar" || v === "skeleton" || v === "both" ? v : "avatar";
  } catch {
    return "avatar";
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [mirror, setMirror] = useState(true);
  const [showOverlay, setShowOverlay] = useState(true);
  const [trackLegs, setTrackLegs] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("full");
  const [torsoPitchSource, setTorsoPitchSource] = useState<TorsoPitchSource>(loadPitchSource);
  const [directMode, setDirectMode] = useState<boolean>(loadDirectMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(loadDisplayMode);
  const [expressionMap, setExpressionMap] = useState<ExpressionMapping | null>(null);

  const webcam = useWebcam(videoRef);
  const mocap = useMocap(videoRef, {
    mirror,
    trackLegs,
    torsoPitchSource,
    enabled: webcam.ready,
    directMode,
  });

  const changeDirectMode = (v: boolean) => {
    setDirectMode(v);
    try { localStorage.setItem(DIRECT_MODE_KEY, v ? "1" : "0"); } catch { /* privacy mode */ }
  };

  const changeDisplayMode = (v: DisplayMode) => {
    setDisplayMode(v);
    try { localStorage.setItem(DISPLAY_MODE_KEY, v); } catch { /* privacy mode */ }
  };

  const changePitchSource = (v: TorsoPitchSource) => {
    setTorsoPitchSource(v);
    try {
      localStorage.setItem(PITCH_SOURCE_KEY, v);
    } catch {
      // privacy mode — preference just won't persist
    }
  };

  // While body calibration runs, the avatar demonstrates the current pose.
  const demoPose: CalibrationPoseDef | null = mocap.state.bodyPose?.pose ?? null;

  // Dev aid: preview the calibration demo poses without a webcam/tracked
  // body (window.__vtubeDemoPose("neutral" | "raise" | "bow" | null)).
  const [devDemoPose, setDevDemoPose] = useState<CalibrationPoseDef | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__vtubeDemoPose = (
      id: string | null,
    ) => setDevDemoPose(BODY_POSE_SEQUENCE.find((p) => p.id === id) ?? null);
    return () => {
      delete (window as unknown as Record<string, unknown>).__vtubeDemoPose;
    };
  }, []);

  const bodyPose = mocap.state.bodyPose;

  return (
    <div className="app">
      {/* Large countdown overlay — visible from across the room. */}
      {mocap.state.calibrating === "body" && bodyPose && (
        <div className="calib-overlay">
          <div className="calib-overlay-step">
            pose {bodyPose.index + 1}/{bodyPose.total} — {bodyPose.pose.title}
          </div>
          {bodyPose.phase === "countdown" ? (
            <>
              <div className="calib-overlay-number">{bodyPose.countdown}</div>
              <div className="calib-overlay-instruction">
                {bodyPose.pose.instruction}
              </div>
            </>
          ) : (
            <>
              <div className="calib-overlay-hold">Hold it!</div>
              <div className="calib-overlay-progress-track">
                <div
                  className="calib-overlay-progress-bar"
                  style={{ width: `${Math.round(bodyPose.progress * 100)}%` }}
                />
              </div>
            </>
          )}
        </div>
      )}
      <header className="topbar">
        <h1>
          vtube <span className="sub">milestone 2 — full-body mocap</span>{" "}
          <span className="sub" style={{ opacity: 0.45, fontSize: "0.65em" }}>vtubemaker</span>
        </h1>
        <div className="controls">
          <label className="toggle">
            <input
              type="checkbox"
              checked={mirror}
              onChange={(e) => setMirror(e.target.checked)}
            />
            mirror
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={trackLegs}
              onChange={(e) => setTrackLegs(e.target.checked)}
            />
            legs
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={viewMode === "full"}
              onChange={(e) => setViewMode(e.target.checked ? "full" : "bust")}
            />
            full-body view
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={showOverlay}
              onChange={(e) => setShowOverlay(e.target.checked)}
            />
            landmark overlay
          </label>
          <label
            className="toggle"
            title={
              "Tracking mode:\n" +
              "• direct — avatar responds in real time, 1:1 with mocap (may jitter with poor lighting)\n" +
              "• stabilized — filters + slew limits smooth out jitter at the cost of some lag"
            }
          >
            <input
              type="checkbox"
              checked={directMode}
              onChange={(e) => changeDirectMode(e.target.checked)}
            />
            direct
          </label>
          <label
            className="toggle"
            title={
              "How torso pitch (bowing) is estimated:\n" +
              "• mediapipe z — depth from MediaPipe's 3D estimate (direct, but underreads deep bows)\n" +
              "• apparent size — torso foreshortening in the image (robust, needs body calibration or a moment standing upright)\n" +
              "• hybrid — whichever reports the larger bend (recommended)"
            }
          >
            bow
            <select
              value={torsoPitchSource}
              onChange={(e) => changePitchSource(e.target.value as TorsoPitchSource)}
            >
              <option value="hybrid">hybrid</option>
              <option value="size">apparent size</option>
              <option value="z">mediapipe z</option>
            </select>
          </label>
          <label
            className="toggle"
            title={
              "Which view to show in the right pane:\n" +
              "• avatar — VRM avatar driven by retargeted mocap\n" +
              "• skeleton — raw MediaPipe landmark positions (no retargeting)\n" +
              "• both — avatar + skeleton side by side for direct comparison\n\n" +
              "If the skeleton moves correctly but the avatar doesn't, the issue is in\n" +
              "the retargeting layer. If both look wrong, the issue is upstream in\n" +
              "landmark capture or smoothing."
            }
          >
            view
            <select
              value={displayMode}
              onChange={(e) => changeDisplayMode(e.target.value as DisplayMode)}
            >
              <option value="avatar">avatar</option>
              <option value="skeleton">skeleton</option>
              <option value="both">both</option>
            </select>
          </label>
          <CalibrationPanel
            calibrating={mocap.state.calibrating}
            bodyPose={mocap.state.bodyPose}
            faceCalibrated={mocap.state.faceCalibrated}
            bodyCalibrated={mocap.state.bodyCalibrated}
            faceTracked={mocap.state.faceConfidence > 0}
            poseTracked={mocap.state.poseConfidence > 0.5}
            onCalibrate={mocap.calibrate}
            onSkipPose={mocap.skipPose}
            onCancel={mocap.cancelCalibration}
            onClear={mocap.clearCalibration}
          />
        </div>
      </header>

      <main className={`panes${displayMode === "both" ? " panes-three" : ""}`}>
        <section className="pane">
          <WebcamView
            videoRef={videoRef}
            debugLandmarksRef={mocap.debugLandmarksRef}
            mirror={mirror}
            showOverlay={showOverlay}
          />
          {webcam.error && <div className="pane-error">{webcam.error}</div>}
          {!webcam.ready && !webcam.error && (
            <div className="pane-status">Waiting for camera…</div>
          )}
        </section>

        {(displayMode === "avatar" || displayMode === "both") && (
          <section className="pane">
            <AvatarViewport
              frameRef={mocap.frameRef}
              viewMode={viewMode}
              demoPose={demoPose ?? devDemoPose}
              onExpressionMap={setExpressionMap}
              directMode={directMode}
            />
          </section>
        )}

        {(displayMode === "skeleton" || displayMode === "both") && (
          <section className="pane">
            <SkeletonViewport
              debugLandmarksRef={mocap.debugLandmarksRef}
              mirror={mirror}
            />
          </section>
        )}
      </main>

      <footer>
        <DebugHUD
          state={mocap.state}
          rawFrameRef={mocap.rawFrameRef}
          frameRef={mocap.frameRef}
          expressionMap={expressionMap}
        />
      </footer>
    </div>
  );
}
