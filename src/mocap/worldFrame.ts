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

  // lmToWorld negates X when mx=-1, so person's right body half maps to negative-x
  // (the model's left side).  Swap every bilateral index pair so the named joints
  // (shL/R, elL/R, etc.) land on the correct side of the model in mirror mode.
  const [i11, i12] = mx === -1 ? [12, 11] : [11, 12]; // shoulders
  const [i13, i14] = mx === -1 ? [14, 13] : [13, 14]; // elbows
  const [i15, i16] = mx === -1 ? [16, 15] : [15, 16]; // wrists
  const [i23, i24] = mx === -1 ? [24, 23] : [23, 24]; // hips
  const [i25, i26] = mx === -1 ? [26, 25] : [25, 26]; // knees
  const [i27, i28] = mx === -1 ? [28, 27] : [27, 28]; // ankles
  const [i31, i32] = mx === -1 ? [32, 31] : [31, 32]; // foot index
  const [i7,  i8 ] = mx === -1 ? [8,  7 ] : [7,  8 ]; // ears

  const hipL = lm(i23), hipR = lm(i24);
  const shL  = lm(i11), shR  = lm(i12);
  return {
    hipMid: mid(hipL, hipR), hipL, hipR,
    shMid: mid(shL, shR), shL, shR,
    elL: lm(i13), elR: lm(i14),
    wrL: lm(i15), wrR: lm(i16),
    knL: lm(i25), knR: lm(i26),
    anL: lm(i27), anR: lm(i28),
    toeL: lm(i31), toeR: lm(i32),
    headC: mid(lm(i7), lm(i8)),
    noseC: lm(0),
    earL: lm(i7), earR: lm(i8),
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
