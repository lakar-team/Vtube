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

function loadBool(key: string, d: boolean): boolean {
  try { const v = localStorage.getItem(key); return v === null ? d : v === "true"; } catch { return d; }
}
function loadSmoothAmount(): number {
  try { const v = Number(localStorage.getItem("vtube.smoothAmount")); return Number.isFinite(v) && v >= 0 && v <= 0.95 ? v : 0.5; } catch { return 0.5; }
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
  const [persistPose, setPersistPose] = useState(() => loadBool("vtube.persistPose", true));
  const [persistHands, setPersistHands] = useState(() => loadBool("vtube.persistHands", true));
  const [persistFace, setPersistFace] = useState(() => loadBool("vtube.persistFace", true));
  const [smoothing, setSmoothing] = useState(() => loadBool("vtube.smoothing", false));
  const [smoothAmount, setSmoothAmount] = useState(loadSmoothAmount);
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

  const setBoolPersisted = (key: string, setter: (v: boolean) => void, v: boolean) => {
    setter(v);
    try { localStorage.setItem(key, String(v)); } catch { /* privacy mode */ }
  };
  const changeSmoothAmount = (v: number) => {
    setSmoothAmount(v);
    try { localStorage.setItem("vtube.smoothAmount", String(v)); } catch { /* privacy mode */ }
  };
  const lmOpts = { persistPose, persistHands, persistFace, smoothing, smoothAmount };

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

  const changeSkin = (hex: string) => {
    setRigConfig((prev) => {
      const next = { ...prev, skinHex: hex };
      saveRigConfig(next);
      return next;
    });
  };

  // Snap eye position into the detected face sockets. Mirrors the RoomViewport
  // face transform (centroid-relative → metric, faceScale, face offset, +N·headR
  // fulcrum shift) so the eyeballs land where the rendered face sockets are.
  const snapEyesToSockets = () => {
    const face = mocap.debugLandmarksRef.current.face;
    if (!face || face.length < 468) {
      console.warn("[snap eyes] no face landmarks — face the camera and retry");
      return;
    }
    const rig = rigConfigRef.current;
    const mx = mirror ? -1 : 1;
    let cx = 0, cy = 0, cz = 0, minY = 1, maxY = 0;
    for (let i = 0; i < 468; i++) {
      const p = face[i];
      cx += p.x; cy += p.y; cz += p.z;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    cx /= 468; cy /= 468; cz /= 468;
    const headR = Math.max((rig.headDiameterCm / 100) * 0.65, 0.04);
    const FACE_FIT = 0.85;
    const fScale = (headR * 2 * FACE_FIT * rig.faceScale) / Math.max(maxY - minY, 1e-3);
    // Face-forward normal (room space) from forehead(10)/chin(152) + sides(234/454).
    const rvx = (i: number) => mx * (face[i].x - cx);
    const rvy = (i: number) => -(face[i].y - cy);
    const rvz = (i: number) => -(face[i].z - cz);
    const ux = rvx(10) - rvx(152), uy = rvy(10) - rvy(152), uz = rvz(10) - rvz(152);
    const sx = rvx(454) - rvx(234), sy = rvy(454) - rvy(234), sz = rvz(454) - rvz(234);
    let nx = sy * uz - sz * uy, ny = sz * ux - sx * uz, nz = sx * uy - sy * ux;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    // Offset of a landmark from the head centre (m).
    const off = (i: number) => ({
      x: rig.faceOffXcm / 100 + mx * (face[i].x - cx) * fScale + nx * headR,
      y: rig.faceOffYcm / 100 + -(face[i].y - cy) * fScale + ny * headR,
      z: rig.faceOffZcm / 100 + -(face[i].z - cz) * fScale + nz * headR,
    });
    const eye = (a: number, b: number) => {
      const A = off(a), B = off(b);
      return { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 };
    };
    const L = eye(362, 263); // left eye inner/outer corners
    const R = eye(33, 133);  // right eye outer/inner corners
    const eyeXcm = (Math.abs(L.x - R.x) / 2) * 100;
    const eyeYcm = ((L.y + R.y) / 2) * 100;
    const eyeZcm = ((L.z + R.z) / 2) * 100;
    setRigConfig((prev) => {
      const next = { ...prev, eyeXcm, eyeYcm, eyeZcm };
      saveRigConfig(next);
      return next;
    });
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
          <span className="toggle persist-group" title="Hold the last-known landmarks briefly when tracking drops, instead of snapping to default.">
            persist:
            <label className="mini"><input type="checkbox" checked={persistPose} onChange={(e) => setBoolPersisted("vtube.persistPose", setPersistPose, e.target.checked)} /> pose</label>
            <label className="mini"><input type="checkbox" checked={persistHands} onChange={(e) => setBoolPersisted("vtube.persistHands", setPersistHands, e.target.checked)} /> hands</label>
            <label className="mini"><input type="checkbox" checked={persistFace} onChange={(e) => setBoolPersisted("vtube.persistFace", setPersistFace, e.target.checked)} /> face</label>
          </span>
          <label className="toggle" title="Temporal smoothing (EMA) of landmark positions to reduce jitter.">
            <input type="checkbox" checked={smoothing} onChange={(e) => setBoolPersisted("vtube.smoothing", setSmoothing, e.target.checked)} />
            smooth
            <input type="range" min={0} max={0.9} step={0.05} value={smoothAmount} disabled={!smoothing} onChange={(e) => changeSmoothAmount(Number(e.target.value))} style={{ width: "4em" }} />
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

        {(displayMode === "room" || displayMode === "both") && (
          <section className="pane">
            <RoomViewport
              debugLandmarksRef={mocap.debugLandmarksRef}
              frameRef={mocap.frameRef}
              rigConfig={rigConfig}
              mirror={mirror}
              roomM={roomM}
              lmOpts={lmOpts}
            />
          </section>
        )}

        {displayMode === "tuner" && (
          <section className="pane pane-tuner">
            <div className="tuner-viewport">
              <RoomViewport
                debugLandmarksRef={mocap.debugLandmarksRef}
                frameRef={mocap.frameRef}
                rigConfig={rigConfig}
                mirror={mirror}
                roomM={roomM}
                lmOpts={lmOpts}
              />
            </div>
            <RigTuner
              rig={rigConfig}
              onChange={changeRigField}
              onReset={resetRig}
              onSnapEyes={snapEyesToSockets}
              onSkinChange={changeSkin}
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
