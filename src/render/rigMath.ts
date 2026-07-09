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
 * Picks `preferredChild` if it's actually one of `bone`'s children, else
 * falls back to the first Bone child. Some rigs (VRoid/VRM exports
 * especially) put secondary/spring bones — skirt or bust jiggle physics
 * joints — as EARLIER children than the real skeletal continuation (e.g.
 * UpperChest's children can be [bustL, bustR, Neck, ...]), so "first Bone
 * child" alone silently picks a physics bone instead of the actual next
 * joint. Callers that know the semantically correct next bone
 * (vrmRigAdapter.ts, via each humanoid bone's known chain child) should pass
 * it as `preferredChild`; the resolved bone should be stored on the
 * VtubeRigEntry (`childBone`) so later re-derivations (rigDiagnostics.ts)
 * reuse the same correct reference instead of re-guessing.
 */
export function resolveChainChild(bone: THREE.Bone, preferredChild?: THREE.Bone | null): THREE.Bone | undefined {
  if (preferredChild && bone.children.includes(preferredChild)) return preferredChild;
  return bone.children.find((c): c is THREE.Bone => c instanceof THREE.Bone);
}

/**
 * World-space direction (as a bone-LOCAL unit vector, matching VtubeRigEntry.restDir)
 * from a bone to its child bone, plus the world-space distance between them.
 * Requires the scene's matrixWorld to already be up to date. Returns length 0 /
 * a zero-ish dir if the bone has no child bone (leaf bones carry no useful rest dir).
 * See resolveChainChild() for what `preferredChild` is for.
 */
export function computeRestDirLength(
  bone: THREE.Bone,
  preferredChild?: THREE.Bone | null,
): { dir: THREE.Vector3; length: number } {
  const childBone = resolveChainChild(bone, preferredChild);
  if (childBone) {
    const boneWPos = bone.getWorldPosition(new THREE.Vector3());
    const childWPos = childBone.getWorldPosition(new THREE.Vector3());
    const length = boneWPos.distanceTo(childWPos);
    if (length >= 1e-6) {
      const worldDir = childWPos.clone().sub(boneWPos).normalize();
      const worldQ = bone.getWorldQuaternion(new THREE.Quaternion());
      const localDir = worldDir.applyQuaternion(worldQ.invert());
      return { dir: localDir, length };
    }
  }
  // Leaf bone (no child at all — e.g. a VRM Distal finger phalanx, always a
  // leaf per the humanoid spec) — (0,1,0) would be an arbitrary, almost
  // certainly wrong reference (there's no reason a fingertip's bind-pose
  // local axis happens to align with world-up). Approximate instead using
  // the direction from THIS bone's PARENT to this bone — i.e. "assume the
  // tip continues straight on from the previous segment", true enough at a
  // typical relaxed-hand bind pose to give a sane reference, unlike a fixed
  // constant.
  const parent = bone.parent;
  if (parent instanceof THREE.Bone) {
    const parentWPos = parent.getWorldPosition(new THREE.Vector3());
    const boneWPos = bone.getWorldPosition(new THREE.Vector3());
    const length = parentWPos.distanceTo(boneWPos);
    if (length >= 1e-6) {
      const worldDir = boneWPos.clone().sub(parentWPos).normalize();
      const worldQ = bone.getWorldQuaternion(new THREE.Quaternion());
      const localDir = worldDir.applyQuaternion(worldQ.invert());
      return { dir: localDir, length };
    }
  }
  return { dir: new THREE.Vector3(0, 1, 0), length: 0 };
}
