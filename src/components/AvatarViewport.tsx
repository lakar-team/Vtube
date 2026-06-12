import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { disposeVRM, loadVRM } from "../vrm/loadVRM";
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
 * Three.js viewport: renders the VRM and applies the latest mocap frame on
 * every render tick.
 */
export function AvatarViewport({ frameRef, viewMode = "bust", onExpressionMap }: AvatarViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const expressionMapRef = useRef<ExpressionMapping | undefined>(undefined);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

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

    loadVRM()
      .then(({ vrm: loaded, sourceUrl, expressionMap }) => {
        if (disposed) {
          disposeVRM(loaded);
          return;
        }
        vrm = loaded;
        expressionMapRef.current = expressionMap;
        onExpressionMap?.(expressionMap);
        if (vrm.lookAt) vrm.lookAt.target = lookAtTarget;
        scene.add(vrm.scene);
        setLoad({ phase: "ready", source: sourceUrl });
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setLoad({
            phase: "error",
            message:
              "Could not load a VRM model. Drop one at public/models/avatar.vrm. " +
              (err instanceof Error ? err.message : String(err)),
          });
        }
      });

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const delta = clock.getDelta();
      if (vrm) {
        const frame = frameRef.current;
        if (frame) applyMocapToVRM(vrm, frame, lookAtTarget, expressionMapRef.current);
        vrm.update(delta); // applies expressions, lookAt, spring bones
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
          sample model — drop your own at public/models/avatar.vrm
        </div>
      )}
    </div>
  );
}
