import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { VRM } from "@pixiv/three-vrm";
import { disposeVRM, loadVRM, loadVRMFromFile, type LoadedVRM } from "../vrm/loadVRM";
import { applyMocapToVRM, applyBodyMocapToVRM } from "../vrm/applyMocapToVRM";
import type { ExpressionMapping } from "../vrm/expressionMap";
import type { MocapFrame } from "../mocap/types";

const ROOM_DEFAULT = 2.5;

/**
 * VIEWPORT: VRM-in-Room — the VRM avatar standing in the same metric room as the
 * 3D-room mannequin, driven full-body by the solved mocap frame (the same
 * poseWorld-derived FK solve). Body bones (spine/arms/legs/hands) follow the
 * skeleton; head/face/eyes/expressions come from the face solve.
 */
export interface VrmRoomViewportProps {
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Room cube side length (meters). */
  roomM: number;
  /** User's real standing height (cm) — the VRM is scaled to it. */
  heightCm: number;
  onExpressionMap?: (mapping: ExpressionMapping) => void;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; source: string }
  | { phase: "error"; message: string };

export function VrmRoomViewport({ frameRef, roomM, heightCm, onExpressionMap }: VrmRoomViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const loadFileRef = useRef<((file: File) => void) | null>(null);
  const roomMRef = useRef(roomM);
  roomMRef.current = roomM;
  const heightCmRef = useRef(heightCm);
  heightCmRef.current = heightCm;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w0 = container.clientWidth;
    const h0 = Math.max(container.clientHeight, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w0, h0);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    let disposed = false;

    const camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.05, 500);
    const r0 = roomMRef.current || ROOM_DEFAULT;
    camera.position.set(r0 * 0.85, 1.55, r0 * 1.45);
    camera.lookAt(0, 1.0, 0);
    scene.add(camera);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.enableDamping = true;
    controls.update();

    // Gaze target parented to the camera (neutral = looking at the viewer).
    const lookAtTarget = new THREE.Object3D();
    camera.add(lookAtTarget);

    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
    key.position.set(1.5, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xaaccff, Math.PI * 0.3);
    fill.position.set(-2, 1, -1);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    const grid = new THREE.GridHelper(1, 10, 0x556699, 0x2a2a40);
    scene.add(grid);
    const cube = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x445577 }),
    );
    scene.add(cube);

    let vrm: VRM | null = null;
    let loadGeneration = 0;
    let expressionMap: ExpressionMapping | undefined;

    // Scale the VRM to the entered height and stand its feet on the floor.
    const placeVRM = (v: VRM) => {
      v.scene.scale.setScalar(1);
      v.scene.position.set(0, 0, 0);
      v.scene.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(v.scene);
      const modelH = box.max.y - box.min.y;
      const s = modelH > 1e-3 ? (heightCmRef.current / 100) / modelH : 1;
      v.scene.scale.setScalar(s);
      v.scene.updateWorldMatrix(true, true);
      const box2 = new THREE.Box3().setFromObject(v.scene);
      v.scene.position.y = -box2.min.y; // feet on the floor (y = 0)
    };

    const adopt = (loaded: LoadedVRM) => {
      if (vrm) { scene.remove(vrm.scene); disposeVRM(vrm); }
      vrm = loaded.vrm;
      expressionMap = loaded.expressionMap;
      onExpressionMap?.(loaded.expressionMap);
      if (vrm.lookAt) vrm.lookAt.target = lookAtTarget;
      scene.add(vrm.scene);
      placeVRM(vrm);
      setLoad({ phase: "ready", source: loaded.sourceUrl });
    };

    const beginLoad = (promise: Promise<LoadedVRM>) => {
      const generation = ++loadGeneration;
      setUploadError(null);
      if (!vrm) setLoad({ phase: "loading" });
      promise
        .then((loaded) => {
          if (disposed || generation !== loadGeneration) { disposeVRM(loaded.vrm); return; }
          adopt(loaded);
        })
        .catch((err: unknown) => {
          if (disposed || generation !== loadGeneration) return;
          const message = err instanceof Error ? err.message : String(err);
          if (vrm) setUploadError(`Could not load that VRM: ${message}`);
          else setLoad({ phase: "error", message: "Could not load a VRM model. " + message });
        });
    };

    beginLoad(loadVRM());
    loadFileRef.current = (file: File) => beginLoad(loadVRMFromFile(file));

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      if (disposed) return;

      const roomMv = roomMRef.current || ROOM_DEFAULT;
      grid.scale.set(roomMv, 1, roomMv);
      cube.scale.setScalar(roomMv);
      cube.position.y = roomMv / 2;
      controls.update();

      const delta = clock.getDelta();
      if (vrm) {
        const frame = frameRef.current;
        if (frame) {
          applyMocapToVRM(vrm, frame, lookAtTarget, expressionMap);
          applyBodyMocapToVRM(vrm, frame);
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
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      disposed = true;
      loadFileRef.current = null;
      controls.dispose();
      ro.disconnect();
      renderer.setAnimationLoop(null);
      if (vrm) disposeVRM(vrm);
      renderer.dispose();
      renderer.domElement.remove();
      grid.dispose();
      (cube.geometry as THREE.BufferGeometry).dispose();
      (cube.material as THREE.Material).dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className="avatar-viewport">
      <div className="viewport-badge">
        VRM in 3D room · full-body mocap ({roomM}m room · drag to orbit)
      </div>
      {load.phase === "loading" && <div className="viewport-status">Loading VRM…</div>}
      {load.phase === "error" && <div className="viewport-status error">{load.message}</div>}
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
              e.target.value = "";
            }}
          />
        </label>
        {uploadError && <div className="viewport-upload-error">{uploadError}</div>}
      </div>
    </div>
  );
}
