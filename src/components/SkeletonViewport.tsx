import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { DebugLandmarks } from "../mocap/types";

/**
 * Mannequin diagnostic viewport — raw MediaPipe pose + hand landmark positions
 * rendered as a wooden-artist-mannequin stick figure with volume.
 *
 * COORDINATE SYSTEM (key to positional accuracy):
 *   We use an OrthographicCamera whose frustum exactly covers the normalized
 *   image space [0,1]×[0,1] used by MediaPipe landmarks. The mapping is:
 *
 *     world_x = (mirror ? -1 : 1) * (lm.x - 0.5) * aspect
 *     world_y = -(lm.y - 0.5)
 *     world_z = -(lm.z ?? 0) * Z_SCALE  (cosmetic depth only)
 *
 *   This makes every landmark project to the exact same screen pixel as the
 *   corresponding dot drawn on the 2D webcam overlay canvas, since both use
 *   `lm.x * containerWidth` / `lm.y * containerHeight`.
 *
 *   The earlier PerspectiveCamera + SCALE=4.0 approach was wrong: with a
 *   perspective camera at z=5.5, FOV=60°, the visible half-width ≈ 3.18 units,
 *   so a landmark at lm.x=0.8 projected to ~69% from the left, not 80%.
 */

const Z_SCALE   = 0.5;
const MIN_VIS   = 0.45;

const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// ─── Three.js temporary objects (shared, never mutated in parallel) ──────────
const _v  = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q  = new THREE.Quaternion();
const _Y  = new THREE.Vector3(0, 1, 0);

// ─── coordinate mapping ──────────────────────────────────────────────────────

function lmW(
  lm: NormalizedLandmark,
  mx: number,
  aspect: number,
): THREE.Vector3 {
  return new THREE.Vector3(
    mx * (lm.x - 0.5) * aspect,
    -(lm.y - 0.5),
    -(lm.z ?? 0) * Z_SCALE,
  );
}

function midW(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  mx: number,
  aspect: number,
): THREE.Vector3 {
  return new THREE.Vector3(
    mx * ((a.x + b.x) * 0.5 - 0.5) * aspect,
    -((a.y + b.y) * 0.5 - 0.5),
    -((a.z ?? 0) + (b.z ?? 0)) * 0.5 * Z_SCALE,
  );
}

// ─── mesh helpers ────────────────────────────────────────────────────────────

function makeCylMesh(
  r: number,
  mat: THREE.Material,
): THREE.Mesh {
  // CylinderGeometry along Y-axis, height=1 → scale.y = actual length per frame
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10, 1), mat);
}

function makeSphereMesh(
  r: number,
  mat: THREE.Material,
): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), mat);
}

// Place a cylinder between two world points; hides mesh if either is null.
function placeCyl(
  mesh: THREE.Mesh,
  a: THREE.Vector3 | null,
  b: THREE.Vector3 | null,
): void {
  if (!a || !b) { mesh.visible = false; return; }
  const len = a.distanceTo(b);
  if (len < 1e-4) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  _v2.subVectors(b, a).normalize();
  _q.setFromUnitVectors(_Y, _v2);
  mesh.quaternion.copy(_q);
  mesh.scale.y = len;
}

// Place a sphere at a world point; hides mesh if null.
function placeSph(
  mesh: THREE.Mesh,
  p: THREE.Vector3 | null,
): void {
  if (!p) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.copy(p);
}

// Update a LineSegments buffer from a landmark array + connection list.
function writeHandLines(
  seg: THREE.LineSegments,
  lms: NormalizedLandmark[] | null,
  pairs: ReadonlyArray<readonly [number, number]>,
  mx: number,
  aspect: number,
): void {
  if (!lms) { seg.visible = false; return; }
  seg.visible = true;
  const attr = seg.geometry.attributes.position as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  let i = 0;
  for (const [a, b] of pairs) {
    const la = lms[a], lb = lms[b];
    if (la && lb) {
      arr[i++] = mx * (la.x - 0.5) * aspect;
      arr[i++] = -(la.y - 0.5);
      arr[i++] = -(la.z ?? 0) * Z_SCALE;
      arr[i++] = mx * (lb.x - 0.5) * aspect;
      arr[i++] = -(lb.y - 0.5);
      arr[i++] = -(lb.z ?? 0) * Z_SCALE;
    } else {
      arr[i] = arr[i+1] = arr[i+2] = arr[i+3] = arr[i+4] = arr[i+5] = 0;
      i += 6;
    }
  }
  attr.needsUpdate = true;
}

function makeHandLines(color: number): THREE.LineSegments {
  const buf = new Float32Array(HAND_CONNECTIONS.length * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(buf, 3).setUsage(THREE.DynamicDrawUsage),
  );
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
}

// ─── component ───────────────────────────────────────────────────────────────

export interface SkeletonViewportProps {
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  mirror: boolean;
}

export function SkeletonViewport({
  debugLandmarksRef,
  mirror,
}: SkeletonViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef    = useRef(mirror);
  mirrorRef.current  = mirror;
  const aspectRef    = useRef(1);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = false;
    container.appendChild(renderer.domElement);

    // ── scene
    const scene = new THREE.Scene();

    // ── orthographic camera: frustum covers lm.x=[0,1], lm.y=[0,1]
    // This makes the projected position of any landmark exactly match
    // where the same landmark is drawn on the 2D canvas overlay.
    const HALF_H = 0.5;
    aspectRef.current = container.clientWidth / Math.max(container.clientHeight, 1);
    const camera = new THREE.OrthographicCamera(
      -HALF_H * aspectRef.current,
       HALF_H * aspectRef.current,
       HALF_H,
      -HALF_H,
      0.1, 20,
    );
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);

    // ── lighting (required for MeshLambertMaterial shading)
    const keyLight = new THREE.DirectionalLight(0xffffff, Math.PI * 0.8);
    keyLight.position.set(0.5, 1, 2);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xaabbff, Math.PI * 0.3);
    fillLight.position.set(-1, 0.5, 0.5);
    scene.add(fillLight);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    // ── grid floor — in orthographic coords, lm.y=1.0 → world y = -0.5
    const grid = new THREE.GridHelper(
      aspectRef.current * 2, 20, 0x333355, 0x1a1a2e,
    );
    grid.position.y = -0.53;
    scene.add(grid);

    // ── materials (one per side + center)
    // Muted blue/red keep the L/R diagnostic signal; warm tan for torso/head.
    const matL = new THREE.MeshLambertMaterial({ color: 0x4477cc });
    const matR = new THREE.MeshLambertMaterial({ color: 0xcc3344 });
    const matC = new THREE.MeshLambertMaterial({ color: 0xd4b080 }); // warm wood

    // Radii in world units.  With ortho HALF_H=0.5, full screen height = 1.0.
    // A typical standing body spans ~0.8 world units (lm.y 0.05→0.85 → ±0.4 from center).
    // Radius sizing matches a wooden artist's mannequin: limbs ≈ 8-12% of limb length.
    const R_HEAD  = 0.045;
    const R_NECK  = 0.016;
    const R_TORSO = 0.055;
    const R_UARM  = 0.020;
    const R_LARM  = 0.016;
    const R_HAND  = 0.019;
    const R_ULEG  = 0.026;
    const R_LLEG  = 0.021;
    const R_FOOT  = 0.014;
    const R_JNT   = 0.022;  // ball joints (slightly larger than limbs)

    // ── mannequin meshes (each created once, repositioned each frame)
    const mkC = (r: number, m: THREE.Material) => makeCylMesh(r, m);
    const mkS = (r: number, m: THREE.Material) => makeSphereMesh(r, m);

    // body segments
    const mHead    = mkS(R_HEAD,  matC);
    const mNeck    = mkC(R_NECK,  matC);
    const mTorso   = mkC(R_TORSO, matC);

    const mUArmL   = mkC(R_UARM, matL);
    const mLArmL   = mkC(R_LARM, matL);
    const mHandL   = mkS(R_HAND, matL);
    const mULegL   = mkC(R_ULEG, matL);
    const mLLegL   = mkC(R_LLEG, matL);
    const mFootL   = mkC(R_FOOT, matL);

    const mUArmR   = mkC(R_UARM, matR);
    const mLArmR   = mkC(R_LARM, matR);
    const mHandR   = mkS(R_HAND, matR);
    const mULegR   = mkC(R_ULEG, matR);
    const mLLegR   = mkC(R_LLEG, matR);
    const mFootR   = mkC(R_FOOT, matR);

    // ball joints
    const mJShL    = mkS(R_JNT, matL);
    const mJElL    = mkS(R_JNT, matL);
    const mJWrL    = mkS(R_JNT, matL);
    const mJHpL    = mkS(R_JNT, matL);
    const mJKnL    = mkS(R_JNT, matL);
    const mJAnL    = mkS(R_JNT, matL);

    const mJShR    = mkS(R_JNT, matR);
    const mJElR    = mkS(R_JNT, matR);
    const mJWrR    = mkS(R_JNT, matR);
    const mJHpR    = mkS(R_JNT, matR);
    const mJKnR    = mkS(R_JNT, matR);
    const mJAnR    = mkS(R_JNT, matR);

    const allMeshes = [
      mHead, mNeck, mTorso,
      mUArmL, mLArmL, mHandL, mULegL, mLLegL, mFootL,
      mUArmR, mLArmR, mHandR, mULegR, mLLegR, mFootR,
      mJShL, mJElL, mJWrL, mJHpL, mJKnL, mJAnL,
      mJShR, mJElR, mJWrR, mJHpR, mJKnR, mJAnR,
    ];
    for (const m of allMeshes) { m.visible = false; scene.add(m); }

    // ── hand finger line segments (too fine for cylinders)
    const hLLines = makeHandLines(0x6699ee);
    const hRLines = makeHandLines(0xee6677);
    scene.add(hLLines, hRLines);

    let disposed = false;

    renderer.setAnimationLoop(() => {
      if (disposed) return;

      const pose  = debugLandmarksRef.current.pose;
      const mx    = mirrorRef.current ? -1 : 1;
      const asp   = aspectRef.current;

      // Return world pos for pose landmark `i` if visible, else null.
      const W = (i: number): THREE.Vector3 | null => {
        const lm = pose?.[i];
        return lm && (lm.visibility ?? 1) >= MIN_VIS ? lmW(lm, mx, asp) : null;
      };

      // Midpoint of two visible landmarks, else null.
      const M = (i: number, j: number): THREE.Vector3 | null => {
        const a = pose?.[i], b = pose?.[j];
        if (!a || !b) return null;
        if ((a.visibility ?? 1) < MIN_VIS || (b.visibility ?? 1) < MIN_VIS) return null;
        return midW(a, b, mx, asp);
      };

      // Named positions
      const nose   = W(0);
      const shlL   = W(11),  shlR   = W(12);
      const elbL   = W(13),  elbR   = W(14);
      const wristL = W(15),  wristR = W(16);
      const hipL   = W(23),  hipR   = W(24);
      const kneeL  = W(25),  kneeR  = W(26);
      const ankleL = W(27),  ankleR = W(28);
      const toeL   = W(31),  toeR   = W(32);
      const midShl = M(11, 12);
      const midHip = M(23, 24);

      // ── body segments
      placeSph(mHead,   nose);
      placeCyl(mNeck,   nose,   midShl);
      placeCyl(mTorso,  midShl, midHip);

      placeCyl(mUArmL,  shlL,   elbL);
      placeCyl(mLArmL,  elbL,   wristL);
      placeSph(mHandL,  wristL);
      placeCyl(mULegL,  hipL,   kneeL);
      placeCyl(mLLegL,  kneeL,  ankleL);
      placeCyl(mFootL,  ankleL, toeL);

      placeCyl(mUArmR,  shlR,   elbR);
      placeCyl(mLArmR,  elbR,   wristR);
      placeSph(mHandR,  wristR);
      placeCyl(mULegR,  hipR,   kneeR);
      placeCyl(mLLegR,  kneeR,  ankleR);
      placeCyl(mFootR,  ankleR, toeR);

      // ── ball joints
      placeSph(mJShL,  shlL);    placeSph(mJShR,  shlR);
      placeSph(mJElL,  elbL);    placeSph(mJElR,  elbR);
      placeSph(mJWrL,  wristL);  placeSph(mJWrR,  wristR);
      placeSph(mJHpL,  hipL);    placeSph(mJHpR,  hipR);
      placeSph(mJKnL,  kneeL);   placeSph(mJKnR,  kneeR);
      placeSph(mJAnL,  ankleL);  placeSph(mJAnR,  ankleR);

      // ── hands (finger lines, image-space landmarks)
      writeHandLines(hLLines, debugLandmarksRef.current.leftHand,  HAND_CONNECTIONS, mx, asp);
      writeHandLines(hRLines, debugLandmarksRef.current.rightHand, HAND_CONNECTIONS, mx, asp);

      renderer.render(scene, camera);
    });

    // ── resize: update orthographic frustum to match new container aspect
    const onResize = () => {
      const w = container.clientWidth;
      const h = Math.max(container.clientHeight, 1);
      aspectRef.current = w / h;
      camera.left   = -HALF_H * aspectRef.current;
      camera.right  =  HALF_H * aspectRef.current;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      grid.scale.x = aspectRef.current * 2;
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.domElement.remove();
      matL.dispose(); matR.dispose(); matC.dispose();
      for (const m of allMeshes) m.geometry.dispose();
      hLLines.geometry.dispose();
      hRLines.geometry.dispose();
      (hLLines.material as THREE.Material).dispose();
      (hRLines.material as THREE.Material).dispose();
    };
  }, [debugLandmarksRef]);

  return (
    <div ref={containerRef} className="avatar-viewport">
      <div className="viewport-badge">
        skeleton diagnostic · raw MediaPipe landmarks ·{" "}
        <span style={{ color: "#4477cc" }}>blue=left</span> ·{" "}
        <span style={{ color: "#cc3344" }}>red=right</span>
      </div>
    </div>
  );
}
