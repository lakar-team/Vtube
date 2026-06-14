import { useRef, useState } from "react";
import { WebcamView } from "./components/WebcamView";
import { AvatarViewport, type ViewMode, type TrackingMode } from "./components/AvatarViewport";
import { SkeletonViewport } from "./components/SkeletonViewport";
import { DebugHUD } from "./components/DebugHUD";
import { useWebcam } from "./hooks/useWebcam";
import { useMocap } from "./mocap/useMocap";
import type { ExpressionMapping } from "./vrm/expressionMap";

type DisplayMode = "avatar" | "skeleton" | "both";
const DISPLAY_MODE_KEY   = "vtube.displayMode";
const TRACKING_MODE_KEY  = "vtube.trackingMode";

function loadTrackingMode(): TrackingMode {
  try {
    const v = localStorage.getItem(TRACKING_MODE_KEY) as TrackingMode | null;
    if (v === "stabilized" || v === "direct" || v === "positional") return v;
    // Migrate from old boolean directMode key.
    const old = localStorage.getItem("vtube.directMode");
    return old === "0" ? "stabilized" : "direct";
  } catch {
    return "direct";
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
  const [trackingMode, setTrackingMode] = useState<TrackingMode>(loadTrackingMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(loadDisplayMode);
  const [expressionMap, setExpressionMap] = useState<ExpressionMapping | null>(null);

  const webcam = useWebcam(videoRef);
  const mocap = useMocap(videoRef, {
    mirror,
    trackLegs,
    enabled: webcam.ready,
    // Both "direct" and "positional" bypass smoothing in the pipeline.
    directMode: trackingMode !== "stabilized",
  });

  const changeTrackingMode = (v: TrackingMode) => {
    setTrackingMode(v);
    try { localStorage.setItem(TRACKING_MODE_KEY, v); } catch { /* privacy mode */ }
  };

  const changeDisplayMode = (v: DisplayMode) => {
    setDisplayMode(v);
    try { localStorage.setItem(DISPLAY_MODE_KEY, v); } catch { /* privacy mode */ }
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
              "• stabilized — One Euro filter + lerps: smooth, slight lag\n" +
              "• direct — raw mocap passthrough: responsive, may jitter\n" +
              "• positional — bypass Kalidokit IK; orient bones directly from\n" +
              "  landmark positions (same 3D space as the skeleton diagnostic)"
            }
          >
            tracking
            <select
              value={trackingMode}
              onChange={(e) => changeTrackingMode(e.target.value as TrackingMode)}
            >
              <option value="stabilized">stabilized</option>
              <option value="direct">direct</option>
              <option value="positional">positional</option>
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
              debugLandmarksRef={mocap.debugLandmarksRef}
              viewMode={viewMode}
              onExpressionMap={setExpressionMap}
              trackingMode={trackingMode}
              mirror={mirror}
            />
          </section>
        )}

        {(displayMode === "skeleton" || displayMode === "both") && (
          <section className="pane">
            <SkeletonViewport
              debugLandmarksRef={mocap.debugLandmarksRef}
              frameRef={mocap.frameRef}
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
