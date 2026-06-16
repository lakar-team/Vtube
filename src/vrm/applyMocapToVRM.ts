import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  FINGER_SEGMENTS,
  type FingerSegment,
  type HandRotations,
  type EulerRotation,
  type MocapFrame,
} from "../mocap/types";
import type { ExpressionMapping } from "./expressionMap";

/**
 * Face-tracking application layer: mocap face data -> three-vrm humanoid.
 *
 * Only head/neck rotation, eye gaze, and expressions are driven. Body bones
 * remain in rest pose — the 3D room mannequin (RoomViewport) handles
 * full-body mocap visualization.
 *
 * COORDINATE QUIRK (VRM 0.x vs 1.0):
 * The normalized rig's axes are world-aligned in the model's AUTHORED
 * orientation. VRM 0.x models are authored facing the opposite direction to
 * VRM 1.0 models — `VRMUtils.rotateVRM0()` compensates by spinning
 * `vrm.scene` 180°, but that's a parent transform and does NOT change what
 * a local bone rotation means. Kalidokit's euler conventions come from its
 * original VRM0 demos, so:
 *   - VRM 0.x model: apply rotations as-is        (signs 1, 1, 1)
 *   - VRM 1.0 model: conjugate by the 180° flip — negate x/z (signs -1, 1, -1)
 */
export interface RotationSigns {
  x: 1 | -1;
  y: 1 | -1;
  z: 1 | -1;
}

const VRM0_SIGNS: RotationSigns = { x: 1, y: 1, z: 1 };
const VRM1_SIGNS: RotationSigns = { x: -1, y: 1, z: -1 };

const signsCache = new WeakMap<VRM, RotationSigns>();

export function getRotationSigns(vrm: VRM): RotationSigns {
  let signs = signsCache.get(vrm);
  if (!signs) {
    signs = vrm.meta?.metaVersion === "0" ? VRM0_SIGNS : VRM1_SIGNS;
    signsCache.set(vrm, signs);
  }
  return signs;
}

/** How much of the solved head rotation goes to head vs neck bone. */
export const HEAD_NECK_SPLIT = 0.65;

/** How far (in meters, at ~1 m) the gaze target swings per unit of pupil. */
export const GAZE_SWING = { x: 0.6, y: 0.35 } as const;

// Scratch objects (avoid per-frame allocation).
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

function rotateBone(
  vrm: VRM,
  signs: RotationSigns,
  bone: VRMHumanBoneName,
  rot: EulerRotation,
  scale = 1,
): void {
  const node = vrm.humanoid.getNormalizedBoneNode(bone);
  if (!node) return;
  _euler.set(
    rot.x * scale * signs.x,
    rot.y * scale * signs.y,
    rot.z * scale * signs.z,
    "XYZ",
  );
  _quat.setFromEuler(_euler);
  node.quaternion.copy(_quat);
}

/**
 * Apply one smoothed mocap frame to the VRM (face channels only).
 * Call once per render frame, BEFORE `vrm.update(delta)`.
 *
 * @param lookAtTarget an Object3D parented to the camera; the VRM's lookAt
 *   target. We move it around to drive eye gaze.
 */
export function applyMocapToVRM(
  vrm: VRM,
  frame: MocapFrame,
  lookAtTarget: THREE.Object3D | null,
  expressionMap?: ExpressionMapping,
): void {
  const signs = getRotationSigns(vrm);

  // ---- head / neck (face solve)
  if (frame.faceTracked) {
    rotateBone(vrm, signs, "head", frame.head, HEAD_NECK_SPLIT);
    rotateBone(vrm, signs, "neck", frame.head, 1 - HEAD_NECK_SPLIT);
  }

  // ---- expressions (blink, vowels, full ARKit blendshapes if supported)
  const em = vrm.expressionManager;
  if (em && frame.faceTracked && expressionMap) {
    for (const [channel, vrmName] of expressionMap.map) {
      em.setValue(vrmName, frame.expressions[channel]);
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

/** VRM finger bone name for a side + segment, e.g. ("left","indexProximal") →
 *  "leftIndexProximal". */
function fingerBone(side: "left" | "right", seg: FingerSegment): VRMHumanBoneName {
  return `${side}${seg[0].toUpperCase()}${seg.slice(1)}` as VRMHumanBoneName;
}

function applyHandBones(
  vrm: VRM, signs: RotationSigns, side: "left" | "right", rots: HandRotations | null,
): void {
  if (!rots) return;
  for (const seg of FINGER_SEGMENTS) {
    const r = rots[seg];
    if (r) rotateBone(vrm, signs, fingerBone(side, seg), r);
  }
}

/**
 * Drive the VRM's BODY bones (spine/arms/legs/hands) from the solved mocap
 * frame — the same poseWorld-derived solve that drives the 3D-room mannequin.
 * Each tracked limb's solved rotation is written to the matching humanoid bone,
 * so the VRM's limb directions follow the skeleton. Call after the face apply
 * and before vrm.update(). Untracked limbs are left in rest pose.
 */
export function applyBodyMocapToVRM(vrm: VRM, frame: MocapFrame): void {
  const signs = getRotationSigns(vrm);

  rotateBone(vrm, signs, "spine", frame.spine, 0.5);
  rotateBone(vrm, signs, "chest", frame.spine, 0.5);

  if (frame.armsTracked.left) {
    rotateBone(vrm, signs, "leftUpperArm", frame.arms.leftUpperArm);
    rotateBone(vrm, signs, "leftLowerArm", frame.arms.leftLowerArm);
  }
  if (frame.armsTracked.right) {
    rotateBone(vrm, signs, "rightUpperArm", frame.arms.rightUpperArm);
    rotateBone(vrm, signs, "rightLowerArm", frame.arms.rightLowerArm);
  }

  if (frame.legsTracked) {
    rotateBone(vrm, signs, "leftUpperLeg", frame.legs.leftUpperLeg);
    rotateBone(vrm, signs, "leftLowerLeg", frame.legs.leftLowerLeg);
    rotateBone(vrm, signs, "rightUpperLeg", frame.legs.rightUpperLeg);
    rotateBone(vrm, signs, "rightLowerLeg", frame.legs.rightLowerLeg);
  }

  if (frame.hands.leftWrist) rotateBone(vrm, signs, "leftHand", frame.hands.leftWrist);
  if (frame.hands.rightWrist) rotateBone(vrm, signs, "rightHand", frame.hands.rightWrist);
  applyHandBones(vrm, signs, "left", frame.hands.left);
  applyHandBones(vrm, signs, "right", frame.hands.right);
}
