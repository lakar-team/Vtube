import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { DebugLandmarks } from "../mocap/types";
import type { RigConfig } from "../mocap/rig";
import { FACE_CONTOURS } from "./faceMeshData";

/**
 * VIEWPORT: 3D Room View (right pane) — Performance View.
 *
 * Renders the mocap subject as a real-scale mannequin in a metric room, driven
 * as a FIXED-PROPORTION rig: bone LENGTHS and thicknesses come from the captured
 * RigConfig (constant), and each frame mocap supplies only the bone DIRECTIONS
 * (from poseWorld landmark deltas — direction is scale-invariant, so the
 * subject's distance never changes any size). Joints are rebuilt by forward
 * kinematics from a hip root at the captured hip height; head/face/hands are
 * sized from RigConfig too. When a direction isn't available the bone falls back
 * to a default T-pose direction, so the mannequin is always visible (e.g. for
 * tuning before any mocap).
 *
 * COORDINATE CONVENTION: poseWorld is meters, y-DOWN, hip-origin. Directions are
 * computed in room space = (mirror*x, -y, -z), normalized; lengths/radii come
 * from RigConfig (cm → m). All cylinders/spheres are unit-sized and scaled per
 * frame, so tuning radii is live.
 */

const MIN_VIS = 0.5;
const ROOM_DEFAULT = 2.5;
const FACE_FIT = 0.85;          // face-mesh height as a fraction of the head-sphere diameter
const R_FINGER_JNT = 0.009;     // finger joint radius (m), not tuned

const NOSE = 0, EAR_L = 7, EAR_R = 8;
const SH_L = 11, SH_R = 12, EL_L = 13, EL_R = 14, WR_L = 15, WR_R = 16;
const HIP_L = 23, HIP_R = 24, KN_L = 25, KN_R = 26, AN_L = 27, AN_R = 28;
const TOE_L = 31, TOE_R = 32;

const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// Default (T-pose) directions in room space, used when a live direction is missing.
const D_UP   = new THREE.Vector3(0, 1, 0);
const D_DOWN = new THREE.Vector3(0, -1, 0);
const D_X    = new THREE.Vector3(1, 0, 0);
const D_ARM_L = new THREE.Vector3(-1, 0, 0);
const D_ARM_R = new THREE.Vector3(1, 0, 0);
const D_FOOT = new THREE.Vector3(0, -0.3, 1).normalize();

// ─── shared temporaries ───────────────────────────────────────────────────
const _v2 = new THREE.Vector3();
const _q  = new THREE.Quaternion();
const _Y  = new THREE.Vector3(0, 1, 0);
const _hp = new THREE.Vector3();

function makeCyl(mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1), mat);
}
function makeSph(mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), mat);
}

/** Place a unit cylinder as a bone a→b with the given radius (meters). */
function placeCyl(mesh: THREE.Mesh, a: THREE.Vector3 | null, b: THREE.Vector3 | null, radius: number): void {
  if (!a || !b) { mesh.visible = false; return; }
  const length = a.distanceTo(b);
  if (length < 1e-4) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  _v2.subVectors(b, a).normalize();
  _q.setFromUnitVectors(_Y, _v2);
  mesh.quaternion.copy(_q);
  mesh.scale.set(radius, length, radius);
}
/** Place a unit sphere at p with the given radius (meters). */
function placeSph(mesh: THREE.Mesh, p: THREE.Vector3 | null, radius: number): void {
  if (!p) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.copy(p);
  mesh.scale.setScalar(radius);
}

interface HandRig {
  joints: THREE.Mesh[];
  bones: THREE.LineSegments;
  bGeom: THREE.BufferGeometry;
  bPos: Float32Array;
}

export interface RoomViewportProps {
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  /** Captured (or tuned) fixed body proportions — drives the whole rig. */
  rigConfig: RigConfig;
  mirror: boolean;
  /** Room cube side length (meters). */
  roomM: number;
}

export function RoomViewport({
  debugLandmarksRef,
  rigConfig,
  mirror,
  roomM,
}: RoomViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const roomMRef = useRef(roomM);
  roomMRef.current = roomM;
  const rigRef = useRef(rigConfig);
  rigRef.current = rigConfig;

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

    const camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.05, 500);
    const r0 = roomMRef.current || ROOM_DEFAULT;
    camera.position.set(r0 * 0.85, 1.55, r0 * 1.45);
    camera.lookAt(0, 1.0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.enableDamping = true;
    controls.update();

    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
    key.position.set(1.5, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xaaccff, Math.PI * 0.3);
    fill.position.set(-2, 1, -1);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));

    const grid = new THREE.GridHelper(1, 10, 0x556699, 0x2a2a40);
    scene.add(grid);
    const cube = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x445577 }),
    );
    scene.add(cube);

    const matL = new THREE.MeshLambertMaterial({ color: 0x4477cc }); // blue = left
    const matR = new THREE.MeshLambertMaterial({ color: 0xcc3344 }); // red  = right
    const matC = new THREE.MeshLambertMaterial({ color: 0xd4b080 }); // tan  = centre

    const figure = new THREE.Group();
    scene.add(figure);

    const mHead  = makeSph(matC);
    const mNeck  = makeCyl(matC);
    const mTorso = makeCyl(matC);

    const mUArmL = makeCyl(matL); const mUArmR = makeCyl(matR);
    const mLArmL = makeCyl(matL); const mLArmR = makeCyl(matR);
    const mHandL = makeSph(matL); const mHandR = makeSph(matR);
    const mULegL = makeCyl(matL); const mULegR = makeCyl(matR);
    const mLLegL = makeCyl(matL); const mLLegR = makeCyl(matR);
    const mFootL = makeCyl(matL); const mFootR = makeCyl(matR);

    const mJShL = makeSph(matL); const mJShR = makeSph(matR);
    const mJElL = makeSph(matL); const mJElR = makeSph(matR);
    const mJWrL = makeSph(matL); const mJWrR = makeSph(matR);
    const mJHpL = makeSph(matL); const mJHpR = makeSph(matR);
    const mJKnL = makeSph(matL); const mJKnR = makeSph(matR);
    const mJAnL = makeSph(matL); const mJAnR = makeSph(matR);

    const meshes: THREE.Mesh[] = [
      mHead, mNeck, mTorso,
      mUArmL, mLArmL, mHandL, mULegL, mLLegL, mFootL,
      mUArmR, mLArmR, mHandR, mULegR, mLLegR, mFootR,
      mJShL, mJElL, mJWrL, mJHpL, mJKnL, mJAnL,
      mJShR, mJElR, mJWrR, mJHpR, mJKnR, mJAnR,
    ];
    for (const m of meshes) { m.visible = false; figure.add(m); }

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

    const matBoneL = new THREE.LineBasicMaterial({ color: 0x88bbff });
    const matBoneR = new THREE.LineBasicMaterial({ color: 0xff99aa });
    const makeHand = (matBone: THREE.Material, matJoint: THREE.Material): HandRig => {
      const joints = Array.from({ length: 21 }, () => makeSph(matJoint));
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

    const heldLm: (NormalizedLandmark | null)[] = new Array(33).fill(null);

    let disposed = false;

    renderer.setAnimationLoop(() => {
      if (disposed) return;

      const roomMv = roomMRef.current || ROOM_DEFAULT;
      grid.scale.set(roomMv, 1, roomMv);
      cube.scale.setScalar(roomMv);
      cube.position.y = roomMv / 2;
      controls.update();

      const pw = debugLandmarksRef.current.poseWorld;
      const poseImg = debugLandmarksRef.current.pose;
      const rig = rigRef.current;
      const mx = mirrorRef.current ? -1 : 1;
      const len = (cm: number) => cm / 100; // cm → meters

      figure.position.set(0, len(rig.hipHeightCm), 0);

      const getLm = (i: number): NormalizedLandmark | null => {
        const lm = pw?.[i];
        if (lm && (lm.visibility ?? 1) >= MIN_VIS) { heldLm[i] = lm; return lm; }
        return heldLm[i] ?? null;
      };
      const RV = (i: number): THREE.Vector3 | null => {
        const lm = getLm(i);
        return lm ? new THREE.Vector3(mx * lm.x, -lm.y, -lm.z) : null;
      };
      const RVm = (i: number, j: number): THREE.Vector3 | null => {
        const a = getLm(i), b = getLm(j);
        if (!a || !b) return null;
        return new THREE.Vector3(mx * (a.x + b.x) / 2, -(a.y + b.y) / 2, -(a.z + b.z) / 2);
      };
      // Live direction a→b (unit), or a default T-pose direction when missing.
      const dir = (a: THREE.Vector3 | null, b: THREE.Vector3 | null, fallback: THREE.Vector3): THREE.Vector3 =>
        a && b ? b.clone().sub(a).normalize() : fallback;
      const ext = (from: THREE.Vector3, d: THREE.Vector3, cm: number): THREE.Vector3 =>
        from.clone().addScaledVector(d, len(cm));

      // ── forward-kinematics skeleton: fixed lengths/radii, live directions ──
      const hipMid = new THREE.Vector3(0, 0, 0);
      const shMid = ext(hipMid, dir(RVm(HIP_L, HIP_R), RVm(SH_L, SH_R), D_UP), rig.torsoCm);
      const headDir = RVm(EAR_L, EAR_R) ? dir(RVm(SH_L, SH_R), RVm(EAR_L, EAR_R), D_UP)
        : dir(RVm(SH_L, SH_R), RV(NOSE), D_UP);
      const headC = ext(shMid, headDir, rig.neckCm);

      const shAxis = dir(RV(SH_L), RV(SH_R), D_X);
      const hipAxis = dir(RV(HIP_L), RV(HIP_R), D_X);
      const shL = shMid.clone().addScaledVector(shAxis, -len(rig.shoulderWidthCm) / 2);
      const shR = shMid.clone().addScaledVector(shAxis,  len(rig.shoulderWidthCm) / 2);
      const hipL = hipMid.clone().addScaledVector(hipAxis, -len(rig.hipWidthCm) / 2);
      const hipR = hipMid.clone().addScaledVector(hipAxis,  len(rig.hipWidthCm) / 2);

      const elL = ext(shL, dir(RV(SH_L), RV(EL_L), D_ARM_L), rig.upperArmCm);
      const elR = ext(shR, dir(RV(SH_R), RV(EL_R), D_ARM_R), rig.upperArmCm);
      const wrL = ext(elL, dir(RV(EL_L), RV(WR_L), D_ARM_L), rig.lowerArmCm);
      const wrR = ext(elR, dir(RV(EL_R), RV(WR_R), D_ARM_R), rig.lowerArmCm);
      const knL = ext(hipL, dir(RV(HIP_L), RV(KN_L), D_DOWN), rig.upperLegCm);
      const knR = ext(hipR, dir(RV(HIP_R), RV(KN_R), D_DOWN), rig.upperLegCm);
      const anL = ext(knL, dir(RV(KN_L), RV(AN_L), D_DOWN), rig.lowerLegCm);
      const anR = ext(knR, dir(RV(KN_R), RV(AN_R), D_DOWN), rig.lowerLegCm);
      const toeL = ext(anL, dir(RV(AN_L), RV(TOE_L), D_FOOT), rig.footCm);
      const toeR = ext(anR, dir(RV(AN_R), RV(TOE_R), D_FOOT), rig.footCm);

      const headR = Math.max(len(rig.headDiameterCm) * 0.65, 0.04);
      const jR = len(rig.jointRcm);
      placeSph(mHead, headC, headR);
      placeCyl(mNeck, headC, shMid, len(rig.neckRcm));
      placeCyl(mTorso, shMid, hipMid, len(rig.torsoRcm));

      placeCyl(mUArmL, shL, elL, len(rig.upperArmRcm));  placeCyl(mUArmR, shR, elR, len(rig.upperArmRcm));
      placeCyl(mLArmL, elL, wrL, len(rig.lowerArmRcm));  placeCyl(mLArmR, elR, wrR, len(rig.lowerArmRcm));
      placeCyl(mULegL, hipL, knL, len(rig.upperLegRcm)); placeCyl(mULegR, hipR, knR, len(rig.upperLegRcm));
      placeCyl(mLLegL, knL, anL, len(rig.lowerLegRcm));  placeCyl(mLLegR, knR, anR, len(rig.lowerLegRcm));
      placeCyl(mFootL, anL, toeL, len(rig.footRcm));     placeCyl(mFootR, anR, toeR, len(rig.footRcm));

      placeSph(mJShL, shL, jR);   placeSph(mJShR, shR, jR);
      placeSph(mJElL, elL, jR);   placeSph(mJElR, elR, jR);
      placeSph(mJWrL, wrL, jR);   placeSph(mJWrR, wrR, jR);
      placeSph(mJHpL, hipL, jR);  placeSph(mJHpR, hipR, jR);
      placeSph(mJKnL, knL, jR);   placeSph(mJKnR, knR, jR);
      placeSph(mJAnL, anL, jR);   placeSph(mJAnR, anR, jR);

      // ── face mesh: sized to the FIXED head, centred + anchored at headC.
      const face = debugLandmarksRef.current.face;
      if (face && face.length >= 468) {
        let cx = 0, cy = 0, cz = 0, minY = 1, maxY = 0;
        for (let i = 0; i < 468; i++) {
          const p = face[i];
          cx += p.x; cy += p.y; cz += p.z;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        cx /= 468; cy /= 468; cz /= 468;
        const fScale = (headR * 2 * FACE_FIT) / Math.max(maxY - minY, 1e-3);
        for (let k = 0; k < FACE_CONTOURS.length; k++) {
          const p = face[FACE_CONTOURS[k]];
          facePos[k * 3]     = mx * (p.x - cx) * fScale;
          facePos[k * 3 + 1] = -(p.y - cy) * fScale;
          facePos[k * 3 + 2] = -(p.z - cz) * fScale;
        }
        faceGeom.attributes.position.needsUpdate = true;
        faceMesh.position.copy(headC);
        faceMesh.visible = true;
      } else {
        faceMesh.visible = false;
      }

      // ── hands: fingers at the FK wrist, sized from the FIXED captured forearm.
      const fist = (wr: THREE.Vector3, el: THREE.Vector3): THREE.Vector3 =>
        wr.clone().addScaledVector(_v2.subVectors(wr, el).normalize(), 0.09);
      const realHandM = len(rig.lowerArmCm) * 0.75;
      const handR = len(rig.handRcm);
      const lHand = debugLandmarksRef.current.leftHand;
      const rHand = debugLandmarksRef.current.rightHand;
      const wristSide = (hd: NormalizedLandmark[] | null): "L" | "R" | null => {
        if (!hd || !hd[0] || !poseImg) return null;
        const hw = hd[0];
        const pl = poseImg[WR_L], pr = poseImg[WR_R];
        const dl = pl ? Math.hypot(hw.x - pl.x, hw.y - pl.y) : Infinity;
        const dr = pr ? Math.hypot(hw.x - pr.x, hw.y - pr.y) : Infinity;
        if (dl === Infinity && dr === Infinity) return null;
        return dl <= dr ? "L" : "R";
      };
      let dataForL: NormalizedLandmark[] | null = null;
      let dataForR: NormalizedLandmark[] | null = null;
      for (const hd of [lHand, rHand]) {
        const side = wristSide(hd);
        if (side === "L") dataForL = hd;
        else if (side === "R") dataForR = hd;
      }
      const updateHand = (
        hr: HandRig,
        lm: NormalizedLandmark[] | null,
        wrist: THREE.Vector3,
      ): boolean => {
        if (!lm || lm.length < 21) {
          for (const j of hr.joints) j.visible = false;
          hr.bones.visible = false;
          return false;
        }
        const lm0 = lm[0], mid = lm[12];
        const span = Math.hypot(mid.x - lm0.x, mid.y - lm0.y, mid.z - lm0.z);
        const s = realHandM / Math.max(span, 1e-3);
        const hp = (i: number): THREE.Vector3 => {
          const p = lm[i];
          return _hp.set(
            wrist.x + mx * (p.x - lm0.x) * s,
            wrist.y - (p.y - lm0.y) * s,
            wrist.z - (p.z - lm0.z) * s,
          );
        };
        for (let i = 0; i < 21; i++) placeSph(hr.joints[i], hp(i), R_FINGER_JNT);
        for (let k = 0; k < HAND_BONES.length; k++) {
          const [a, b] = HAND_BONES[k];
          const pa = hp(a); const ax = pa.x, ay = pa.y, az = pa.z;
          const pb = hp(b);
          hr.bPos[k * 6]     = ax;   hr.bPos[k * 6 + 1] = ay;   hr.bPos[k * 6 + 2] = az;
          hr.bPos[k * 6 + 3] = pb.x; hr.bPos[k * 6 + 4] = pb.y; hr.bPos[k * 6 + 5] = pb.z;
        }
        hr.bGeom.attributes.position.needsUpdate = true;
        hr.bones.visible = true;
        return true;
      };
      const lFingers = updateHand(handLeft, dataForL, wrL);
      const rFingers = updateHand(handRight, dataForR, wrR);
      placeSph(mHandL, lFingers ? null : fist(wrL, elL), handR);
      placeSph(mHandR, rFingers ? null : fist(wrR, elR), handR);

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
      controls.dispose();
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
        3D room view · fixed-proportion rig ({roomM}m room · drag to orbit) ·{" "}
        <span style={{ color: "#4477cc" }}>blue=left</span> ·{" "}
        <span style={{ color: "#cc3344" }}>red=right</span> ·{" "}
        <span style={{ color: "#66ddff" }}>face</span>
      </div>
    </div>
  );
}
