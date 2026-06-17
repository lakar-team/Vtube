import * as THREE from "three";

/**
 * Single source of truth for MediaPipe → Three.js coordinate transforms.
 *
 * MediaPipe uses two spaces:
 *   World space  (PoseLandmarker worldLandmarks) — metric, Y-down, hip-origin
 *   Image space  (FaceLandmarker / HandLandmarker) — normalized [0,1], camera-facing
 *
 * Three.js target: Y-up, right-hand, same metric scale.
 *
 * Nothing outside this module should perform coordinate conversions.
 */

/**
 * Convert a MediaPipe worldLandmark {x,y,z} to Three.js space.
 * Y is flipped (Y-down → Y-up). Z is negated (depth-into-screen → -Z forward).
 * @param mirrorX  Negate X for mirror/selfie mode (world-space flip).
 */
export function mpWorldToThree(
  lm: { x: number; y: number; z: number },
  mirrorX = false,
): THREE.Vector3 {
  return new THREE.Vector3(mirrorX ? -lm.x : lm.x, -lm.y, -lm.z);
}

/**
 * Convert a MediaPipe image-space landmark (normalized [0,1], centred at 0.5)
 * to a metric Three.js position.
 * @param scale    Metres per normalized unit.
 * @param mirrorX  Flip X for mirror/selfie mode.
 */
export function mpImageToThree(
  lm: { x: number; y: number; z: number },
  scale: number,
  mirrorX = false,
): THREE.Vector3 {
  const sx = (mirrorX ? -(lm.x - 0.5) : lm.x - 0.5) * scale;
  return new THREE.Vector3(sx, -(lm.y - 0.5) * scale, -lm.z * scale);
}

/**
 * Compute the local-space quaternion that drives a SkinnedMesh bone so its
 * bind-pose direction aligns with a desired world-space target direction.
 *
 * This is the correct FK retargeting formula for SkinnedMesh:
 *   1. Convert world target direction to parent-local space.
 *   2. Rotate from the bone's bind-pose direction to that local direction.
 *
 * Allocates — callers on the hot animation path should inline using pre-allocated
 * temporaries (see driveBoneByDir in RoomViewport.tsx).
 *
 * @param targetWorldDir  Desired bone direction in world space.
 * @param parentWorldQuat Parent bone's current world quaternion.
 * @param restLocalDir    Direction the bone points in its parent's local space at
 *                        bind pose. Extract once at load time:
 *                          bone.children[0].position.clone().normalize()
 *                        Defaults to Y-up (correct for most Mixamo spine/neck/leg bones).
 */
export function worldDirToLocalQuat(
  targetWorldDir: THREE.Vector3,
  parentWorldQuat: THREE.Quaternion,
  restLocalDir: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
): THREE.Quaternion {
  const parentInv = parentWorldQuat.clone().invert();
  const localDir = targetWorldDir.clone().applyQuaternion(parentInv).normalize();
  return new THREE.Quaternion().setFromUnitVectors(restLocalDir, localDir);
}
