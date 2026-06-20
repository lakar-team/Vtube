import { useEffect, useRef, useState } from "react";
import { WebcamView } from "./components/WebcamView";
import { FaceMeshDebugView } from "./components/FaceMeshDebugView";
import { RoomViewport, DEFAULT_RULES, type RuleFlags } from "./components/RoomViewport";
import { RigTuner } from "./components/RigTuner";
import { RulesInspector, type RuleToggleItem, type RuleNumberItem } from "./components/RulesInspector";
import { DebugHUD } from "./components/DebugHUD";
import { useWebcam } from "./hooks/useWebcam";
import { useMocap } from "./mocap/useMocap";
import { DEFAULT_PERF, type PerfOptions } from "./mocap/landmarkers";
import {
  captureRigConfig, loadRigConfig, saveRigConfig,
  DEFAULT_RIG, type RigConfig, type RigNumKey,
} from "./mocap/rig";
import { lmFaceCentered } from "./mocap/worldFrame";

type DisplayMode = "room" | "tuner" | "rules" | "facemesh";
const DISPLAY_MODE_KEY = "vtube.displayMode";

function loadDisplayMode(): DisplayMode {
  try {
    const v = localStorage.getItem(DISPLAY_MODE_KEY) as DisplayMode | null;
    return v === "room" || v === "tuner" || v === "rules" || v === "facemesh" ? v : "room";
  } catch {
    return "room";
  }
}

const RULES_KEY = "vtube.rules";
function loadRules(): RuleFlags {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    return raw ? { ...DEFAULT_RULES, ...(JSON.parse(raw) as Partial<RuleFlags>) } : { ...DEFAULT_RULES };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

const PERF_KEY = "vtube.perf";
function loadPerf(): PerfOptions {
  try {
    const raw = localStorage.getItem(PERF_KEY);
    return raw ? { ...DEFAULT_PERF, ...(JSON.parse(raw) as Partial<PerfOptions>) } : { ...DEFAULT_PERF };
  } catch {
    return { ...DEFAULT_PERF };
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
  const videoRef    = useRef<HTMLVideoElement | null>(null);
  const glbInputRef = useRef<HTMLInputElement | null>(null);

  const [mirror, setMirror] = useState(true);
  const [showOverlay, setShowOverlay] = useState(true);
  const [trackLegs, setTrackLegs] = useState(true);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(loadDisplayMode);
  const [heightCm, setHeightCm] = useState<number>(loadHeightCm);
  const [roomM, setRoomM] = useState<number>(loadRoomM);
  const [persistPose, setPersistPose] = useState(() => loadBool("vtube.persistPose", false));
  const [persistHands, setPersistHands] = useState(() => loadBool("vtube.persistHands", true));
  const [persistFace, setPersistFace] = useState(() => loadBool("vtube.persistFace", true));
  const [smoothing, setSmoothing] = useState(() => loadBool("vtube.smoothing", false));
  const [smoothAmount, setSmoothAmount] = useState(loadSmoothAmount);
  const [rigConfig, setRigConfig] = useState<RigConfig>(loadRigConfig);
  const rigConfigRef = useRef(rigConfig);
  rigConfigRef.current = rigConfig;
  const [rules, setRules] = useState<RuleFlags>(loadRules);
  const setRule = (k: keyof RuleFlags, v: boolean) => {
    setRules((prev) => {
      const next = { ...prev, [k]: v };
      try { localStorage.setItem(RULES_KEY, JSON.stringify(next)); } catch { /* privacy mode */ }
      return next;
    });
  };
  const setRuleNum = (k: keyof RuleFlags, v: number) => {
    setRules((prev) => {
      const next = { ...prev, [k]: v };
      try { localStorage.setItem(RULES_KEY, JSON.stringify(next)); } catch { /* privacy mode */ }
      return next;
    });
  };
  const [perf, setPerf] = useState<PerfOptions>(loadPerf);
  const setPerfFlag = (k: keyof PerfOptions, v: boolean) => {
    setPerf((prev) => {
      const next = { ...prev, [k]: v };
      try { localStorage.setItem(PERF_KEY, JSON.stringify(next)); } catch { /* privacy mode */ }
      return next;
    });
  };
  const [countdown, setCountdown] = useState<number | null>(null);
  const captureTimerRef = useRef<number | null>(null);

  const [modelUrl, setModelUrl] = useState<string | null>(null);
  // Revoke the object URL when it changes or on unmount to avoid memory leaks.
  useEffect(() => {
    return () => { if (modelUrl) URL.revokeObjectURL(modelUrl); };
  }, [modelUrl]);

  const webcam = useWebcam(videoRef);
  const mocap = useMocap(videoRef, {
    mirror,
    trackLegs,
    enabled: webcam.ready,
    heightCm,
    perf,
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

  // Rules Inspector: persistence/smoothing reuse the existing header state; the
  // behavioural rules drive RoomViewport via the `rules` flags.
  const ruleToggles: RuleToggleItem[] = [
    { key: "useCustomModel", label: "use custom 3D model", value: rules.useCustomModel, onToggle: (v) => setRule("useCustomModel", v) },
    { key: "useModelFace", label: "model face (ARKit blendshapes)", value: rules.useModelFace, onToggle: (v) => setRule("useModelFace", v) },
    { key: "showModelBones", label: "show model bones (skeleton overlay)", value: rules.showModelBones, onToggle: (v) => setRule("showModelBones", v) },
    { key: "pauseBoneDriving", label: "DEBUG: pause bone driving (freeze pose)", value: rules.pauseBoneDriving, onToggle: (v) => setRule("pauseBoneDriving", v) },
    { key: "posePersistence", label: "pose persistence", value: persistPose, onToggle: (v) => setBoolPersisted("vtube.persistPose", setPersistPose, v) },
    { key: "handPersistence", label: "hand persistence", value: persistHands, onToggle: (v) => setBoolPersisted("vtube.persistHands", setPersistHands, v) },
    { key: "facePersistence", label: "face persistence", value: persistFace, onToggle: (v) => setBoolPersisted("vtube.persistFace", setPersistFace, v) },
    { key: "smoothing", label: "temporal smoothing", value: smoothing, onToggle: (v) => setBoolPersisted("vtube.smoothing", setSmoothing, v) },
    { key: "legsRestOnLoss", label: "A-pose legs on body loss", value: rules.legsRestOnLoss, onToggle: (v) => setRule("legsRestOnLoss", v) },
    { key: "faceFulcrum", label: "face fulcrum correction", value: rules.faceFulcrum, onToggle: (v) => setRule("faceFulcrum", v) },
    { key: "fingerFK", label: "finger forward kinematics", value: rules.fingerFK, onToggle: (v) => setRule("fingerFK", v) },
    { key: "faceLocalEyes", label: "face-local eye anchoring", value: rules.faceLocalEyes, onToggle: (v) => setRule("faceLocalEyes", v) },
    { key: "cheekHingeNorm", label: "face cheek-hinge normalization", value: rules.cheekHingeNorm, onToggle: (v) => setRule("cheekHingeNorm", v) },
    { key: "showFaceMesh", label: "face surface mesh", value: rules.showFaceMesh, onToggle: (v) => setRule("showFaceMesh", v) },
    { key: "showEyes", label: "eyeballs", value: rules.showEyes, onToggle: (v) => setRule("showEyes", v) },
    // ── performance (reinitialises the trackers on delegate change) ──
    { key: "faceGpu", label: "perf · face landmarker GPU delegate", value: perf.faceGpu, onToggle: (v) => setPerfFlag("faceGpu", v) },
    { key: "faceWasmSimd", label: "perf · face landmarker WASM SIMD (when GPU off)", value: perf.faceWasmSimd, onToggle: (v) => setPerfFlag("faceWasmSimd", v) },
    { key: "poseGpu", label: "perf · pose landmarker GPU delegate", value: perf.poseGpu, onToggle: (v) => setPerfFlag("poseGpu", v) },
    { key: "handsGpu", label: "perf · hands landmarker GPU delegate", value: perf.handsGpu, onToggle: (v) => setPerfFlag("handsGpu", v) },
    { key: "faceCap30", label: "perf · face inference 30fps cap", value: perf.faceCap30, onToggle: (v) => setPerfFlag("faceCap30", v) },
    { key: "poseCap30", label: "perf · pose inference 30fps cap", value: perf.poseCap30, onToggle: (v) => setPerfFlag("poseCap30", v) },
  ];

  const ruleNumbers: RuleNumberItem[] = [
    { key: "driveBonesUpTo", label: "DEBUG: drive bones up to # (0=none)", value: rules.driveBonesUpTo, min: 0, max: 9999, step: 1, onSet: (v) => setRuleNum("driveBonesUpTo", v) },
  ];

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
    const rv = (i: number) => lmFaceCentered(face[i], cx, cy, cz, mx, fScale);
    const up   = rv(10).sub(rv(152));
    const side = rv(454).sub(rv(234));
    let F = side.clone().cross(up).normalize();
    if (F.z < 0) F.negate();
    const U = up.clone().addScaledVector(F, -up.dot(F)).normalize();
    let R = U.clone().cross(F).normalize();
    if (R.dot(side) < 0) R.negate();
    const eyeLocal = (a: number, b: number) => {
      const c = rv(a).add(rv(b)).multiplyScalar(0.5);
      return { x: c.dot(R), y: c.dot(U), z: c.dot(F) };
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
              "Which view to show in the right pane:\n" +
              "• room — metric 3D mannequin in a scaled room (drag to orbit)\n" +
              "• tuner — mannequin + sliders to adjust rig proportions\n" +
              "• rules — mannequin + live processing-rule toggles\n" +
              "• face mesh — the tracked 468-point face landmarks"
            }
          >
            view
            <select
              value={displayMode}
              onChange={(e) => changeDisplayMode(e.target.value as DisplayMode)}
            >
              <option value="room">room (3D)</option>
              <option value="tuner">skeleton &amp; tuner</option>
              <option value="rules">rules inspector</option>
              <option value="facemesh">face mesh</option>
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
          <button
            type="button"
            className="capture-btn"
            onClick={() => glbInputRef.current?.click()}
            title="Load a GLB/GLTF character model with a Mixamo-compatible skeleton. Toggle it on in the Rules Inspector."
          >
            {modelUrl ? "replace model" : "load model"}
          </button>
          <input
            ref={glbInputRef}
            type="file"
            accept=".glb,.gltf"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (modelUrl) URL.revokeObjectURL(modelUrl);
              const url = URL.createObjectURL(f);
              console.log("[App] model picked:", f.name, "size:", f.size, "url:", url);
              setModelUrl(url);
              // Auto-enable the custom model on load so the user sees it immediately.
              setRule("useCustomModel", true);
              e.target.value = "";
            }}
          />
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

      <main className="panes">
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

        {displayMode === "room" && (
          <section className="pane">
            <RoomViewport
              debugLandmarksRef={mocap.debugLandmarksRef}
              frameRef={mocap.frameRef}
              rigConfig={rigConfig}
              mirror={mirror}
              roomM={roomM}
              lmOpts={lmOpts}
              rules={rules}
              modelUrl={modelUrl}
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
                rules={rules}
                modelUrl={modelUrl}
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

        {displayMode === "rules" && (
          <section className="pane pane-tuner">
            <div className="tuner-viewport">
              <RoomViewport
                debugLandmarksRef={mocap.debugLandmarksRef}
                frameRef={mocap.frameRef}
                rigConfig={rigConfig}
                mirror={mirror}
                roomM={roomM}
                lmOpts={lmOpts}
                rules={rules}
                modelUrl={modelUrl}
              />
            </div>
            <RulesInspector toggles={ruleToggles} numbers={ruleNumbers} />
          </section>
        )}

        {displayMode === "facemesh" && (
          <section className="pane">
            <FaceMeshDebugView debugLandmarksRef={mocap.debugLandmarksRef} />
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
