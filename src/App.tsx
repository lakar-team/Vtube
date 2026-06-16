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

  // Snap eyes into the detected sockets, written as FACE-LOCAL offsets (matching
  // RoomViewport: eyes live in the face frame, not head-local). Builds the same
  // metric face transform + R/U/F basis the viewport uses, projects each eye
  // centre onto that basis. The fulcrum shift is common to anchor and eyes, so it
  // cancels in face-local space — eyeX/Y/Z are pure offsets from the face centre.
  const snapEyesToSockets = () => {
    const lms = mocap.debugLandmarksRef.current;
    const face = lms.face;
    if (!face || face.length < 468) {
      console.warn("[snap eyes] no face landmarks — face the camera and retry");
      return;
    }
    const rig = rigConfigRef.current;
    const mx = mirror ? -1 : 1;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < 468; i++) { const p = face[i]; cx += p.x; cy += p.y; cz += p.z; }
    cx /= 468; cy /= 468; cz /= 468;
    // metric-per-normalized from the pose ears (fallback: face width).
    const headM = rig.headDiameterCm / 100;
    const eA = lms.pose?.[7], eB = lms.pose?.[8];
    let mpn = 0;
    if (eA && eB && (eA.visibility ?? 1) >= 0.5 && (eB.visibility ?? 1) >= 0.5) {
      const ne = Math.hypot(eA.x - eB.x, eA.y - eB.y);
      if (ne > 1e-4) mpn = headM / ne;
    }
    if (mpn <= 0) {
      const fw = Math.hypot(face[234].x - face[454].x, face[234].y - face[454].y);
      mpn = fw > 1e-4 ? headM / fw : 1;
    }
    const fScale = mpn * rig.faceScale;
    type V = { x: number; y: number; z: number };
    const rv = (i: number): V => ({
      x: mx * (face[i].x - cx) * fScale,
      y: -(face[i].y - cy) * fScale,
      z: -(face[i].z - cz) * fScale,
    });
    const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z;
    const norm = (a: V): V => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
    const cross = (a: V, b: V): V => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const up = sub(rv(10), rv(152));
    const side = sub(rv(454), rv(234));
    let F = norm(cross(side, up));
    if (F.z < 0) F = { x: -F.x, y: -F.y, z: -F.z };
    const U = norm(sub(up, { x: F.x * dot(up, F), y: F.y * dot(up, F), z: F.z * dot(up, F) }));
    let R = norm(cross(U, F));
    if (dot(R, side) < 0) R = { x: -R.x, y: -R.y, z: -R.z };
    const eyeLocal = (a: number, b: number) => {
      const ea = rv(a), eb = rv(b);
      const c: V = { x: (ea.x + eb.x) / 2, y: (ea.y + eb.y) / 2, z: (ea.z + eb.z) / 2 };
      return { x: dot(c, R), y: dot(c, U), z: dot(c, F) };
    };
    const L = eyeLocal(362, 263); // left eye inner/outer corners
    const Re = eyeLocal(33, 133); // right eye outer/inner corners
    const eyeXcm = (Math.abs(L.x - Re.x) / 2) * 100;
    const eyeYcm = ((L.y + Re.y) / 2) * 100;
    const eyeZcm = ((L.z + Re.z) / 2) * 100;
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
