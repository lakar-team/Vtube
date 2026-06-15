import { useRef, useState } from "react";
import { WebcamView } from "./components/WebcamView";
import { AvatarViewport, type ViewMode } from "./components/AvatarViewport";
import { FaceMeshDebugView } from "./components/FaceMeshDebugView";
import { SkeletonViewport } from "./components/SkeletonViewport";
import { RoomViewport } from "./components/RoomViewport";
import { DebugHUD } from "./components/DebugHUD";
import { useWebcam } from "./hooks/useWebcam";
import { useMocap } from "./mocap/useMocap";
import type { ExpressionMapping } from "./vrm/expressionMap";

type DisplayMode = "avatar" | "skeleton" | "both" | "room";
const DISPLAY_MODE_KEY = "vtube.displayMode";

function loadDisplayMode(): DisplayMode {
  try {
    const v = localStorage.getItem(DISPLAY_MODE_KEY) as DisplayMode | null;
    return v === "avatar" || v === "skeleton" || v === "both" || v === "room" ? v : "avatar";
  } catch {
    return "avatar";
  }
}

const HEIGHT_KEY = "vtube.heightCm";
const DEFAULT_HEIGHT_CM = 170;

function loadHeightCm(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v >= 50 && v <= 250 ? v : DEFAULT_HEIGHT_CM;
  } catch {
    return DEFAULT_HEIGHT_CM;
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [mirror, setMirror] = useState(true);
  const [showOverlay, setShowOverlay] = useState(true);
  const [trackLegs, setTrackLegs] = useState(true);
  const viewMode: ViewMode = "bust";
  const [displayMode, setDisplayMode] = useState<DisplayMode>(loadDisplayMode);
  const [heightCm, setHeightCm] = useState<number>(loadHeightCm);
  const [expressionMap, setExpressionMap] = useState<ExpressionMapping | null>(null);

  const webcam = useWebcam(videoRef);
  const mocap = useMocap(videoRef, {
    mirror,
    trackLegs,
    enabled: webcam.ready,
    heightCm,
  });

  const changeDisplayMode = (v: DisplayMode) => {
    setDisplayMode(v);
    try { localStorage.setItem(DISPLAY_MODE_KEY, v); } catch { /* privacy mode */ }
  };

  const changeHeightCm = (v: number) => {
    setHeightCm(v);
    try { localStorage.setItem(HEIGHT_KEY, String(v)); } catch { /* privacy mode */ }
  };

  return (
    <div className="app">
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
              checked={showOverlay}
              onChange={(e) => setShowOverlay(e.target.checked)}
            />
            landmark overlay
          </label>
          <label className="toggle" title="Your real standing height — anchors the metric body calibration for the 3D Room View.">
            height
            <input
              type="number"
              min={50}
              max={250}
              step={1}
              value={heightCm}
              onChange={(e) => changeHeightCm(Number(e.target.value))}
              style={{ width: "3.5em" }}
            />
            cm
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
              <option value="room">room (3D)</option>
            </select>
          </label>
        </div>
      </header>

      <main className={`panes${displayMode === "both" ? " panes-three" : ""}`}>
        <section className="pane pane-left">
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
          <section className="pane pane-avatar">
            <div className="avatar-stack-top">
              <AvatarViewport
                frameRef={mocap.frameRef}
                viewMode={viewMode}
                onExpressionMap={setExpressionMap}
              />
            </div>
            <div className="avatar-stack-bottom">
              <FaceMeshDebugView debugLandmarksRef={mocap.debugLandmarksRef} />
            </div>
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

        {displayMode === "room" && (
          <section className="pane">
            <RoomViewport
              debugLandmarksRef={mocap.debugLandmarksRef}
              calibrationRef={mocap.calibrationRef}
              mirror={mirror}
              heightCm={heightCm}
            />
          </section>
        )}
      </main>

      <footer>
        <DebugHUD
          state={mocap.state}
          rawFrameRef={mocap.rawFrameRef}
          frameRef={mocap.frameRef}
          calibrationRef={mocap.calibrationRef}
          expressionMap={expressionMap}
        />
      </footer>
    </div>
  );
}
