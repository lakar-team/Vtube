import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { disposeVRM, loadVRM, loadVRMFromFile, type LoadedVRM } from "../vrm/loadVRM";
import { applyMocapToVRM } from "../vrm/applyMocapToVRM";
import type { ExpressionMapping } from "../vrm/expressionMap";
import type { MocapFrame } from "../mocap/types";

export type ViewMode = "bust" | "full";

/** Camera placement per view mode (VRM humanoids stand at the origin). */
const CAMERA_PRESETS: Record<ViewMode, { pos: [number, number, number]; look: [number, number, number] }> = {
  bust: { pos: [0, 1.35, 1.6], look: [0, 1.32, 0] },
  full: { pos: [0, 1.0, 4.2], look: [0, 0.9, 0] },
};

export interface AvatarViewportProps {
  /** Smoothed mocap output from useMocap. */
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Bust-up framing (face/hands detail) or full-body framing (legs). */
  viewMode?: ViewMode;
  /** Called once the VRM loads with its blendshape support summary, for the
   *  debug HUD's "unsupported channels" warning. */
  onExpressionMap?: (mapping: ExpressionMapping) => void;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; source: string }
  | { phase: "error"; message: string };

/**
 * Three.js viewport: renders the VRM and applies the latest face mocap frame
 * on every render tick. Body bones remain in rest pose.
 */
export function AvatarViewport({
  frameRef,
  viewMode = "bust",
  onExpressionMap,
}: AvatarViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  /** Error from a user model upload — shown without discarding the current model. */
  const [uploadError, setUploadError] = useState<string | null>(null);
  const expressionMapRef = useRef<ExpressionMapping | undefined>(undefined);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  /** Set by the scene effect; lets the file picker swap in an uploaded VRM. */
  const loadFileRef = useRef<((file: File) => void) | null>(null);

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

    const camera = new THREE.PerspectiveCamera(
      27,
      container.clientWidth / Math.max(container.clientHeight, 1),
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
                "Could not load a VRM model. Use the load VRM button or drop a .vrm at " +
                "public/models/avatar.vrm. " + message,
            });
          }
        });
    };

    beginLoad(loadVRM());
    loadFileRef.current = (file: File) => beginLoad(loadVRMFromFile(file));

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const delta = clock.getDelta();
      if (vrm) {
        const frame = frameRef.current;
        if (frame) {
          applyMocapToVRM(vrm, frame, lookAtTarget, expressionMapRef.current);
        }
        vrm.update(delta);
      }
      renderer.render(scene, camera);
    });

    const onResize = () => {
      const w = container.clientWidth;
      const h = Math.max(container.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      loadFileRef.current = null;
      cameraRef.current = null;
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      if (vrm) disposeVRM(vrm);
      renderer.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          sample model — use "load VRM…" to use your own
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
        {uploadError && <div className="viewport-upload-error">{uploadError}</div>}
      </div>
    </div>
  );
}
