import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  type EulerRotation,
  type MocapFrame,
} from "../mocap/types";
import type { ExpressionMapping } from "./expressionMap";

/**
 * Face-tracking application layer: mocap face data -> three-vrm humanoid.
 *
 * Only head/neck rotation, eye gaze, and expressions are driven. Body bones
 * remain in rest pose — the skeleton mannequin (SkeletonViewport) handles
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
