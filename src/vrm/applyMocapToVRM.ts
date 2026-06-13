import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  ARM_KEYS,
  FINGER_SEGMENTS,
  type EulerRotation,
  type HandRotations,
  type MocapFrame,
} from "../mocap/types";
import type { CalibrationPoseDef } from "../mocap/calibration";
import type { ExpressionMapping } from "./expressionMap";

/**
 * Rig mapping layer: smoothed Kalidokit output -> three-vrm humanoid.
 *
 * We drive the NORMALIZED humanoid bones (`getNormalizedBoneNode`), which
 * three-vrm exposes in a rest-pose-identity space with world-aligned axes.
 *
 * COORDINATE QUIRK (this is the fix for "the avatar moves opposite to me"):
 * the normalized rig's axes are world-aligned in the model's AUTHORED
 * orientation. VRM 0.x models are authored facing the opposite direction to
 * VRM 1.0 models — `VRMUtils.rotateVRM0()` compensates by spinning
 * `vrm.scene` 180°, but that's a parent transform; it does NOT change what a
 * local bone rotation means. Kalidokit's euler conventions come from its
 * original demos that drove raw VRM0 bones, so:
 *   - VRM 0.x model: apply Kalidokit rotations as-is        (signs 1, 1, 1)
 *   - VRM 1.0 model: conjugate by the 180° flip — negate x/z (signs -1, 1, -1)
 * Using one hardcoded sign set inverts pitch/roll (arms swing down when you
 * raise them) on models of the other version.
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

/** Per-frame slerp factors (final response feel; One Euro already smoothed). */
export const RIG_LERP = {
  head: 0.7,
  body: 0.5,
  hips: 0.4,
  legs: 0.5,
  wrist: 0.55,
  armRelaxReturn: 0.07, // ease-back speed when pose tracking drops out
  legRelaxReturn: 0.08, // ease-back speed when legs drop out of frame
  fingers: 0.6,
  fingerRelaxReturn: 0.1, // ease-back speed when a hand drops out of frame
} as const;

/** How much of the solved head rotation goes to head vs neck bone. */
export const HEAD_NECK_SPLIT = 0.65;

/** Damp spine yaw/roll — webcam shoulder-line estimates are coarse. */
export const SPINE_DAMP = 0.4;

/**
 * Torso pitch (bowing) is solved geometrically from the hip->shoulder vector
 * (see kalidokitAdapter) and is much steadier than yaw/roll, so it passes
 * through nearly whole — a real bow should read as a bow.
 */
export const SPINE_PITCH_DAMP = 0.85;

/**
 * The solved torso rotation is distributed up the spine chain so a bow bends
 * the whole upper body instead of hinging at a single joint. Weights sum to
 * 1 and are renormalized over the bones this model actually has (chest and
 * upperChest are optional in the VRM humanoid spec).
 */
export const SPINE_CHAIN: ReadonlyArray<readonly [VRMHumanBoneName, number]> = [
  ["spine", 0.45],
  ["chest", 0.35],
  ["upperChest", 0.2],
];

/** Damp hip rotation — same reasoning as the spine. */
export const HIPS_ROT_DAMP = 0.6;

/**
 * Meters of hip translation per unit of solver position offset.
 * The solver units are rough (image-space fractions / spine-length deltas),
 * so these are tuned for plausible sway/crouch/step motion, not metric
 * accuracy. z is the depth proxy — see kalidokitAdapter / calibration.
 */
export const HIPS_POS_SCALE = { x: 0.6, y: 0.8, z: 0.7 } as const;

/** Clamp hip translation (meters) so a bad solve can't fling the avatar. */
export const HIPS_POS_LIMIT = { x: 0.5, y: 0.6, z: 0.6 } as const;

/** How far (in meters, at ~1 m) the gaze target swings per unit of pupil. */
export const GAZE_SWING = { x: 0.6, y: 0.35 } as const;

/**
 * Relaxed upper-arm drop used when an arm (or the whole pose) is untracked:
 * arms down at the sides instead of the T-pose. The angle is in Kalidokit
 * convention (left arm drops with +z there) and goes through the same
 * per-model sign mapping as live tracking. Lower arm relaxes to identity.
 */
const RELAXED_UPPER_ARM_Z = { left: 1.2, right: -1.2 } as const;

const LEG_BONES: VRMHumanBoneName[] = [
  "leftUpperLeg",
  "leftLowerLeg",
  "rightUpperLeg",
  "rightLowerLeg",
];

// Scratch objects (avoid per-frame allocation).
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _identityQuat = new THREE.Quaternion();
const _vec3 = new THREE.Vector3();
const _spineRot: EulerRotation = { x: 0, y: 0, z: 0 };

/** Rest-pose local position of the normalized hips node, cached per model. */
const restHipsPosCache = new WeakMap<VRM, THREE.Vector3>();

function rotateBone(
  vrm: VRM,
  signs: RotationSigns,
  bone: VRMHumanBoneName,
  rot: EulerRotation,
  lerp: number,
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
  node.quaternion.slerp(_quat, lerp);
}

function easeBoneToward(
  vrm: VRM,
  bone: VRMHumanBoneName,
  target: THREE.Quaternion,
  lerp: number,
): void {
  const node = vrm.humanoid.getNormalizedBoneNode(bone);
  if (!node) return;
  node.quaternion.slerp(target, lerp);
}

/** Ease one arm toward the relaxed at-the-side pose. */
function relaxArm(
  vrm: VRM,
  signs: RotationSigns,
  side: "left" | "right",
  lerp: number,
): void {
  _euler.set(0, 0, RELAXED_UPPER_ARM_Z[side] * signs.z, "XYZ");
  _quat.setFromEuler(_euler);
  easeBoneToward(vrm, `${side}UpperArm` as VRMHumanBoneName, _quat, lerp);
  easeBoneToward(vrm, `${side}LowerArm` as VRMHumanBoneName, _identityQuat, lerp);
}

/**
 * Apply one hand's solved finger rotations to the VRM's finger bones.
 * Bone names are `${side}${SegmentPascalCase}`, e.g. "leftThumbMetacarpal",
 * "rightIndexIntermediate" — part of the VRM humanoid spec, so this works on
 * any VRM-compliant rig that has finger bones. Bones the model doesn't have
 * (`getNormalizedBoneNode` returns null) are silently skipped.
 */
function applyHand(
  vrm: VRM,
  signs: RotationSigns,
  side: "left" | "right",
  hand: HandRotations | null,
  wrist: EulerRotation | null,
): void {
  for (const segment of FINGER_SEGMENTS) {
    const boneName = (side + segment[0].toUpperCase() + segment.slice(1)) as VRMHumanBoneName;
    const rot = hand?.[segment];
    if (rot) {
      rotateBone(vrm, signs, boneName, rot, RIG_LERP.fingers);
    } else {
      // Hand not tracked / segment not solved: ease back to the rest pose
      // (identity in normalized bone space) instead of freezing.
      easeBoneToward(vrm, boneName, _identityQuat, RIG_LERP.fingerRelaxReturn);
    }
  }

  const wristBone = (side + "Hand") as VRMHumanBoneName;
  if (wrist) {
    rotateBone(vrm, signs, wristBone, wrist, RIG_LERP.wrist);
  } else {
    easeBoneToward(vrm, wristBone, _identityQuat, RIG_LERP.fingerRelaxReturn);
  }
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
  expressionMap?: ExpressionMapping,
): void {
  const signs = getRotationSigns(vrm);

  // ---- head / neck (face solve)
  if (frame.faceTracked) {
    rotateBone(vrm, signs, "head", frame.head, RIG_LERP.head, HEAD_NECK_SPLIT);
    rotateBone(vrm, signs, "neck", frame.head, RIG_LERP.head, 1 - HEAD_NECK_SPLIT);
  }

  // ---- torso + arms (pose solve)
  if (frame.poseTracked) {
    _spineRot.x = frame.spine.x * SPINE_PITCH_DAMP;
    _spineRot.y = frame.spine.y * SPINE_DAMP;
    _spineRot.z = frame.spine.z * SPINE_DAMP;
    let chainWeight = 0;
    for (const [bone, weight] of SPINE_CHAIN) {
      if (vrm.humanoid.getNormalizedBoneNode(bone)) chainWeight += weight;
    }
    for (const [bone, weight] of SPINE_CHAIN) {
      rotateBone(vrm, signs, bone, _spineRot, RIG_LERP.body, weight / (chainWeight || 1));
    }
    rotateBone(vrm, signs, "hips", frame.hips.rotation, RIG_LERP.hips, HIPS_ROT_DAMP);
    // Arms gate individually: a hand shoved at the lens occludes its own arm
    // and MediaPipe hallucinates the hidden joints — that side eases to the
    // relaxed pose while the visible arm keeps tracking.
    if (frame.armsTracked.left) {
      rotateBone(vrm, signs, "leftUpperArm", frame.arms.leftUpperArm, RIG_LERP.body);
      rotateBone(vrm, signs, "leftLowerArm", frame.arms.leftLowerArm, RIG_LERP.body);
    } else {
      relaxArm(vrm, signs, "left", RIG_LERP.armRelaxReturn);
    }
    if (frame.armsTracked.right) {
      rotateBone(vrm, signs, "rightUpperArm", frame.arms.rightUpperArm, RIG_LERP.body);
      rotateBone(vrm, signs, "rightLowerArm", frame.arms.rightLowerArm, RIG_LERP.body);
    } else {
      relaxArm(vrm, signs, "right", RIG_LERP.armRelaxReturn);
    }
  } else {
    // No pose: ease the arms down to a natural resting pose and straighten
    // the torso instead of freezing mid-bend.
    relaxArm(vrm, signs, "left", RIG_LERP.armRelaxReturn);
    relaxArm(vrm, signs, "right", RIG_LERP.armRelaxReturn);
    for (const [bone] of SPINE_CHAIN) {
      easeBoneToward(vrm, bone, _identityQuat, RIG_LERP.armRelaxReturn);
    }
  }

  // ---- legs (pose solve, gated on lower-body visibility)
  if (frame.legsTracked) {
    rotateBone(vrm, signs, "leftUpperLeg", frame.legs.leftUpperLeg, RIG_LERP.legs);
    rotateBone(vrm, signs, "leftLowerLeg", frame.legs.leftLowerLeg, RIG_LERP.legs);
    rotateBone(vrm, signs, "rightUpperLeg", frame.legs.rightUpperLeg, RIG_LERP.legs);
    rotateBone(vrm, signs, "rightLowerLeg", frame.legs.rightLowerLeg, RIG_LERP.legs);
  } else {
    // Legs out of frame / disabled: ease back to standing (identity).
    for (const bone of LEG_BONES) {
      easeBoneToward(vrm, bone, _identityQuat, RIG_LERP.legRelaxReturn);
    }
  }

  // ---- hip translation (sway / crouch / step; depth via the z proxy)
  // frame.hips.position is zero unless body calibration captured a reference
  // standing position (see calibration.ts), so uncalibrated users keep the
  // avatar planted at the origin.
  {
    const node = vrm.humanoid.getNormalizedBoneNode("hips");
    if (node) {
      let rest = restHipsPosCache.get(vrm);
      if (!rest) {
        // First frame: the node still holds its rest-pose local position.
        rest = node.position.clone();
        restHipsPosCache.set(vrm, rest);
      }
      const p = frame.hips.position;
      const clampAbs = (v: number, lim: number) => (v < -lim ? -lim : v > lim ? lim : v);
      // Positions don't conjugate like rotations under the VRM0/VRM1 180°
      // flip: the solver's lateral x is mirror-frame (flips with the model's
      // authored facing, same as rotation x), but its depth z is
      // camera-relative ("toward the viewer"), so the model-local z sign is
      // the OPPOSITE of the rotation z sign. y (up) is version-independent.
      _vec3.set(
        rest.x + clampAbs(p.x * HIPS_POS_SCALE.x, HIPS_POS_LIMIT.x) * signs.x,
        rest.y + clampAbs(p.y * HIPS_POS_SCALE.y, HIPS_POS_LIMIT.y),
        rest.z + clampAbs(p.z * HIPS_POS_SCALE.z, HIPS_POS_LIMIT.z) * -signs.z,
      );
      node.position.lerp(_vec3, RIG_LERP.hips);
    }
  }

  // ---- expressions (blink, vowels, full ARKit blendshapes if supported)
  const em = vrm.expressionManager;
  if (em && frame.faceTracked && expressionMap) {
    for (const [channel, vrmName] of expressionMap.map) {
      em.setValue(vrmName, frame.expressions[channel]);
    }
  }

  // ---- fingers + wrists (hand solve)
  applyHand(vrm, signs, "left", frame.hands.left, frame.hands.leftWrist);
  applyHand(vrm, signs, "right", frame.hands.right, frame.hands.rightWrist);

  // ---- eye gaze via lookAt target
  if (lookAtTarget && frame.faceTracked) {
    lookAtTarget.position.set(
      frame.pupil.x * GAZE_SWING.x,
      frame.pupil.y * GAZE_SWING.y,
      0,
    );
  }
}

/** Ease-in speed for calibration demo poses (smooth glide, not a snap). */
const DEMO_LERP = 0.12;

/**
 * Drive the VRM into a calibration demo pose instead of live mocap: during
 * the body-calibration sequence the AVATAR demonstrates each target pose on
 * screen and the user copies it. The pose is defined in the same rig-input
 * space as live mocap rotations and goes through the identical
 * rotateBone/sign path, so whatever the model's VRM version, the demo
 * renders exactly the pose live tracking would produce for those values.
 * Everything not specified by the pose eases to rest.
 */
export function applyDemoPoseToVRM(vrm: VRM, pose: CalibrationPoseDef): void {
  const signs = getRotationSigns(vrm);

  // Head/neck and hips rest.
  easeBoneToward(vrm, "head", _identityQuat, DEMO_LERP);
  easeBoneToward(vrm, "neck", _identityQuat, DEMO_LERP);
  easeBoneToward(vrm, "hips", _identityQuat, DEMO_LERP);

  // Torso: distribute the demo pitch up the spine chain like live tracking
  // (same weights, same SPINE_PITCH_DAMP) so the user copies exactly what a
  // real bow of that magnitude looks like.
  _spineRot.x = pose.demo.spine.x * SPINE_PITCH_DAMP;
  _spineRot.y = pose.demo.spine.y * SPINE_DAMP;
  _spineRot.z = pose.demo.spine.z * SPINE_DAMP;
  let chainWeight = 0;
  for (const [bone, weight] of SPINE_CHAIN) {
    if (vrm.humanoid.getNormalizedBoneNode(bone)) chainWeight += weight;
  }
  for (const [bone, weight] of SPINE_CHAIN) {
    rotateBone(vrm, signs, bone, _spineRot, DEMO_LERP, weight / (chainWeight || 1));
  }

  // Arms.
  for (const k of ARM_KEYS) {
    rotateBone(vrm, signs, k, pose.demo.arms[k], DEMO_LERP);
  }

  // Legs, wrists, fingers rest.
  for (const bone of LEG_BONES) {
    easeBoneToward(vrm, bone, _identityQuat, DEMO_LERP);
  }
  for (const side of ["left", "right"] as const) {
    easeBoneToward(vrm, `${side}Hand` as VRMHumanBoneName, _identityQuat, DEMO_LERP);
    for (const segment of FINGER_SEGMENTS) {
      const boneName = (side +
        segment[0].toUpperCase() +
        segment.slice(1)) as VRMHumanBoneName;
      easeBoneToward(vrm, boneName, _identityQuat, DEMO_LERP);
    }
  }
}
