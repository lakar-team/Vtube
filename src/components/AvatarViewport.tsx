import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { disposeVRM, loadVRM, loadVRMFromFile, type LoadedVRM } from "../vrm/loadVRM";
import {
  applySkinFromFile,
  applySkinFromURL,
  generateSkinTemplate,
  resetSkin,
  SAMPLE_SKIN_URL,
} from "../vrm/skin";
import { applyDemoPoseToVRM, applyMocapToVRM } from "../vrm/applyMocapToVRM";
import { createPositionalRetargeter, type PositionalRetargeter } from "../vrm/applyPositionalToVRM";
import type { ExpressionMapping } from "../vrm/expressionMap";
import type { MocapFrame, DebugLandmarks } from "../mocap/types";
import type { CalibrationPoseDef } from "../mocap/calibration";

export type TrackingMode = "stabilized" | "direct" | "positional";

export type ViewMode = "bust" | "full";

/** Narrow DebugLandmarks to just the pose array (avoids importing all of DebugLandmarks). */
type PoseDebugRef = MutableRefObject<DebugLandmarks>;

/** Camera placement per view mode (VRM humanoids stand at the origin). */
const CAMERA_PRESETS: Record<ViewMode, { pos: [number, number, number]; look: [number, number, number] }> = {
  bust: { pos: [0, 1.35, 1.6], look: [0, 1.32, 0] },
  full: { pos: [0, 1.0, 4.2], look: [0, 0.9, 0] },
};

export interface AvatarViewportProps {
  /** Smoothed mocap output from useMocap. */
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Raw MediaPipe landmarks — needed for positional retargeting mode. */
  debugLandmarksRef?: PoseDebugRef;
  /** Bust-up framing (face/hands detail) or full-body framing (legs). */
  viewMode?: ViewMode;
  /**
   * While body calibration runs, the avatar DEMONSTRATES this pose instead
   * of following mocap, so the user can copy it. null = follow mocap.
   */
  demoPose?: CalibrationPoseDef | null;
  /** Called once the VRM loads with its blendshape support summary, for the
   *  debug HUD's "unsupported channels" warning. */
  onExpressionMap?: (mapping: ExpressionMapping) => void;
  /**
   * Tracking mode:
   *  "stabilized" — One Euro filtered + lerped (smooth, slight lag)
   *  "direct"     — raw frame, lerp=1 (responsive, may jitter)
   *  "positional" — bypass Kalidokit IK; orient bones directly from landmark
   *                 positions matching the Skeleton diagnostic mannequin
   */
  trackingMode?: TrackingMode;
  /** Mirror flag — required for correct axis mapping in positional mode. */
  mirror?: boolean;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; source: string }
  | { phase: "error"; message: string };

/**
 * Three.js viewport: renders the VRM and applies the latest mocap frame on
 * every render tick.
 */
export function AvatarViewport({
  frameRef,
  debugLandmarksRef,
  viewMode = "bust",
  demoPose = null,
  onExpressionMap,
  trackingMode = "direct",
  mirror = true,
}: AvatarViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The render loop reads these through refs so prop changes don't re-create the scene.
  const demoPoseRef = useRef<CalibrationPoseDef | null>(demoPose);
  demoPoseRef.current = demoPose;
  const trackingModeRef = useRef(trackingMode);
  trackingModeRef.current = trackingMode;
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const aspectRef = useRef(1);
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  /** Error from a user model upload — shown without discarding the current model. */
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** Custom-skin feature state (separate from VRM loading on purpose). */
  const [skinError, setSkinError] = useState<string | null>(null);
  const [skinActive, setSkinActive] = useState(false);
  const [skinBusy, setSkinBusy] = useState(false);
  const expressionMapRef = useRef<ExpressionMapping | undefined>(undefined);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  /** Set by the scene effect; lets the file picker swap in an uploaded VRM. */
  const loadFileRef = useRef<((file: File) => void) | null>(null);
  /** Skin actions bound to the live VRM instance inside the scene effect. */
  const skinRef = useRef<{
    template: () => Promise<Blob>;
    applyFile: (file: File) => Promise<void>;
    applyUrl: (url: string) => Promise<void>;
    reset: () => void;
  } | null>(null);

  // Reframe the existing camera when the view mode changes.
  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const preset = CAMERA_PRESETS[viewMode];
    camera.position.set(...preset.pos);
    camera.lookAt(...preset.look);
  }, [viewMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    aspectRef.current = container.clientWidth / Math.max(container.clientHeight, 1);
    const camera = new THREE.PerspectiveCamera(
      27,
      aspectRef.current,
      0.1,
      30,
    );
    const preset = CAMERA_PRESETS[viewMode];
    camera.position.set(...preset.pos);
    camera.lookAt(...preset.look);
    scene.add(camera);
    cameraRef.current = camera;

    // Gaze target for the VRM lookAt applier, parented to the camera so
    // "looking at the viewer" is the neutral state.
    const lookAtTarget = new THREE.Object3D();
    camera.add(lookAtTarget);

    const keyLight = new THREE.DirectionalLight(0xffffff, Math.PI * 0.45);
    keyLight.position.set(1, 2, 2).normalize();
    scene.add(keyLight);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    const grid = new THREE.GridHelper(4, 8, 0x444466, 0x2a2a3a);
    scene.add(grid);

    const positional: PositionalRetargeter = createPositionalRetargeter();

    let vrm: VRM | null = null;
    // Guards against a slow earlier load resolving after a newer one (e.g.
    // the user picks a file while the default model is still downloading).
    let loadGeneration = 0;

    const adopt = (loaded: LoadedVRM) => {
      if (vrm) {
        scene.remove(vrm.scene);
        disposeVRM(vrm);
      }
      vrm = loaded.vrm;
      expressionMapRef.current = loaded.expressionMap;
      onExpressionMap?.(loaded.expressionMap);
      if (vrm.lookAt) vrm.lookAt.target = lookAtTarget;
      scene.add(vrm.scene);
      setLoad({ phase: "ready", source: loaded.sourceUrl });
      // A new model starts with its own factory textures.
      setSkinActive(false);
      setSkinError(null);
    };

    const beginLoad = (promise: Promise<LoadedVRM>) => {
      const generation = ++loadGeneration;
      setUploadError(null);
      if (!vrm) setLoad({ phase: "loading" });
      promise
        .then((loaded) => {
          if (disposed || generation !== loadGeneration) {
            disposeVRM(loaded.vrm);
            return;
          }
          adopt(loaded);
        })
        .catch((err: unknown) => {
          if (disposed || generation !== loadGeneration) return;
          const message = err instanceof Error ? err.message : String(err);
          if (vrm) {
            // A failed upload keeps the model that's already on stage.
            setUploadError(`Could not load that VRM: ${message}`);
          } else {
            setLoad({
              phase: "error",
              message:
                "Could not load a VRM model. Use “load VRM…” or drop one at " +
                "public/models/avatar.vrm. " + message,
            });
          }
        });
    };

    beginLoad(loadVRM());
    loadFileRef.current = (file: File) => beginLoad(loadVRMFromFile(file));

    // Skin actions close over the mutable `vrm` local so they always target
    // whichever model is currently on stage.
    const requireVRM = (): VRM => {
      if (!vrm) throw new Error("The model is still loading.");
      return vrm;
    };
    skinRef.current = {
      template: () => generateSkinTemplate(requireVRM()),
      applyFile: (file: File) => applySkinFromFile(requireVRM(), file),
      applyUrl: (url: string) => applySkinFromURL(requireVRM(), url),
      reset: () => {
        if (vrm) resetSkin(vrm);
      },
    };

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const delta = clock.getDelta();
      if (vrm) {
        const demo = demoPoseRef.current;
        if (demo) {
          applyDemoPoseToVRM(vrm, demo);
        } else {
          const frame = frameRef.current;
          const mode  = trackingModeRef.current;
          if (frame) {
            // Always run applyMocapToVRM: handles expressions, lookAt, spring bones,
            // and spine/head/wrist/finger bones. In positional mode its arm/leg
            // rotations are immediately overridden below.
            applyMocapToVRM(
              vrm,
              frame,
              lookAtTarget,
              expressionMapRef.current,
              mode !== "stabilized", // direct=true for both "direct" and "positional"
            );

            if (mode === "positional") {
              const pose = debugLandmarksRef?.current?.pose ?? null;
              const mx   = mirrorRef.current ? -1 : 1;
              positional.apply(vrm, pose, mx, aspectRef.current);
            }
          }
        }
        vrm.update(delta);
      }
      renderer.render(scene, camera);
    });

    const onResize = () => {
      const w = container.clientWidth;
      const h = Math.max(container.clientHeight, 1);
      aspectRef.current = w / h;
      camera.aspect = aspectRef.current;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      loadFileRef.current = null;
      skinRef.current = null;
      cameraRef.current = null;
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      if (vrm) disposeVRM(vrm);
      renderer.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Run a skin action with shared busy/error handling. */
  const runSkinAction = async (action: () => Promise<void>) => {
    setSkinBusy(true);
    setSkinError(null);
    try {
      await action();
    } catch (err: unknown) {
      setSkinError(err instanceof Error ? err.message : String(err));
    } finally {
      setSkinBusy(false);
    }
  };

  const onSkinTemplate = () =>
    runSkinAction(async () => {
      const blob = await skinRef.current!.template();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "skin-template.png";
      a.click();
      // Give the browser time to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });

  const onSkinFile = (file: File) =>
    runSkinAction(async () => {
      await skinRef.current!.applyFile(file);
      setSkinActive(true);
    });

  const onSkinSample = () =>
    runSkinAction(async () => {
      await skinRef.current!.applyUrl(SAMPLE_SKIN_URL);
      setSkinActive(true);
    });

  const onSkinReset = () => {
    skinRef.current?.reset();
    setSkinActive(false);
    setSkinError(null);
  };

  const skinDisabled = skinBusy || load.phase !== "ready";

  return (
    <div ref={containerRef} className="avatar-viewport">
      {load.phase === "loading" && (
        <div className="viewport-status">Loading VRM…</div>
      )}
      {load.phase === "error" && (
        <div className="viewport-status error">{load.message}</div>
      )}
      {load.phase === "ready" && load.source.startsWith("http") && (
        <div className="viewport-badge">
          sample model — use “load VRM…” to use your own
        </div>
      )}
      <div className="viewport-tools">
        <label className="btn viewport-upload">
          load VRM…
          <input
            type="file"
            accept=".vrm"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) loadFileRef.current?.(file);
              // Reset so picking the same file again re-triggers onChange.
              e.target.value = "";
            }}
          />
        </label>
        <div className="skin-tools">
          <span className="skin-tools-label">skin</span>
          <button
            className="btn"
            disabled={skinDisabled}
            onClick={onSkinTemplate}
            title="Download this model's UV layout as a labeled PNG template. Paint it in any image editor, then apply it with “upload…”."
          >
            template ⤓
          </button>
          <label
            className="btn"
            title="Apply an edited skin template image to the current model."
            aria-disabled={skinDisabled}
          >
            upload…
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: "none" }}
              disabled={skinDisabled}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onSkinFile(file);
                e.target.value = "";
              }}
            />
          </label>
          <button
            className="btn"
            disabled={skinDisabled}
            onClick={onSkinSample}
            title="Apply the bundled demo skin (made for the default avatar; on other models it will be misaligned)."
          >
            sample
          </button>
          {skinActive && (
            <button
              className="btn"
              disabled={skinBusy}
              onClick={onSkinReset}
              title="Restore the model's original textures."
            >
              reset
            </button>
          )}
        </div>
        {uploadError && <div className="viewport-upload-error">{uploadError}</div>}
        {skinError && <div className="viewport-upload-error">skin: {skinError}</div>}
      </div>
    </div>
  );
}
