import * as THREE from "three";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

/** Matches the Z_SCALE constant in SkeletonViewport — keep in sync. */
export const LM_Z_SCALE = 0.5;

/**
 * Convert a MediaPipe NormalizedLandmark to a world position in the same
 * coordinate space as SkeletonViewport's orthographic scene:
 *   x = mx * (lm.x - 0.5) * aspect   (mx = -1 when mirrored)
 *   y = -(lm.y - 0.5)                 (lm.y grows downward)
 *   z = -(lm.z ?? 0) * LM_Z_SCALE
 */
export function lmToWorld(
  lm: NormalizedLandmark,
  mx: number,
  aspect: number,
): THREE.Vector3 {
  return new THREE.Vector3(
    mx * (lm.x - 0.5) * aspect,
    -(lm.y - 0.5),
    -(lm.z ?? 0) * LM_Z_SCALE,
  );
}
