/**
 * Joint-Match retargeting: orient each VRM bone so the segment direction matches
 * the corresponding skeleton-mannequin segment from raw MediaPipe landmarks.
 * No Kalidokit — pure direction matching.
 *
 * COORDINATE SYSTEM
 *   Same as SkeletonViewport's lmW():
 *     world_x = mx * (lm.x - 0.5) * aspect
 *     world_y = -(lm.y - 0.5)
 *     world_z = -(lm.z ?? 0) * Z_SCALE
 *   mx = -1 (mirror/VTuber) or +1 (non-mirror).
 *
 * LANDMARK ↔ BONE MAPPING (VTuber mirror convention)
 *   Mirror mode (mx=-1): subject's right drives avatar's LEFT bones.
 *     Because: your right hand appears on the RIGHT of the mirror, and
 *     the avatar's LEFT arm (+X, viewer's right) is also on that side.
 *   Non-mirror (mx=+1): subject's left drives avatar's LEFT bones.
 *
 *   MediaPipe LEFT  landmarks: 11,13,15 (arm)  23,25,27 (leg)
 *   MediaPipe RIGHT landmarks: 12,14,16 (arm)  24,26,28 (leg)
 *
 * ALGORITHM (per bone, top-down order to keep parent→child correct):
 *   R_local = R_parent_world⁻¹ × R_fromTo(restDir_world, targetDir_world)
 *
 *   restDir_world: T-pose bone direction in world space, measured once at VRM
 *   load (all normalized bones at identity, before any rotations).
 *
 * PARENT CHAIN
 *   applyMocapToVRM runs first (spine/hips/head/expressions). We do NOT reset
 *   those bones — we let Kalidokit handle torso/head while we override only the
 *   limb bones. getBoneDir() reads the live parent world-quaternion so the
 *   local-space conversion is always correct regardless of spine rotation.
 */

import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

const Z_SCALE = 0.5;   // keep in sync with SkeletonViewport
const MIN_VIS  = 0.45; // visibility gate (same as skeleton mannequin)

// ─── scratch (not allocated per-frame) ───────────────────────────────────────
const _pWorldQ    = new THREE.Quaternion();
const _pWorldQInv = new THREE.Quaternion();
const _rotFT      = new THREE.Quaternion();
const _localRot   = new THREE.Quaternion();
const _va         = new THREE.Vector3();
const _vb         = new THREE.Vector3();
const _tgt        = new THREE.Vector3();
const _perpAxis   = new THREE.Vector3();

// ─── landmark → Three.js world (identical to SkeletonViewport) ───────────────

function lmW(lm: NormalizedLandmark, mx: number, aspect: number): THREE.Vector3 {
  return new THREE.Vector3(
    mx * (lm.x - 0.5) * aspect,
    -(lm.y - 0.5),
    -(lm.z ?? 0) * Z_SCALE,
  );
}

function visible(lm: NormalizedLandmark | undefined): boolean {
  return lm !== undefined && (lm.visibility ?? 1) >= MIN_VIS;
}

/** Normalized direction from pose[iA] to pose[iB], written into `out`. Returns false if invisible. */
function segDir(
  pose: NormalizedLandmark[],
  iA: number,
  iB: number,
  mx: number,
  aspect: number,
  out: THREE.Vector3,
): boolean {
  if (!visible(pose[iA]) || !visible(pose[iB])) return false;
  _va.copy(lmW(pose[iA], mx, aspect));
  _vb.copy(lmW(pose[iB], mx, aspect)).sub(_va);
  const len = _vb.length();
  if (len < 1e-6) return false;
  out.copy(_vb).divideScalar(len);
  return true;
}

// ─── safe quaternion from two unit vectors (handles anti-parallel) ────────────

function safeFromUnitVectors(
  out: THREE.Quaternion,
  from: THREE.Vector3,
  to: THREE.Vector3,
): void {
  const dot = from.dot(to);
  if (dot > 0.9999)  { out.identity(); return; }
  if (dot < -0.9999) {
    _perpAxis.set(1, 0, 0);
    if (Math.abs(from.x) > 0.9) _perpAxis.set(0, 1, 0);
    _perpAxis.crossVectors(from, _perpAxis).normalize();
    out.setFromAxisAngle(_perpAxis, Math.PI);
    return;
  }
  out.setFromUnitVectors(from, to);
}

// ─── rest-direction cache (T-pose, measured once per VRM instance) ────────────

interface RestDirs {
  leftUpperArm:  THREE.Vector3;
  leftLowerArm:  THREE.Vector3;
  rightUpperArm: THREE.Vector3;
  rightLowerArm: THREE.Vector3;
  leftUpperLeg:  THREE.Vector3;
  leftLowerLeg:  THREE.Vector3;
  rightUpperLeg: THREE.Vector3;
  rightLowerLeg: THREE.Vector3;
}

const restDirCache = new WeakMap<VRM, RestDirs>();

function measureDir(vrm: VRM, from: VRMHumanBoneName, to: VRMHumanBoneName): THREE.Vector3 {
  const p = vrm.humanoid.getNormalizedBoneNode(from);
  const c = vrm.humanoid.getNormalizedBoneNode(to);
  if (!p || !c) return new THREE.Vector3(0, -1, 0);
  const pv = new THREE.Vector3(), cv = new THREE.Vector3();
  p.getWorldPosition(pv);
  c.getWorldPosition(cv);
  const d = cv.sub(pv);
  return d.length() < 1e-6 ? new THREE.Vector3(0, -1, 0) : d.normalize();
}

/**
 * Cache T-pose rest directions. Must be called immediately after the VRM is
 * added to the Three.js scene (before any frame renders modify bone rotations).
 */
export function initJointMatchCache(vrm: VRM): void {
  vrm.scene.updateMatrixWorld(true); // ensure world matrices reflect T-pose
  restDirCache.set(vrm, {
    leftUpperArm:  measureDir(vrm, "leftUpperArm",  "leftLowerArm"),
    leftLowerArm:  measureDir(vrm, "leftLowerArm",  "leftHand"),
    rightUpperArm: measureDir(vrm, "rightUpperArm", "rightLowerArm"),
    rightLowerArm: measureDir(vrm, "rightLowerArm", "rightHand"),
    leftUpperLeg:  measureDir(vrm, "leftUpperLeg",  "leftLowerLeg"),
    leftLowerLeg:  measureDir(vrm, "leftLowerLeg",  "leftFoot"),
    rightUpperLeg: measureDir(vrm, "rightUpperLeg", "rightLowerLeg"),
    rightLowerLeg: measureDir(vrm, "rightLowerLeg", "rightFoot"),
  });
}

// ─── per-bone rotation setter ─────────────────────────────────────────────────

/**
 * Orient `boneName` so its segment points in `targetDirWorld` (world space).
 * Uses the actual parent world-quaternion so spine/hips rotations from
 * applyMocapToVRM are accounted for automatically.
 */
function setBoneDir(
  vrm: VRM,
  boneName: VRMHumanBoneName,
  restDirWorld: THREE.Vector3,
  targetDirWorld: THREE.Vector3,
): void {
  const node = vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!node?.parent) return;

  // Propagate any rotations set earlier this frame up through the parent chain.
  node.parent.updateWorldMatrix(true, false);
  node.parent.getWorldQuaternion(_pWorldQ);
  _pWorldQInv.copy(_pWorldQ).invert();

  // R_local = R_parent_world⁻¹ × R_fromTo(restDir_world, targetDir_world)
  safeFromUnitVectors(_rotFT, restDirWorld, targetDirWorld);
  _localRot.copy(_pWorldQInv).multiply(_rotFT);
  node.quaternion.copy(_localRot);
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Apply one pose frame using direct joint-direction matching.
 * Call AFTER applyMocapToVRM (which handles spine/head/expressions);
 * this function overrides only the arm and leg bones.
 *
 * @param vrm    Must have been passed to initJointMatchCache on load.
 * @param pose   Raw MediaPipe pose landmarks (33 points), or null.
 * @param mx     -1 for mirror/VTuber mode, +1 for non-mirror.
 * @param aspect Container width/height (same formula as SkeletonViewport).
 */
export function applyJointMatchToVRM(
  vrm: VRM,
  pose: NormalizedLandmark[] | null,
  mx: number,
  aspect: number,
): void {
  const dirs = restDirCache.get(vrm);
  if (!dirs) return; // initJointMatchCache not called yet

  if (!pose || pose.length < 29) {
    // Pose lost — ease limbs back to T-pose (identity = rest direction).
    for (const bone of [
      "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm",
      "leftUpperLeg",  "leftLowerLeg",  "rightUpperLeg",  "rightLowerLeg",
    ] as VRMHumanBoneName[]) {
      const n = vrm.humanoid.getNormalizedBoneNode(bone);
      if (n) n.quaternion.identity();
    }
    return;
  }

  // ── landmark index selection ──────────────────────────────────────────────
  // Mirror mode (mx<0): subject's RIGHT anatomical landmarks drive avatar's
  // LEFT bones (VTuber mirror convention — see module-level comment).
  const mir = mx < 0;

  // Arm landmark indices
  const iShL = mir ? 12 : 11; // shoulder → leftUpperArm
  const iElL = mir ? 14 : 13; // elbow
  const iWrL = mir ? 16 : 15; // wrist → leftLowerArm end

  const iShR = mir ? 11 : 12; // shoulder → rightUpperArm
  const iElR = mir ? 13 : 14;
  const iWrR = mir ? 15 : 16;

  // Leg landmark indices
  const iHpL = mir ? 24 : 23; // hip → leftUpperLeg
  const iKnL = mir ? 26 : 25; // knee → leftLowerLeg end
  const iAnL = mir ? 28 : 27; // ankle

  const iHpR = mir ? 23 : 24;
  const iKnR = mir ? 25 : 26;
  const iAnR = mir ? 27 : 28;

  // ── apply (parent before child so world matrices stay consistent) ─────────
  const apply = (bone: VRMHumanBoneName, restDir: THREE.Vector3, iA: number, iB: number) => {
    if (segDir(pose, iA, iB, mx, aspect, _tgt)) {
      setBoneDir(vrm, bone, restDir, _tgt);
    } else {
      const n = vrm.humanoid.getNormalizedBoneNode(bone);
      if (n) n.quaternion.identity();
    }
  };

  // Arms
  apply("leftUpperArm",  dirs.leftUpperArm,  iShL, iElL);
  apply("leftLowerArm",  dirs.leftLowerArm,  iElL, iWrL);
  apply("rightUpperArm", dirs.rightUpperArm, iShR, iElR);
  apply("rightLowerArm", dirs.rightLowerArm, iElR, iWrR);

  // Legs
  apply("leftUpperLeg",  dirs.leftUpperLeg,  iHpL, iKnL);
  apply("leftLowerLeg",  dirs.leftLowerLeg,  iKnL, iAnL);
  apply("rightUpperLeg", dirs.rightUpperLeg, iHpR, iKnR);
  apply("rightLowerLeg", dirs.rightLowerLeg, iKnR, iAnR);
}
