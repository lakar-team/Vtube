import { useEffect, useRef, useState } from "react";
import { WebcamView } from "./components/WebcamView";
import { AvatarViewport, type ViewMode } from "./components/AvatarViewport";
import { FaceMeshDebugView } from "./components/FaceMeshDebugView";
import { RoomViewport } from "./components/RoomViewport";
import { RigTuner } from "./components/RigTuner";
import { DebugHUD } from "./components/DebugHUD";
import { useWebcam } from "./hooks/useWebcam";
import { useMocap } from "./mocap/useMocap";
import {
  captureRigConfig, loadRigConfig, saveRigConfig,
  DEFAULT_RIG, type RigConfig, type RigNumKey,
} from "./mocap/rig";
import type { ExpressionMapping } from "./vrm/expressionMap";

type DisplayMode = "avatar" | "both" | "room" | "tuner";
const DISPLAY_MODE_KEY = "vtube.displayMode";

function loadDisplayMode(): DisplayMode {
  try {
    const v = localStorage.getItem(DISPLAY_MODE_KEY) as DisplayMode | null;
    return v === "avatar" || v === "both" || v === "room" || v === "tuner" ? v : "room";
  } catch {
    return "room";
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

const ROOM_KEY = "vtube.roomM";
const DEFAULT_ROOM_M = 2.5;

function loadRoomM(): number {
  try {
    const v = Number(localStorage.getItem(ROOM_KEY));
    return Number.isFinite(v) && v >= 0.5 && v <= 50 ? v : DEFAULT_ROOM_M;
  } catch {
    return DEFAULT_ROOM_M;
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
  const [roomM, setRoomM] = useState<number>(loadRoomM);
  const [rigConfig, setRigConfig] = useState<RigConfig>(loadRigConfig);
  const rigConfigRef = useRef(rigConfig);
  rigConfigRef.current = rigConfig;
  const [countdown, setCountdown] = useState<number | null>(null);
  const captureTimerRef = useRef<number | null>(null);
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

  const changeRoomM = (v: number) => {
    setRoomM(v);
    try { localStorage.setItem(ROOM_KEY, String(v)); } catch { /* privacy mode */ }
  };

  // ── one-time scale capture: 5s countdown, then snapshot proportions once.
  const startCapture = () => {
    if (countdown !== null) return;
    let n = 5;
    setCountdown(n);
    captureTimerRef.current = window.setInterval(() => {
      n -= 1;
      if (n > 0) { setCountdown(n); return; }
      if (captureTimerRef.current !== null) window.clearInterval(captureTimerRef.current);
      captureTimerRef.current = null;
      setCountdown(null);
      const pw = mocap.debugLandmarksRef.current.poseWorld;
      const mpu = mocap.calibrationRef.current?.metersPerUnit ?? 1;
      const cfg = captureRigConfig(pw, mpu, heightCm, Date.now(), rigConfigRef.current);
      if (cfg) {
        setRigConfig(cfg);
        saveRigConfig(cfg);
      } else {
        console.warn("[scale capture] failed — stand fully in frame and retry");
      }
    }, 1000);
  };

  useEffect(() => () => {
    if (captureTimerRef.current !== null) window.clearInterval(captureTimerRef.current);
  }, []);

  const changeRigField = (key: RigNumKey, value: number) => {
    setRigConfig((prev) => {
      const next = { ...prev, [key]: value };
      saveRigConfig(next);
      return next;
    });
  };

  const resetRig = () => {
    const next = { ...DEFAULT_RIG };
    setRigConfig(next);
    saveRigConfig(next);
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
          <label className="toggle" title="3D Room View cube size (meters). Increase for large/'giant robot' scenes.">
            room
            <input
              type="number"
              min={0.5}
              max={50}
              step={0.5}
              value={roomM}
              onChange={(e) => changeRoomM(Number(e.target.value))}
              style={{ width: "3.5em" }}
            />
            m
          </label>
          <label
            className="toggle"
            title={
              "Which view to show in the right pane(s):\n" +
              "• room — metric 3D mannequin in a scaled room (drag to orbit)\n" +
              "• tuner — mannequin + sliders to adjust rig proportions\n" +
              "• avatar — VRM avatar driven by retargeted mocap\n" +
              "• both — avatar + 3D room side by side for direct comparison"
            }
          >
            view
            <select
              value={displayMode}
              onChange={(e) => changeDisplayMode(e.target.value as DisplayMode)}
            >
              <option value="room">room (3D)</option>
              <option value="tuner">skeleton &amp; tuner</option>
              <option value="avatar">avatar</option>
              <option value="both">both (avatar + room)</option>
            </select>
          </label>
          <button
            type="button"
            className="capture-btn"
            onClick={startCapture}
            disabled={countdown !== null}
            title="Step back so your whole body is in frame, then your proportions are captured once and fixed for the 3D mannequin."
          >
            {countdown !== null ? `capturing… ${countdown}` : "capture scale"}
          </button>
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

        {(displayMode === "room" || displayMode === "both") && (
          <section className="pane">
            <RoomViewport
              debugLandmarksRef={mocap.debugLandmarksRef}
              rigConfig={rigConfig}
              mirror={mirror}
              roomM={roomM}
            />
          </section>
        )}

        {displayMode === "tuner" && (
          <section className="pane pane-tuner">
            <div className="tuner-viewport">
              <RoomViewport
                debugLandmarksRef={mocap.debugLandmarksRef}
                rigConfig={rigConfig}
                mirror={mirror}
                roomM={roomM}
              />
            </div>
            <RigTuner rig={rigConfig} onChange={changeRigField} onReset={resetRig} />
          </section>
        )}
      </main>

      <footer>
        <DebugHUD
          state={mocap.state}
          rawFrameRef={mocap.rawFrameRef}
          frameRef={mocap.frameRef}
          calibrationRef={mocap.calibrationRef}
          rigConfig={rigConfig}
          expressionMap={expressionMap}
        />
      </footer>

      {countdown !== null && (
        <div className="capture-countdown" aria-hidden="true">
          <div className="capture-countdown-num">{countdown}</div>
          <div className="capture-countdown-label">Step into frame — capturing scale…</div>
        </div>
      )}
    </div>
  );
}
