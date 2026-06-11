import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  EXPRESSION_KEYS,
  type EulerRotation,
  type MocapFrame,
} from "../mocap/types";

/**
 * Rig mapping layer: smoothed Kalidokit output -> three-vrm humanoid.
 *
 * We drive the NORMALIZED humanoid bones (`getNormalizedBoneNode`), which
 * three-vrm exposes in a version-independent, rest-pose-identity space.
 * Combined with `VRMUtils.rotateVRM0()` at load time, the SAME mapping works
 * for VRM 0.x and VRM 1.0 models.
 *
 * COORDINATE QUIRK: Kalidokit's euler conventions come from its original
 * three-vrm 0.x + raw VRM0-bone demos. Mapping that onto the normalized
 * (VRM1-space) rig is a 180° flip about Y, which negates the X and Z
 * components of every rotation — hence ROTATION_SIGNS below. If your model
 * pitches/rolls the wrong way (it shouldn't, but conventions have shifted
 * across library versions), flip the corresponding sign here and restart.
 */
export const ROTATION_SIGNS = { x: -1, y: 1, z: -1 } as const;

/** Per-frame slerp factors (final response feel; One Euro already smoothed). */
export const RIG_LERP = {
  head: 0.7,
  body: 0.5,
  armRelaxReturn: 0.07, // ease-back speed when pose tracking drops out
} as const;

/** How much of the solved head rotation goes to head vs neck bone. */
export const HEAD_NECK_SPLIT = 0.65;

/** Damp spine motion — webcam torso estimates are coarse. */
export const SPINE_DAMP = 0.4;

/** How far (in meters, at ~1 m) the gaze target swings per unit of pupil. */
export const GAZE_SWING = { x: 0.6, y: 0.35 } as const;

/**
 * Relaxed arm pose used when pose tracking is unavailable: arms down at the
 * sides instead of the T-pose. Angles are in normalized VRM bone space.
 * (Left arm points +X in rest pose; rotating about Z by -70° drops it down.)
 */
const RELAXED_POSE: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {
  leftUpperArm: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -1.2)),
  rightUpperArm: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 1.2)),
  leftLowerArm: new THREE.Quaternion(),
  rightLowerArm: new THREE.Quaternion(),
};

// Scratch objects (avoid per-frame allocation).
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

function rotateBone(
  vrm: VRM,
  bone: VRMHumanBoneName,
  rot: EulerRotation,
  lerp: number,
  scale = 1,
): void {
  const node = vrm.humanoid.getNormalizedBoneNode(bone);
  if (!node) return;
  _euler.set(
    rot.x * scale * ROTATION_SIGNS.x,
    rot.y * scale * ROTATION_SIGNS.y,
    rot.z * scale * ROTATION_SIGNS.z,
    "XYZ",
  );
  _quat.setFromEuler(_euler);
  node.quaternion.slerp(_quat, lerp);
}

function easeToward(
  vrm: VRM,
  bone: VRMHumanBoneName,
  target: THREE.Quaternion,
  lerp: number,
): void {
  const node = vrm.humanoid.getNormalizedBoneNode(bone);
  if (!node) return;
  node.quaternion.slerp(target, lerp);
}

/**
 * Apply one smoothed mocap frame to the VRM.
 * Call once per render frame, BEFORE `vrm.update(delta)`.
 *
 * @param lookAtTarget an Object3D parented to the camera; the VRM's lookAt
 *   target. We move it around to drive eye gaze.
 */
export function applyMocapToVRM(
  vrm: VRM,
  frame: MocapFrame,
  lookAtTarget: THREE.Object3D | null,
): void {
  // ---- head / neck (face solve)
  if (frame.faceTracked) {
    rotateBone(vrm, "head", frame.head, RIG_LERP.head, HEAD_NECK_SPLIT);
    rotateBone(vrm, "neck", frame.head, RIG_LERP.head, 1 - HEAD_NECK_SPLIT);
  }

  // ---- torso + arms (pose solve)
  if (frame.poseTracked) {
    rotateBone(vrm, "spine", frame.spine, RIG_LERP.body, SPINE_DAMP);
    rotateBone(vrm, "leftUpperArm", frame.arms.leftUpperArm, RIG_LERP.body);
    rotateBone(vrm, "leftLowerArm", frame.arms.leftLowerArm, RIG_LERP.body);
    rotateBone(vrm, "rightUpperArm", frame.arms.rightUpperArm, RIG_LERP.body);
    rotateBone(vrm, "rightLowerArm", frame.arms.rightLowerArm, RIG_LERP.body);
  } else {
    // No pose: ease the arms down to a natural resting pose.
    for (const [bone, q] of Object.entries(RELAXED_POSE)) {
      easeToward(vrm, bone as VRMHumanBoneName, q, RIG_LERP.armRelaxReturn);
    }
  }

  // ---- expressions (blink, vowels)
  const em = vrm.expressionManager;
  if (em && frame.faceTracked) {
    for (const key of EXPRESSION_KEYS) {
      em.setValue(key, frame.expressions[key]);
    }
  }

  // ---- eye gaze via lookAt target
  if (lookAtTarget && frame.faceTracked) {
    lookAtTarget.position.set(
      frame.pupil.x * GAZE_SWING.x,
      frame.pupil.y * GAZE_SWING.y,
      0,
    );
  }
}
