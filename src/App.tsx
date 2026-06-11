import { useRef, useState } from "react";
import { WebcamView } from "./components/WebcamView";
import { AvatarViewport } from "./components/AvatarViewport";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { DebugHUD } from "./components/DebugHUD";
import { useWebcam } from "./hooks/useWebcam";
import { useMocap } from "./mocap/useMocap";
import type { ExpressionMapping } from "./vrm/expressionMap";

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [mirror, setMirror] = useState(true);
  const [showOverlay, setShowOverlay] = useState(true);
  const [expressionMap, setExpressionMap] = useState<ExpressionMapping | null>(null);

  const webcam = useWebcam(videoRef);
  const mocap = useMocap(videoRef, { mirror, enabled: webcam.ready });

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          vtube <span className="sub">milestone 1 — webcam mocap</span>
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
              checked={showOverlay}
              onChange={(e) => setShowOverlay(e.target.checked)}
            />
            landmark overlay
          </label>
          <CalibrationPanel
            calibrating={mocap.state.calibrating}
            calibrated={mocap.state.calibrated}
            faceTracked={mocap.state.faceConfidence > 0}
            onCalibrate={mocap.calibrate}
            onClear={mocap.clearCalibration}
          />
        </div>
      </header>

      <main className="panes">
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

        <section className="pane">
          <AvatarViewport frameRef={mocap.frameRef} onExpressionMap={setExpressionMap} />
        </section>
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
