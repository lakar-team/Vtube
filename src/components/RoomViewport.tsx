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
 * as a FIXED-PROPORTION rig: bone LENGTHS come from the captured RigConfig
 * (constant), and each frame mocap supplies only the bone DIRECTIONS (from the
 * poseWorld landmark deltas — direction is scale-invariant, so the subject's
 * distance from the camera no longer changes any size). Joint positions are
 * rebuilt by forward kinematics from a hip root anchored at the captured hip
 * height. Head, face mesh, and hands are likewise sized from RigConfig, not from
 * live per-frame calibration.
 *
 * COORDINATE CONVENTION: poseWorld is meters, y-DOWN, hip-origin. We work in
 * "room-space direction" units = (mirror*x, -y, -z) (y-up; z toward viewer),
 * normalized for directions; lengths come from RigConfig (cm → m).
 */

const MIN_VIS = 0.5;
const ROOM_DEFAULT = 2.5;
const FACE_FIT = 0.85; // face-mesh height as a fraction of the head-sphere diameter

// Metric segment radii (meters) — real-world-ish limb thicknesses (tunable later).
const R_NECK = 0.035;
const R_TORSO = 0.090;
const R_UARM = 0.045;
const R_LARM = 0.033;
const R_ULEG = 0.070;
const R_LLEG = 0.050;
const R_FOOT = 0.030;
const R_JNT = 0.040;
const R_HAND = 0.065;
const R_FINGER_JNT = 0.009;

// Pose landmark indices.
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
  /** Captured (or default) fixed body proportions — drives the whole rig. */
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

    const mHead  = makeSph(1, matC); // unit-radius; scaled to head radius each frame
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

    // face contour mesh (sized to the head, depthTest:false → reads on top)
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

      // Anchor the hip root at the captured hip height above the floor.
      figure.position.set(0, len(rig.hipHeightCm), 0);

      // hold-last-good landmark; raw room-space vector for DIRECTIONS only.
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
      const dirOf = (a: THREE.Vector3 | null, b: THREE.Vector3 | null): THREE.Vector3 | null =>
        a && b ? b.clone().sub(a).normalize() : null;
      const ext = (from: THREE.Vector3 | null, d: THREE.Vector3 | null, cm: number): THREE.Vector3 | null =>
        from && d ? from.clone().addScaledVector(d, len(cm)) : null;

      // ── forward-kinematics skeleton: fixed lengths, live directions ──
      const hipMid = new THREE.Vector3(0, 0, 0);          // root (group is at hip height)
      const shMid = ext(hipMid, dirOf(RVm(HIP_L, HIP_R), RVm(SH_L, SH_R)), rig.torsoCm);
      const headC = ext(shMid, dirOf(RVm(SH_L, SH_R), RVm(EAR_L, EAR_R)), rig.neckCm)
        ?? ext(shMid, dirOf(RVm(SH_L, SH_R), RV(NOSE)), rig.neckCm);

      const shAxis = dirOf(RV(SH_L), RV(SH_R));
      const hipAxis = dirOf(RV(HIP_L), RV(HIP_R));
      const shL = shMid && shAxis ? shMid.clone().addScaledVector(shAxis, -len(rig.shoulderWidthCm) / 2) : null;
      const shR = shMid && shAxis ? shMid.clone().addScaledVector(shAxis,  len(rig.shoulderWidthCm) / 2) : null;
      const hipL = hipAxis ? hipMid.clone().addScaledVector(hipAxis, -len(rig.hipWidthCm) / 2) : null;
      const hipR = hipAxis ? hipMid.clone().addScaledVector(hipAxis,  len(rig.hipWidthCm) / 2) : null;

      const elL = ext(shL, dirOf(RV(SH_L), RV(EL_L)), rig.upperArmCm);
      const elR = ext(shR, dirOf(RV(SH_R), RV(EL_R)), rig.upperArmCm);
      const wrL = ext(elL, dirOf(RV(EL_L), RV(WR_L)), rig.lowerArmCm);
      const wrR = ext(elR, dirOf(RV(EL_R), RV(WR_R)), rig.lowerArmCm);
      const knL = ext(hipL, dirOf(RV(HIP_L), RV(KN_L)), rig.upperLegCm);
      const knR = ext(hipR, dirOf(RV(HIP_R), RV(KN_R)), rig.upperLegCm);
      const anL = ext(knL, dirOf(RV(KN_L), RV(AN_L)), rig.lowerLegCm);
      const anR = ext(knR, dirOf(RV(KN_R), RV(AN_R)), rig.lowerLegCm);
      const toeL = ext(anL, dirOf(RV(AN_L), RV(TOE_L)), rig.footCm);
      const toeR = ext(anR, dirOf(RV(AN_R), RV(TOE_R)), rig.footCm);

      const headDiamM = len(rig.headDiameterCm);
      const headR = Math.max(headDiamM * 0.65, 0.07);
      placeSph(mHead, headC, headR);
      placeCyl(mNeck, headC, shMid);
      placeCyl(mTorso, shMid, hipMid);

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

      // ── face mesh: sized to the FIXED head (rig), centred + anchored at headC.
      //    Its own image height (yaw-invariant) maps to the head-sphere diameter,
      //    so it's constant size regardless of camera distance.
      const face = debugLandmarksRef.current.face;
      if (face && face.length >= 468 && headC) {
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
      const fist = (wr: THREE.Vector3 | null, el: THREE.Vector3 | null): THREE.Vector3 | null => {
        if (!wr) return null;
        if (!el) return wr;
        return wr.clone().addScaledVector(_v2.subVectors(wr, el).normalize(), 0.09);
      };
      const realHandM = len(rig.lowerArmCm) * 0.75; // fixed hand length from capture
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
        rig2: HandRig,
        lm: NormalizedLandmark[] | null,
        wrist: THREE.Vector3 | null,
      ): boolean => {
        if (!lm || lm.length < 21 || !wrist) {
          for (const j of rig2.joints) j.visible = false;
          rig2.bones.visible = false;
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
        for (let i = 0; i < 21; i++) placeSph(rig2.joints[i], hp(i));
        for (let k = 0; k < HAND_BONES.length; k++) {
          const [a, b] = HAND_BONES[k];
          const pa = hp(a); const ax = pa.x, ay = pa.y, az = pa.z;
          const pb = hp(b);
          rig2.bPos[k * 6]     = ax;   rig2.bPos[k * 6 + 1] = ay;   rig2.bPos[k * 6 + 2] = az;
          rig2.bPos[k * 6 + 3] = pb.x; rig2.bPos[k * 6 + 4] = pb.y; rig2.bPos[k * 6 + 5] = pb.z;
        }
        rig2.bGeom.attributes.position.needsUpdate = true;
        rig2.bones.visible = true;
        return true;
      };
      const lFingers = updateHand(handLeft, dataForL, wrL);
      const rFingers = updateHand(handRight, dataForR, wrR);
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
