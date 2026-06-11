import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { disposeVRM, loadVRM } from "../vrm/loadVRM";
import { applyMocapToVRM } from "../vrm/applyMocapToVRM";
import type { ExpressionMapping } from "../vrm/expressionMap";
import type { MocapFrame } from "../mocap/types";

export interface AvatarViewportProps {
  /** Smoothed mocap output from useMocap. */
  frameRef: MutableRefObject<MocapFrame | null>;
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
export function AvatarViewport({ frameRef, onExpressionMap }: AvatarViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const expressionMapRef = useRef<ExpressionMapping | undefined>(undefined);

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
    // Bust-up framing: VRM humanoids stand at the origin, head ~1.3-1.5 m.
    camera.position.set(0, 1.35, 1.6);
    camera.lookAt(0, 1.32, 0);
    scene.add(camera);

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
