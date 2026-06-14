import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { lmToWorld } from "../mocap/landmarkUtils";

/**
 * Positional VRM retargeting: orient each VRM bone so its segment points in
 * the same direction as the corresponding mannequin segment in SkeletonViewport.
 *
 * ALGORITHM (per bone):
 *   1. Compute `targetDir` = normalize(childPos - parentPos) from raw landmarks
 *      using the same lmToWorld() coordinate mapping as SkeletonViewport.
 *   2. `worldQuat` = quaternionFromTo(restDir, targetDir)
 *      where `restDir` is the T-pose direction of the bone in VRM normalized
 *      world space (identity local rotation = T-pose, world-aligned axes).
 *   3. For child bones whose parent we also rotate, transform to local space:
 *      `localQuat = parentQuat.inverse() * worldQuat`
 *   4. Set `bone.quaternion = localQuat` (no additional Kalidokit layer).
 *
 * COORDINATE SYSTEM ALIGNMENT:
 *   SkeletonViewport world space (mirror=true, mx=-1):
 *     +X = subject's LEFT side (model's left)   +Y = up   +Z = toward camera
 *   VRM normalized bone world space (model faces +Z = viewer):
 *     +X = model's anatomical LEFT               +Y = up   +Z = toward viewer
 *   These are the same axes — no transform needed between skeleton and VRM worlds.
 *
 * T-POSE REST DIRECTIONS in VRM normalized bone world space:
 *   leftUpperArm / leftLowerArm   →  +X  (model's left = viewer's right)
 *   rightUpperArm / rightLowerArm →  -X
 *   all leg bones                 →  -Y  (straight down)
 *   (spine/neck/head not handled here — left to applyMocapToVRM)
 *
 * PARENT CHAIN: spine/chest/upperChest are NOT rotated by this retargeter.
 * Arm bones therefore inherit identity parent-chain rotation, so their local
 * quaternion equals their world quaternion. Lower arm/leg local rotations
 * are computed relative to the upper bone we just set.
 */

const MIN_VIS = 0.45;

// T-pose world-space bone directions for VRM normalized bones.
const REST: Partial<Record<VRMHumanBoneName, THREE.Vector3>> = {
  leftUpperArm:  new THREE.Vector3( 1, 0, 0),
  leftLowerArm:  new THREE.Vector3( 1, 0, 0),
  rightUpperArm: new THREE.Vector3(-1, 0, 0),
  rightLowerArm: new THREE.Vector3(-1, 0, 0),
  leftUpperLeg:  new THREE.Vector3( 0, -1, 0),
  leftLowerLeg:  new THREE.Vector3( 0, -1, 0),
  rightUpperLeg: new THREE.Vector3( 0, -1, 0),
  rightLowerLeg: new THREE.Vector3( 0, -1, 0),
};

// Module-level scratch objects (never used concurrently).
const _worldQ  = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _dir     = new THREE.Vector3();

/**
 * Factory: returns a stateful retargeter that holds the hold-last-good
 * landmark cache (same persistence logic as SkeletonViewport).
 */
export function createPositionalRetargeter() {
  // Last visible landmark per pose index (0-32).
  const lastLm: (NormalizedLandmark | null)[] = new Array(33).fill(null);

  /** Resolve a pose landmark with visibility-gated persistence. */
  function L(pose: NormalizedLandmark[], i: number): NormalizedLandmark | null {
    const lm = pose[i];
    if (lm && (lm.visibility ?? 1) >= MIN_VIS) { lastLm[i] = lm; return lm; }
    return lastLm[i] ?? null;
  }

  /** World position for a single pose landmark (persistence-aware). */
  function W(
    pose: NormalizedLandmark[],
    i: number,
    mx: number,
    asp: number,
  ): THREE.Vector3 | null {
    const lm = L(pose, i);
    return lm ? lmToWorld(lm, mx, asp) : null;
  }

  /** Midpoint of two pose landmarks (persistence-aware). */
  function M(
    pose: NormalizedLandmark[],
    a: number,
    b: number,
    mx: number,
    asp: number,
  ): THREE.Vector3 | null {
    const la = L(pose, a), lb = L(pose, b);
    if (!la || !lb) return null;
    return lmToWorld(la, mx, asp).add(lmToWorld(lb, mx, asp)).multiplyScalar(0.5);
  }

  /**
   * Orient one bone so its segment points from `from` toward `to`.
   *
   * @param parentBone - name of the bone directly above this one that we have
   *   already rotated in this frame; pass null if the parent chain is at
   *   T-pose (identity).  Used to convert the world-space delta rotation into
   *   the bone's local space.
   */
  function orientBone(
    vrm: VRM,
    boneName: VRMHumanBoneName,
    parentBone: VRMHumanBoneName | null,
    from: THREE.Vector3 | null,
    to: THREE.Vector3 | null,
  ): void {
    if (!from || !to) return;
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) return;
    const restDir = REST[boneName];
    if (!restDir) return;

    _dir.subVectors(to, from);
    if (_dir.length() < 1e-4) return;
    _dir.normalize();

    // World-space rotation: rotate the T-pose rest direction onto the target.
    _worldQ.setFromUnitVectors(restDir, _dir);

    // Convert to local space if the parent bone was already rotated this frame.
    if (parentBone) {
      const parentNode = vrm.humanoid.getNormalizedBoneNode(parentBone);
      if (parentNode) {
        _parentQ.copy(parentNode.quaternion).invert();
        _worldQ.premultiply(_parentQ); // localQ = parentQ.inv * worldQ
      }
    }

    node.quaternion.copy(_worldQ);
  }

  return {
    /**
     * Apply positional bone matching for one frame.
     *
     * @param vrm    - the live VRM instance
     * @param pose   - raw MediaPipe pose landmarks (image space, 33 points)
     * @param mx     - mirror factor: -1 when mirror=true, +1 otherwise
     * @param aspect - viewport width / height (matches SkeletonViewport)
     */
    apply(
      vrm: VRM,
      pose: NormalizedLandmark[] | null,
      mx: number,
      aspect: number,
    ): void {
      if (!pose || pose.length < 29) return;

      const shlL  = W(pose, 11, mx, aspect);
      const shlR  = W(pose, 12, mx, aspect);
      const elbL  = W(pose, 13, mx, aspect);
      const elbR  = W(pose, 14, mx, aspect);
      const wrstL = W(pose, 15, mx, aspect);
      const wrstR = W(pose, 16, mx, aspect);
      const hipL  = W(pose, 23, mx, aspect);
      const hipR  = W(pose, 24, mx, aspect);
      const kneeL = W(pose, 25, mx, aspect);
      const kneeR = W(pose, 26, mx, aspect);
      const ankL  = W(pose, 27, mx, aspect);
      const ankR  = W(pose, 28, mx, aspect);

      // ── arms (parent chain above shoulder is T-pose, so world = local)
      orientBone(vrm, "leftUpperArm",  null,            shlL, elbL);
      orientBone(vrm, "leftLowerArm",  "leftUpperArm",  elbL, wrstL);
      orientBone(vrm, "rightUpperArm", null,            shlR, elbR);
      orientBone(vrm, "rightLowerArm", "rightUpperArm", elbR, wrstR);

      // ── legs (hips bone is T-pose, so world = local)
      orientBone(vrm, "leftUpperLeg",  null,            hipL,  kneeL);
      orientBone(vrm, "leftLowerLeg",  "leftUpperLeg",  kneeL, ankL);
      orientBone(vrm, "rightUpperLeg", null,            hipR,  kneeR);
      orientBone(vrm, "rightLowerLeg", "rightUpperLeg", kneeR, ankR);

      // Log a one-shot diagnostic on the first frame pose is available.
      // Check with console: raise left arm straight out to the side → shlL and
      // elbL should have nearly equal Y with elbL.x > shlL.x (in mirror mode).
      // Expected leftUpperArm bone quaternion ≈ identity (arm already in T-pose direction).
      if (!this._logged && shlL && elbL) {
        const uaNode = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
        console.info(
          "[positional] first-frame diagnostic\n" +
          `  shlL  world: (${shlL.x.toFixed(3)}, ${shlL.y.toFixed(3)}, ${shlL.z.toFixed(3)})\n` +
          `  elbL  world: (${elbL.x.toFixed(3)}, ${elbL.y.toFixed(3)}, ${elbL.z.toFixed(3)})\n` +
          `  leftUpperArm quat: (${uaNode?.quaternion.x.toFixed(3)}, ${uaNode?.quaternion.y.toFixed(3)}, ` +
          `${uaNode?.quaternion.z.toFixed(3)}, ${uaNode?.quaternion.w.toFixed(3)})`,
        );
        this._logged = true;
      }
    },

    _logged: false,

    reset(): void {
      lastLm.fill(null);
      this._logged = false;
    },
  };
}

export type PositionalRetargeter = ReturnType<typeof createPositionalRetargeter>;
