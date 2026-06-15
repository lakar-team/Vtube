import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { DebugLandmarks } from "../mocap/types";
import type { BodyCalibration } from "../mocap/bodyCalibration";
import { FACE_CONTOURS } from "./faceMeshData";

/**
 * VIEWPORT: 3D Room View (right pane) — metric implementation.
 *
 * Renders the mocap subject as a real-scale mannequin standing inside a room of
 * real dimensions, under a PERSPECTIVE camera. Positions come from MediaPipe
 * `worldLandmarks` (meters, hip-origin) scaled by the height calibration — so
 * proportions are consistent regardless of distance from the camera.
 *
 * COORDINATE CONVERSION (worldLandmarks → room):
 *   worldLandmarks are meters with y DOWN, origin at the hip midpoint. The
 *   mannequin is built in a Group anchored at the calibrated hip height; each
 *   landmark maps to group-local coords: local = ( mirror*x, -y, -z ) * scale
 *   (y flipped to y-up; z flipped so "toward camera" faces the viewer).
 *
 * FACE + HANDS (Phase 4): the FaceLandmarker mesh and HandLandmarker fingers are
 * normalized image-space (not metric world), so they're placed via the fallback
 * approach — re-centred on their own anchor (head centre / wrist), scaled to a
 * real size from calibration, and converted with the same axis convention. This
 * sidesteps aligning the face camera-frame with the pose hip-frame.
 */

const MIN_VIS = 0.5;
const HIP_HEIGHT_RATIO = 0.53; // hip height / stature, adult mean
const ROOM_M = 2.5;            // room cube side (meters) — adjustable in Phase 5
const DEFAULT_HEAD_DIAMETER_M = 0.18;

// Metric segment radii (meters) — real-world-ish limb thicknesses.
const R_NECK = 0.035;
const R_TORSO = 0.090;
const R_UARM = 0.045;
const R_LARM = 0.033;
const R_ULEG = 0.070;
const R_LLEG = 0.050;
const R_FOOT = 0.030;
const R_JNT = 0.040;
const R_HAND = 0.065;   // "fist" fallback marker when fingers aren't detected
const R_FINGER_JNT = 0.009;

// Pose landmark indices.
const NOSE = 0, EAR_L = 7, EAR_R = 8;
const SH_L = 11, SH_R = 12, EL_L = 13, EL_R = 14, WR_L = 15, WR_R = 16;
const HIP_L = 23, HIP_R = 24, KN_L = 25, KN_R = 26, AN_L = 27, AN_R = 28;
const TOE_L = 31, TOE_R = 32;

// Hand bone connections (21-point MediaPipe hand topology).
const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],       // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],       // index
  [5, 9], [9, 10], [10, 11], [11, 12],  // middle
  [9, 13], [13, 14], [14, 15], [15, 16],// ring
  [13, 17], [17, 18], [18, 19], [19, 20],// little
  [0, 17],                              // palm edge
];

// ─── shared temporaries ───────────────────────────────────────────────────
const _v2 = new THREE.Vector3();
const _q  = new THREE.Quaternion();
const _Y  = new THREE.Vector3(0, 1, 0);
const _hp = new THREE.Vector3();

function makeCyl(r: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 12, 1), mat);
}
function makeSph(r: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), mat);
}

function placeCyl(mesh: THREE.Mesh, a: THREE.Vector3 | null, b: THREE.Vector3 | null): void {
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
function placeSph(mesh: THREE.Mesh, p: THREE.Vector3 | null, r?: number): void {
  if (!p) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.copy(p);
  if (r !== undefined) mesh.scale.setScalar(r);
}

interface HandRig {
  joints: THREE.Mesh[];
  bones: THREE.LineSegments;
  bGeom: THREE.BufferGeometry;
  bPos: Float32Array;
}

export interface RoomViewportProps {
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  calibrationRef: MutableRefObject<BodyCalibration | null>;
  mirror: boolean;
  /** Real standing height (cm) — anchors the mannequin's hip height. */
  heightCm: number;
}

export function RoomViewport({
  debugLandmarksRef,
  calibrationRef,
  mirror,
  heightCm,
}: RoomViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
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

    const camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.05, 50);
    camera.position.set(ROOM_M * 0.85, 1.55, ROOM_M * 1.45);
    camera.lookAt(0, 1.0, 0);

    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
    key.position.set(1.5, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xaaccff, Math.PI * 0.3);
    fill.position.set(-2, 1, -1);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));

    // ── room: floor grid + wireframe cube edges
    const grid = new THREE.GridHelper(ROOM_M, 10, 0x556699, 0x2a2a40);
    scene.add(grid);
    const cube = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(ROOM_M, ROOM_M, ROOM_M)),
      new THREE.LineBasicMaterial({ color: 0x445577 }),
    );
    cube.position.y = ROOM_M / 2;
    scene.add(cube);

    // ── materials (same colour code as the skeleton view)
    const matL = new THREE.MeshLambertMaterial({ color: 0x4477cc }); // blue = left
    const matR = new THREE.MeshLambertMaterial({ color: 0xcc3344 }); // red  = right
    const matC = new THREE.MeshLambertMaterial({ color: 0xd4b080 }); // tan  = centre

    const figure = new THREE.Group();
    scene.add(figure);

    const mHead  = makeSph(1, matC); // unit-radius sphere; scaled to head radius each frame
    const mNeck  = makeCyl(R_NECK, matC);
    const mTorso = makeCyl(R_TORSO, matC);

    const mUArmL = makeCyl(R_UARM, matL); const mUArmR = makeCyl(R_UARM, matR);
    const mLArmL = makeCyl(R_LARM, matL); const mLArmR = makeCyl(R_LARM, matR);
    const mHandL = makeSph(R_HAND, matL); const mHandR = makeSph(R_HAND, matR);
    const mULegL = makeCyl(R_ULEG, matL); const mULegR = makeCyl(R_ULEG, matR);
    const mLLegL = makeCyl(R_LLEG, matL); const mLLegR = makeCyl(R_LLEG, matR);
    const mFootL = makeCyl(R_FOOT, matL); const mFootR = makeCyl(R_FOOT, matR);

    const mkJ = (mat: THREE.Material) => makeSph(R_JNT, mat);
    const mJShL = mkJ(matL); const mJShR = mkJ(matR);
    const mJElL = mkJ(matL); const mJElR = mkJ(matR);
    const mJWrL = mkJ(matL); const mJWrR = mkJ(matR);
    const mJHpL = mkJ(matL); const mJHpR = mkJ(matR);
    const mJKnL = mkJ(matL); const mJKnR = mkJ(matR);
    const mJAnL = mkJ(matL); const mJAnR = mkJ(matR);

    const meshes: THREE.Mesh[] = [
      mHead, mNeck, mTorso,
      mUArmL, mLArmL, mHandL, mULegL, mLLegL, mFootL,
      mUArmR, mLArmR, mHandR, mULegR, mLLegR, mFootR,
      mJShL, mJElL, mJWrL, mJHpL, mJKnL, mJAnL,
      mJShR, mJElR, mJWrR, mJHpR, mJKnR, mJAnR,
    ];
    for (const m of meshes) { m.visible = false; figure.add(m); }

    // ── face contour mesh on the head (depthTest:false → always reads on top)
    const matFace = new THREE.LineBasicMaterial({
      color: 0x66ddff, transparent: true, opacity: 0.95, depthTest: false,
    });
    const faceGeom = new THREE.BufferGeometry();
    const facePos = new Float32Array(FACE_CONTOURS.length * 3);
    faceGeom.setAttribute("position", new THREE.BufferAttribute(facePos, 3));
    const faceMesh = new THREE.LineSegments(faceGeom, matFace);
    faceMesh.frustumCulled = false;
    faceMesh.renderOrder = 2;
    faceMesh.visible = false;
    figure.add(faceMesh);

    // ── per-hand finger rigs (21 joints + bone lines), anchored at the wrist
    const matBoneL = new THREE.LineBasicMaterial({ color: 0x88bbff });
    const matBoneR = new THREE.LineBasicMaterial({ color: 0xff99aa });
    const makeHand = (matBone: THREE.Material, matJoint: THREE.Material): HandRig => {
      const joints = Array.from({ length: 21 }, () => makeSph(R_FINGER_JNT, matJoint));
      for (const j of joints) { j.visible = false; figure.add(j); }
      const bGeom = new THREE.BufferGeometry();
      const bPos = new Float32Array(HAND_BONES.length * 2 * 3);
      bGeom.setAttribute("position", new THREE.BufferAttribute(bPos, 3));
      const bones = new THREE.LineSegments(bGeom, matBone);
      bones.frustumCulled = false;
      bones.visible = false;
      figure.add(bones);
      return { joints, bones, bGeom, bPos };
    };
    const handLeft = makeHand(matBoneL, matL);
    const handRight = makeHand(matBoneR, matR);

    // hold-last-good world landmark per index (avoids flicker on brief drops)
    const heldLm: (NormalizedLandmark | null)[] = new Array(33).fill(null);

    let disposed = false;

    renderer.setAnimationLoop(() => {
      if (disposed) return;

      const pw = debugLandmarksRef.current.poseWorld;
      const cal = calibrationRef.current;
      const scale = cal?.metersPerUnit ?? 1;
      const mx = mirrorRef.current ? -1 : 1;

      const statureM = heightCmRef.current / 100;
      figure.position.set(0, HIP_HEIGHT_RATIO * statureM, 0);

      const getLm = (i: number): NormalizedLandmark | null => {
        const lm = pw?.[i];
        if (lm && (lm.visibility ?? 1) >= MIN_VIS) { heldLm[i] = lm; return lm; }
        return heldLm[i] ?? null;
      };
      const local = (p: { x: number; y: number; z: number }): THREE.Vector3 =>
        new THREE.Vector3(mx * p.x * scale, -p.y * scale, -p.z * scale);
      const W = (i: number): THREE.Vector3 | null => {
        const lm = getLm(i);
        return lm ? local(lm) : null;
      };
      const M = (i: number, j: number): THREE.Vector3 | null => {
        const a = getLm(i), b = getLm(j);
        if (!a || !b) return null;
        return local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
      };

      const midSh = M(SH_L, SH_R);
      const midHip = M(HIP_L, HIP_R);

      const earL = W(EAR_L), earR = W(EAR_R), nose = W(NOSE);
      const headCenter =
        earL && earR ? earL.clone().add(earR).multiplyScalar(0.5)
        : nose ? nose
        : midSh ? midSh.clone().add(new THREE.Vector3(0, 0.22, 0))
        : null;

      const shL = W(SH_L), shR = W(SH_R);
      const elL = W(EL_L), elR = W(EL_R);
      const wrL = W(WR_L), wrR = W(WR_R);
      const hipL = W(HIP_L), hipR = W(HIP_R);
      const knL = W(KN_L), knR = W(KN_R);
      const anL = W(AN_L), anR = W(AN_R);
      const toeL = W(TOE_L), toeR = W(TOE_R);

      const fist = (wr: THREE.Vector3 | null, el: THREE.Vector3 | null): THREE.Vector3 | null => {
        if (!wr) return null;
        if (!el) return wr;
        return wr.clone().addScaledVector(_v2.subVectors(wr, el).normalize(), 0.09);
      };

      const headDiamM = cal?.headDiameterCm ? cal.headDiameterCm / 100 : DEFAULT_HEAD_DIAMETER_M;
      const headR = Math.max(headDiamM * 0.65, 0.07);
      placeSph(mHead, headCenter, headR);
      placeCyl(mNeck, headCenter, midSh);
      placeCyl(mTorso, midSh, midHip);

      placeCyl(mUArmL, shL, elL);  placeCyl(mUArmR, shR, elR);
      placeCyl(mLArmL, elL, wrL);  placeCyl(mLArmR, elR, wrR);
      placeCyl(mULegL, hipL, knL); placeCyl(mULegR, hipR, knR);
      placeCyl(mLLegL, knL, anL);  placeCyl(mLLegR, knR, anR);
      placeCyl(mFootL, anL, toeL); placeCyl(mFootR, anR, toeR);

      placeSph(mJShL, shL);   placeSph(mJShR, shR);
      placeSph(mJElL, elL);   placeSph(mJElR, elR);
      placeSph(mJWrL, wrL);   placeSph(mJWrR, wrR);
      placeSph(mJHpL, hipL);  placeSph(mJHpR, hipR);
      placeSph(mJKnL, knL);   placeSph(mJKnR, knR);
      placeSph(mJAnL, anL);   placeSph(mJAnR, anR);

      // ── face contour mesh: re-centred on its own centroid, scaled to the
      //    head width, placed at the head centre. Landmarks carry head rotation.
      const face = debugLandmarksRef.current.face;
      if (face && face.length >= 468 && headCenter) {
        let cx = 0, cy = 0, cz = 0, minX = 1, maxX = 0;
        for (let i = 0; i < 468; i++) {
          const p = face[i];
          cx += p.x; cy += p.y; cz += p.z;
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
        }
        cx /= 468; cy /= 468; cz /= 468;
        const fScale = headDiamM / Math.max(maxX - minX, 1e-3);
        for (let k = 0; k < FACE_CONTOURS.length; k++) {
          const p = face[FACE_CONTOURS[k]];
          facePos[k * 3]     = mx * (p.x - cx) * fScale;
          facePos[k * 3 + 1] = -(p.y - cy) * fScale;
          facePos[k * 3 + 2] = -(p.z - cz) * fScale;
        }
        faceGeom.attributes.position.needsUpdate = true;
        faceMesh.position.copy(headCenter);
        faceMesh.visible = true;
      } else {
        faceMesh.visible = false;
      }

      // ── hands: finger skeleton when detected, else a fist marker at the wrist
      const lHand = debugLandmarksRef.current.leftHand;
      const rHand = debugLandmarksRef.current.rightHand;
      const updateHand = (
        rig: HandRig,
        lm: NormalizedLandmark[] | null,
        wrist: THREE.Vector3 | null,
      ): boolean => {
        if (!lm || lm.length < 21 || !wrist) {
          for (const j of rig.joints) j.visible = false;
          rig.bones.visible = false;
          return false;
        }
        const lm0 = lm[0], mid = lm[12];
        const span = Math.hypot(mid.x - lm0.x, mid.y - lm0.y, mid.z - lm0.z);
        const realHandM = (cal?.lowerArmCm ? cal.lowerArmCm / 100 : 0.25) * 0.75;
        const s = realHandM / Math.max(span, 1e-3);
        const hp = (i: number): THREE.Vector3 => {
          const p = lm[i];
          return _hp.set(
            wrist.x + mx * (p.x - lm0.x) * s,
            wrist.y - (p.y - lm0.y) * s,
            wrist.z - (p.z - lm0.z) * s,
          );
        };
        for (let i = 0; i < 21; i++) placeSph(rig.joints[i], hp(i));
        for (let k = 0; k < HAND_BONES.length; k++) {
          const [a, b] = HAND_BONES[k];
          const pa = hp(a); const ax = pa.x, ay = pa.y, az = pa.z;
          const pb = hp(b);
          rig.bPos[k * 6]     = ax;   rig.bPos[k * 6 + 1] = ay;   rig.bPos[k * 6 + 2] = az;
          rig.bPos[k * 6 + 3] = pb.x; rig.bPos[k * 6 + 4] = pb.y; rig.bPos[k * 6 + 5] = pb.z;
        }
        rig.bGeom.attributes.position.needsUpdate = true;
        rig.bones.visible = true;
        return true;
      };
      const lFingers = updateHand(handLeft, lHand, wrL);
      const rFingers = updateHand(handRight, rHand, wrR);
      placeSph(mHandL, lFingers ? null : fist(wrL, elL));
      placeSph(mHandR, rFingers ? null : fist(wrR, elR));

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
      ro.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.domElement.remove();
      matL.dispose(); matR.dispose(); matC.dispose();
      matFace.dispose(); matBoneL.dispose(); matBoneR.dispose();
      grid.dispose();
      (cube.geometry as THREE.BufferGeometry).dispose();
      (cube.material as THREE.Material).dispose();
      faceGeom.dispose();
      handLeft.bGeom.dispose(); handRight.bGeom.dispose();
      for (const m of meshes) m.geometry.dispose();
      for (const j of handLeft.joints) j.geometry.dispose();
      for (const j of handRight.joints) j.geometry.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugLandmarksRef]);

  return (
    <div ref={containerRef} className="avatar-viewport">
      <div className="viewport-badge">
        3D room view · metric mannequin ({ROOM_M}m room) ·{" "}
        <span style={{ color: "#4477cc" }}>blue=left</span> ·{" "}
        <span style={{ color: "#cc3344" }}>red=right</span> ·{" "}
        <span style={{ color: "#66ddff" }}>face</span>
      </div>
    </div>
  );
}
