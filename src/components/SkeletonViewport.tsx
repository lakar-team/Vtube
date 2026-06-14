import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { DebugLandmarks, MocapFrame } from "../mocap/types";
import { FACE_TESSELATION } from "./WebcamView";

// Triangle indices extracted from the edge-pair tessellation.
// FACE_TESSELATION stores each triangle as 6 values: [v0,v1, v1,v2, v2,v0].
// Taking positions 0,2,4 within each 6-element group gives the 3 vertex indices.
const _triCount = FACE_TESSELATION.length / 6; // 852 triangles
const FACE_TRIS  = new Uint16Array(_triCount * 3);
for (let _i = 0; _i < _triCount; _i++) {
  FACE_TRIS[_i * 3    ] = FACE_TESSELATION[_i * 6    ];
  FACE_TRIS[_i * 3 + 1] = FACE_TESSELATION[_i * 6 + 2];
  FACE_TRIS[_i * 3 + 2] = FACE_TESSELATION[_i * 6 + 4];
}

/**
 * Mannequin diagnostic viewport — raw MediaPipe pose + hand + face landmark
 * positions rendered as a wooden-artist-mannequin figure with volume.
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
 *   corresponding dot drawn on the 2D webcam overlay canvas.
 */

const Z_SCALE = 0.5;
const MIN_VIS = 0.45;
const HALF_H  = 0.5;

// Hand segment definitions: [fromLandmark, toLandmark, radius]
const HAND_SEGS: ReadonlyArray<readonly [number, number, number]> = [
  // palm / metacarpals
  [0,  1, 0.010], [0,  5, 0.010], [0,  9, 0.010], [0, 13, 0.010], [0, 17, 0.010],
  [5,  9, 0.010], [9, 13, 0.010], [13, 17, 0.010],
  // proximal phalanges
  [1,  2, 0.008], [5,  6, 0.008], [9, 10, 0.008], [13, 14, 0.008], [17, 18, 0.008],
  // mid + distal phalanges
  [2,  3, 0.006], [3,  4, 0.006],
  [6,  7, 0.006], [7,  8, 0.006],
  [10, 11, 0.006], [11, 12, 0.006],
  [14, 15, 0.006], [15, 16, 0.006],
  [18, 19, 0.006], [19, 20, 0.006],
]; // 23 segments per hand

const R_HAND_JNT = 0.009;

// ─── shared temporaries (never used concurrently) ──────────────────────────
const _v2 = new THREE.Vector3();
const _q  = new THREE.Quaternion();
const _Y  = new THREE.Vector3(0, 1, 0);

// ─── coordinate mapping ──────────────────────────────────────────────────────

function lmW(lm: NormalizedLandmark, mx: number, aspect: number): THREE.Vector3 {
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

function makeCylMesh(r: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10, 1), mat);
}

function makeSphereMesh(r: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), mat);
}

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

function placeSph(mesh: THREE.Mesh, p: THREE.Vector3 | null): void {
  if (!p) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.copy(p);
}

// ─── component ───────────────────────────────────────────────────────────────

export interface SkeletonViewportProps {
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  /** Smoothed mocap frame — read every render tick for expression values
   *  (blinks, jaw open, tongue) to animate the mannequin face. */
  frameRef: MutableRefObject<MocapFrame | null>;
  mirror: boolean;
}

export function SkeletonViewport({
  debugLandmarksRef,
  frameRef,
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

    // ── lighting
    const keyLight = new THREE.DirectionalLight(0xffffff, Math.PI * 0.8);
    keyLight.position.set(0.5, 1, 2);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xaabbff, Math.PI * 0.3);
    fillLight.position.set(-1, 0.5, 0.5);
    scene.add(fillLight);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    // ── grid floor
    const grid = new THREE.GridHelper(
      aspectRef.current * 2, 20, 0x333355, 0x1a1a2e,
    );
    grid.position.y = -0.53;
    scene.add(grid);

    // ── materials
    const matL     = new THREE.MeshLambertMaterial({ color: 0x4477cc }); // blue  = left
    const matR     = new THREE.MeshLambertMaterial({ color: 0xcc3344 }); // red   = right
    const matC     = new THREE.MeshLambertMaterial({ color: 0xd4b080 }); // tan   = centre
    // Face features use depthTest:false so they always appear in front of body
    // geometry — in a diagnostic tool, guaranteed visibility beats occlusion realism.
    const matFace      = new THREE.MeshLambertMaterial({ color: 0x66bbff, depthTest: false }); // sky-blue  = iris / eyes
    const matMouth     = new THREE.MeshLambertMaterial({ color: 0xff7755, depthTest: false }); // coral     = mouth outline
    const matMouthOpen = new THREE.MeshLambertMaterial({ color: 0x220008, depthTest: false }); // dark red  = mouth interior
    const matTongue    = new THREE.MeshLambertMaterial({ color: 0xff7799, depthTest: false }); // pink      = tongue

    // ── body radii (world units; full-body height ≈ 0.8 world units)
    const R_HEAD  = 0.045;
    const R_NECK  = 0.016;
    const R_TORSO = 0.055;
    const R_UARM  = 0.020;
    const R_LARM  = 0.016;
    const R_HAND  = 0.019;
    const R_ULEG  = 0.026;
    const R_LLEG  = 0.021;
    const R_FOOT  = 0.014;
    const R_JNT   = 0.022;

    const mkC = (r: number, m: THREE.Material) => makeCylMesh(r, m);
    const mkS = (r: number, m: THREE.Material) => makeSphereMesh(r, m);

    // ── body segments
    const mHead  = mkS(R_HEAD,  matC);
    const mNeck  = mkC(R_NECK,  matC);
    const mTorso = mkC(R_TORSO, matC);

    const mUArmL = mkC(R_UARM, matL); const mUArmR = mkC(R_UARM, matR);
    const mLArmL = mkC(R_LARM, matL); const mLArmR = mkC(R_LARM, matR);
    const mHandL = mkS(R_HAND, matL); const mHandR = mkS(R_HAND, matR);
    const mULegL = mkC(R_ULEG, matL); const mULegR = mkC(R_ULEG, matR);
    const mLLegL = mkC(R_LLEG, matL); const mLLegR = mkC(R_LLEG, matR);
    const mFootL = mkC(R_FOOT, matL); const mFootR = mkC(R_FOOT, matR);

    // ── ball joints
    const mJShL = mkS(R_JNT, matL); const mJShR = mkS(R_JNT, matR);
    const mJElL = mkS(R_JNT, matL); const mJElR = mkS(R_JNT, matR);
    const mJWrL = mkS(R_JNT, matL); const mJWrR = mkS(R_JNT, matR);
    const mJHpL = mkS(R_JNT, matL); const mJHpR = mkS(R_JNT, matR);
    const mJKnL = mkS(R_JNT, matL); const mJKnR = mkS(R_JNT, matR);
    const mJAnL = mkS(R_JNT, matL); const mJAnR = mkS(R_JNT, matR);

    // ── hand finger cylinders + joint spheres (one array per hand)
    const hLCyls   = HAND_SEGS.map((seg) => mkC(seg[2], matL));
    const hRCyls   = HAND_SEGS.map((seg) => mkC(seg[2], matR));
    const hLJoints = Array.from({ length: 21 }, () => mkS(R_HAND_JNT, matL));
    const hRJoints = Array.from({ length: 21 }, () => mkS(R_HAND_JNT, matR));

    // ── face features
    // Iris spheres: position from face mesh lm 468/473; scale.y drives blink
    // (sphere squashes to a flat horizontal disc when eye is closed).
    const mIrisL     = mkS(0.014, matFace);
    const mIrisR     = mkS(0.014, matFace);
    // Nose tip
    const mNoseTip   = mkS(0.010, matFace);
    // Mouth outline (corner-to-corner, lm 61→291)
    const mMouth     = mkC(0.007, matMouth);
    // Mouth opening interior (upper-lip lm 13 → lower-lip lm 14).
    // The gap between these landmarks naturally grows as the jaw opens —
    // no blendshape needed; the raw landmark positions drive it directly.
    const mMouthOpen = mkC(0.010, matMouthOpen);
    // Tongue — appears below the lower lip when the tongueOut blendshape fires.
    const mTongue    = mkS(0.009, matTongue);

    const bodyMeshes: THREE.Mesh[] = [
      mHead, mNeck, mTorso,
      mUArmL, mLArmL, mHandL, mULegL, mLLegL, mFootL,
      mUArmR, mLArmR, mHandR, mULegR, mLLegR, mFootR,
      mJShL, mJElL, mJWrL, mJHpL, mJKnL, mJAnL,
      mJShR, mJElR, mJWrR, mJHpR, mJKnR, mJAnR,
    ];
    const handMeshes: THREE.Mesh[] = [
      ...hLCyls, ...hRCyls, ...hLJoints, ...hRJoints,
    ];
    const faceMeshes: THREE.Mesh[] = [
      mIrisL, mIrisR, mNoseTip, mMouth, mMouthOpen, mTongue,
    ];
    const allMeshes = [...bodyMeshes, ...handMeshes, ...faceMeshes];

    // Indexed triangle mesh — 468 vertices, 852 triangles (from FACE_TRIS).
    // One position slot per landmark; index buffer is static (never changes).
    // Per-frame update: only the Float32Array positions (468*3 = 1404 floats).
    const faceVerts     = new Float32Array(468 * 3);
    const faceGeo       = new THREE.BufferGeometry();
    faceGeo.setAttribute("position", new THREE.BufferAttribute(faceVerts, 3));
    faceGeo.setIndex(new THREE.BufferAttribute(FACE_TRIS, 1));

    // Filled semi-transparent surface — visible at any scale, no 1px line cap.
    const faceSolidMat  = new THREE.MeshBasicMaterial({
      color: 0x50fa7b, transparent: true, opacity: 0.18,
      side: THREE.DoubleSide, depthTest: false,
    });
    // Wireframe overlay on the same geometry to show triangle edges.
    const faceWireMat   = new THREE.MeshBasicMaterial({
      color: 0x50fa7b, wireframe: true, transparent: true, opacity: 0.60,
      depthTest: false,
    });
    const faceSolidMesh = new THREE.Mesh(faceGeo, faceSolidMat);
    const faceWireMesh  = new THREE.Mesh(faceGeo, faceWireMat);
    [faceSolidMesh, faceWireMesh].forEach(m => {
      m.renderOrder = 2;
      m.frustumCulled = false;
    });

    // headGroup acts as the "head bone": positioned at face centroid each frame.
    const headGroup = new THREE.Group();
    headGroup.add(faceSolidMesh);
    headGroup.add(faceWireMesh);
    headGroup.visible = false;
    scene.add(headGroup);

    for (const m of allMeshes) { m.visible = false; scene.add(m); }
    // Face features always draw after the body so depthTest:false reads as
    // "on top of everything" rather than "randomly z-sorted".
    for (const m of faceMeshes) m.renderOrder = 1;

    // ── persistence cache
    // Last visible NormalizedLandmark per pose index. When visibility drops
    // below MIN_VIS, W()/M() fall back to the last-known position instead of
    // hiding the limb (hold-last-good — no snapping to origin on occlusion).
    const lastLm: (NormalizedLandmark | null)[] = new Array(35).fill(null);

    let disposed = false;

    renderer.setAnimationLoop(() => {
      if (disposed) return;

      const pose = debugLandmarksRef.current.pose;
      const mx   = mirrorRef.current ? -1 : 1;
      const asp  = aspectRef.current;

      // Effective pose landmark: live if visible, else last cached.
      // Cache is updated only when the live landmark passes the visibility gate.
      const L = (i: number): NormalizedLandmark | null => {
        const lm = pose?.[i];
        if (lm && (lm.visibility ?? 1) >= MIN_VIS) { lastLm[i] = lm; return lm; }
        return lastLm[i] ?? null;
      };
      // World pos from L() — null only the first time a landmark is ever seen.
      const W = (i: number): THREE.Vector3 | null => {
        const lm = L(i);
        return lm ? lmW(lm, mx, asp) : null;
      };
      // Midpoint of two pose landmarks, persistence-aware.
      const M = (i: number, j: number): THREE.Vector3 | null => {
        const a = L(i), b = L(j);
        if (!a || !b) return null;
        return midW(a, b, mx, asp);
      };
      // World pos for hand / face landmarks (no visibility field — always show).
      const WL = (lms: NormalizedLandmark[] | null, i: number): THREE.Vector3 | null => {
        const lm = lms?.[i];
        return lm ? lmW(lm, mx, asp) : null;
      };

      // ── named pose positions
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

      // ── body
      placeSph(mHead,  nose);
      placeCyl(mNeck,  nose,   midShl);
      placeCyl(mTorso, midShl, midHip);

      placeCyl(mUArmL, shlL,   elbL);    placeCyl(mUArmR, shlR,   elbR);
      placeCyl(mLArmL, elbL,   wristL);  placeCyl(mLArmR, elbR,   wristR);
      placeSph(mHandL, wristL);           placeSph(mHandR, wristR);
      placeCyl(mULegL, hipL,   kneeL);   placeCyl(mULegR, hipR,   kneeR);
      placeCyl(mLLegL, kneeL,  ankleL);  placeCyl(mLLegR, kneeR,  ankleR);
      placeCyl(mFootL, ankleL, toeL);    placeCyl(mFootR, ankleR, toeR);

      // ── ball joints
      placeSph(mJShL, shlL);    placeSph(mJShR, shlR);
      placeSph(mJElL, elbL);    placeSph(mJElR, elbR);
      placeSph(mJWrL, wristL);  placeSph(mJWrR, wristR);
      placeSph(mJHpL, hipL);    placeSph(mJHpR, hipR);
      placeSph(mJKnL, kneeL);   placeSph(mJKnR, kneeR);
      placeSph(mJAnL, ankleL);  placeSph(mJAnR, ankleR);

      // ── hand fingers
      const lHand = debugLandmarksRef.current.leftHand;
      const rHand = debugLandmarksRef.current.rightHand;
      for (let s = 0; s < HAND_SEGS.length; s++) {
        const [a, b] = HAND_SEGS[s];
        placeCyl(hLCyls[s], WL(lHand, a), WL(lHand, b));
        placeCyl(hRCyls[s], WL(rHand, a), WL(rHand, b));
      }
      for (let j = 0; j < 21; j++) {
        placeSph(hLJoints[j], WL(lHand, j));
        placeSph(hRJoints[j], WL(rHand, j));
      }

      // ── face features (MediaPipe face mesh: 468 landmarks + 10 iris)
      //   468 = left iris centre, 473 = right iris centre
      //   4   = nose tip, 61/291 = mouth corners, 13/14 = upper/lower lip centre
      //
      //   All body geometry sits at world_z ≈ 0-0.1. Pinning face features to
      //   z=0.5 puts them between the body and the camera (z=5) so they are
      //   never occluded; depthTest:false on their material removes the last risk.
      const face = debugLandmarksRef.current.face;
      const FACE_Z = 0.5; // constant — well in front of all body parts
      const WF = (lms: NormalizedLandmark[] | null, i: number): THREE.Vector3 | null => {
        const lm = lms?.[i];
        if (!lm) return null;
        return new THREE.Vector3(mx * (lm.x - 0.5) * asp, -(lm.y - 0.5), FACE_Z);
      };

      // Static face landmarks (position only)
      placeSph(mNoseTip, WF(face,   4));
      placeCyl(mMouth,   WF(face,  61), WF(face, 291));

      // Iris: position + blink animation (scale.y squashes sphere → flat disc)
      placeSph(mIrisL, WF(face, 468));
      placeSph(mIrisR, WF(face, 473));
      const exprs  = frameRef.current?.expressions;
      const blinkL = exprs?.blinkLeft ?? 0;
      const blinkR = exprs?.blinkRight ?? 0;
      // reset x/z scale each frame (only y is animated)
      mIrisL.scale.x = mIrisL.scale.z = 1;
      mIrisR.scale.x = mIrisR.scale.z = 1;
      mIrisL.scale.y = mIrisL.visible ? Math.max(0.07, 1 - blinkL * 0.93) : 1;
      mIrisR.scale.y = mIrisR.visible ? Math.max(0.07, 1 - blinkR * 0.93) : 1;

      // Mouth opening: cylinder between upper-lip (lm 13) and lower-lip (lm 14).
      // These landmarks separate naturally as the jaw opens — no blendshape needed.
      placeCyl(mMouthOpen, WF(face, 13), WF(face, 14));

      // Tongue: appears below lower lip when the tongueOut blendshape fires.
      const tongueOut = exprs?.tongueOut ?? 0;
      if (tongueOut > 0.25 && face) {
        const lowerLip = WF(face, 14);
        if (lowerLip) {
          const tp = lowerLip.clone();
          tp.y -= 0.020 * tongueOut; // protrudes below lower lip
          placeSph(mTongue, tp);
        } else {
          mTongue.visible = false;
        }
      } else {
        mTongue.visible = false;
      }

      // Face triangle mesh — headGroup (head bone) positioned at centroid each frame.
      // Only 468 position slots to update per frame; index buffer is static.
      if (face && face.length >= 468) {
        let sumX = 0, sumY = 0;
        for (let i = 0; i < 468; i++) { sumX += face[i].x; sumY += face[i].y; }
        const meanX = sumX / 468;
        const meanY = sumY / 468;
        headGroup.position.set(mx * (meanX - 0.5) * asp, -(meanY - 0.5), FACE_Z);
        headGroup.visible = true;

        for (let i = 0; i < 468; i++) {
          const lm = face[i];
          faceVerts[i * 3    ] = mx * (lm.x - meanX) * asp;
          faceVerts[i * 3 + 1] = -(lm.y - meanY);
          faceVerts[i * 3 + 2] = 0;
        }
        (faceGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      } else {
        headGroup.visible = false;
      }

      renderer.render(scene, camera);
    });

    // ── resize: keep orthographic frustum matched to container aspect ratio
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
      matFace.dispose(); matMouth.dispose();
      matMouthOpen.dispose(); matTongue.dispose();
      faceGeo.dispose(); faceSolidMat.dispose(); faceWireMat.dispose();
      for (const m of allMeshes) m.geometry.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
