import * as THREE from 'three';

/**
 * Shared rig-math utilities for the diagnostics/calibration pipeline
 * (rigDiagnostics.ts) and the VRM adapter (vrmRigAdapter.ts). Ported from
 * AI-CAD's src/character/boneDetection.js so both sides of the vtubeRig
 * pipeline agree on what "rest direction" and "opposite side" mean.
 */

/** Swap a canonical joint name's trailing L/R side suffix (e.g. "shL" -> "shR"). */
export function flipJointSide(joint: string): string {
  if (!joint) return joint;
  if (joint.endsWith('L')) return joint.slice(0, -1) + 'R';
  if (joint.endsWith('R')) return joint.slice(0, -1) + 'L';
  return joint;
}

/**
 * World-space direction (as a bone-LOCAL unit vector, matching VtubeRigEntry.restDir)
 * from a bone to its first child bone, plus the world-space distance between them.
 * Requires the scene's matrixWorld to already be up to date. Returns length 0 /
 * a zero-ish dir if the bone has no child bone (leaf bones carry no useful rest dir).
 */
export function computeRestDirLength(bone: THREE.Bone): { dir: THREE.Vector3; length: number } {
  const childBone = bone.children.find((c): c is THREE.Bone => c instanceof THREE.Bone);
  if (!childBone) return { dir: new THREE.Vector3(0, 1, 0), length: 0 };

  const boneWPos = bone.getWorldPosition(new THREE.Vector3());
  const childWPos = childBone.getWorldPosition(new THREE.Vector3());
  const length = boneWPos.distanceTo(childWPos);
  if (length < 1e-6) return { dir: new THREE.Vector3(0, 1, 0), length: 0 };

  const worldDir = childWPos.clone().sub(boneWPos).normalize();
  const worldQ = bone.getWorldQuaternion(new THREE.Quaternion());
  const localDir = worldDir.applyQuaternion(worldQ.invert());
  return { dir: localDir, length };
}
