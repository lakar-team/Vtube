import * as THREE from 'three';

// Convert a single MediaPipe world landmark (Y-down, hip-origin, meters) to Three.js (Y-up)
// mx: -1 for mirror mode, +1 for non-mirror
export function lmToWorld(lm: {x:number,y:number,z:number}, mx: number): THREE.Vector3 {
  return new THREE.Vector3(mx * lm.x, -lm.y, -lm.z);
}

// Convert a face landmark (normalized image space) to Three.js, centered and scaled
export function lmFaceCentered(
  lm: {x:number,y:number,z:number},
  cx: number, cy: number, cz: number,
  mx: number, fScale: number
): THREE.Vector3 {
  return new THREE.Vector3(mx * (lm.x - cx) * fScale, -(lm.y - cy) * fScale, -(lm.z - cz) * fScale);
}

// Direction vector between two hand landmarks (image space deltas → Three.js direction)
export function lmHandDir(
  lmA: {x:number,y:number,z:number},
  lmB: {x:number,y:number,z:number},
  mx: number
): THREE.Vector3 {
  return new THREE.Vector3(mx*(lmB.x-lmA.x), -(lmB.y-lmA.y), -(lmB.z-lmA.z)).normalize();
}

// Canonical named joint positions for one frame — all in Three.js world space
export interface CanonicalPose {
  hipMid: THREE.Vector3;
  hipL: THREE.Vector3;   hipR: THREE.Vector3;
  shMid: THREE.Vector3;
  shL: THREE.Vector3;    shR: THREE.Vector3;
  elL: THREE.Vector3;    elR: THREE.Vector3;
  wrL: THREE.Vector3;    wrR: THREE.Vector3;
  knL: THREE.Vector3;    knR: THREE.Vector3;
  anL: THREE.Vector3;    anR: THREE.Vector3;
  toeL: THREE.Vector3;   toeR: THREE.Vector3;
  headC: THREE.Vector3;
  noseC: THREE.Vector3;
  earL: THREE.Vector3;   earR: THREE.Vector3;
}

// Build the canonical pose from raw poseWorld landmarks and mirror flag
// poseWorld: array of {x,y,z} landmarks (MediaPipe world space, hip-origin, Y-down)
// Returns all named joint positions in Three.js world space
export function buildCanonicalPose(poseWorld: {x:number,y:number,z:number}[], mx: number): CanonicalPose {
  const lm = (i: number) => lmToWorld(poseWorld[i], mx);
  const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
  const hipL = lm(23), hipR = lm(24);
  const shL = lm(11), shR = lm(12);
  return {
    hipMid: mid(hipL, hipR), hipL, hipR,
    shMid: mid(shL, shR), shL, shR,
    elL: lm(13), elR: lm(14),
    wrL: lm(15), wrR: lm(16),
    knL: lm(25), knR: lm(26),
    anL: lm(27), anR: lm(28),
    toeL: lm(31), toeR: lm(32),
    headC: mid(lm(7), lm(8)),
    noseC: lm(0),
    earL: lm(7), earR: lm(8),
  };
}

// Convert a target world direction to a bone's local quaternion
// Use this for ALL SkinnedMesh bone driving — never apply world quaternions directly
export function worldDirToBoneLocal(
  targetWorldDir: THREE.Vector3,
  bone: THREE.Bone,
  restLocalDir: THREE.Vector3 = new THREE.Vector3(0, 1, 0)
): THREE.Quaternion {
  const parentWorldQ = new THREE.Quaternion();
  if (bone.parent) (bone.parent as THREE.Object3D).getWorldQuaternion(parentWorldQ);
  const localDir = targetWorldDir.clone().applyQuaternion(parentWorldQ.clone().invert()).normalize();
  if (localDir.lengthSq() < 0.0001) return bone.quaternion.clone();
  return new THREE.Quaternion().setFromUnitVectors(restLocalDir, localDir);
}
