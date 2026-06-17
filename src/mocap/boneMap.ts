// Mixamo bone name → GLB bone name lookup.
// Keys ARE the standard Mixamo names; values match by default but are rewritten
// for colon-prefix exports (mixamorig:Hips style) or overridden by a sidecar .json.
export const DEFAULT_BONE_MAP: Record<string, string> = {
  // Body
  mixamorigHips:           "mixamorigHips",
  mixamorigSpine:          "mixamorigSpine",
  mixamorigSpine1:         "mixamorigSpine1",
  mixamorigSpine2:         "mixamorigSpine2",
  mixamorigNeck:           "mixamorigNeck",
  mixamorigHead:           "mixamorigHead",
  mixamorigLeftShoulder:   "mixamorigLeftShoulder",
  mixamorigRightShoulder:  "mixamorigRightShoulder",
  mixamorigLeftArm:        "mixamorigLeftArm",
  mixamorigRightArm:       "mixamorigRightArm",
  mixamorigLeftForeArm:    "mixamorigLeftForeArm",
  mixamorigRightForeArm:   "mixamorigRightForeArm",
  mixamorigLeftHand:       "mixamorigLeftHand",
  mixamorigRightHand:      "mixamorigRightHand",
  mixamorigLeftUpLeg:      "mixamorigLeftUpLeg",
  mixamorigRightUpLeg:     "mixamorigRightUpLeg",
  mixamorigLeftLeg:        "mixamorigLeftLeg",
  mixamorigRightLeg:       "mixamorigRightLeg",
  mixamorigLeftFoot:       "mixamorigLeftFoot",
  mixamorigRightFoot:      "mixamorigRightFoot",
  // Left fingers
  mixamorigLeftHandThumb1:  "mixamorigLeftHandThumb1",
  mixamorigLeftHandThumb2:  "mixamorigLeftHandThumb2",
  mixamorigLeftHandThumb3:  "mixamorigLeftHandThumb3",
  mixamorigLeftHandIndex1:  "mixamorigLeftHandIndex1",
  mixamorigLeftHandIndex2:  "mixamorigLeftHandIndex2",
  mixamorigLeftHandIndex3:  "mixamorigLeftHandIndex3",
  mixamorigLeftHandMiddle1: "mixamorigLeftHandMiddle1",
  mixamorigLeftHandMiddle2: "mixamorigLeftHandMiddle2",
  mixamorigLeftHandMiddle3: "mixamorigLeftHandMiddle3",
  mixamorigLeftHandRing1:   "mixamorigLeftHandRing1",
  mixamorigLeftHandRing2:   "mixamorigLeftHandRing2",
  mixamorigLeftHandRing3:   "mixamorigLeftHandRing3",
  mixamorigLeftHandPinky1:  "mixamorigLeftHandPinky1",
  mixamorigLeftHandPinky2:  "mixamorigLeftHandPinky2",
  mixamorigLeftHandPinky3:  "mixamorigLeftHandPinky3",
  // Right fingers
  mixamorigRightHandThumb1:  "mixamorigRightHandThumb1",
  mixamorigRightHandThumb2:  "mixamorigRightHandThumb2",
  mixamorigRightHandThumb3:  "mixamorigRightHandThumb3",
  mixamorigRightHandIndex1:  "mixamorigRightHandIndex1",
  mixamorigRightHandIndex2:  "mixamorigRightHandIndex2",
  mixamorigRightHandIndex3:  "mixamorigRightHandIndex3",
  mixamorigRightHandMiddle1: "mixamorigRightHandMiddle1",
  mixamorigRightHandMiddle2: "mixamorigRightHandMiddle2",
  mixamorigRightHandMiddle3: "mixamorigRightHandMiddle3",
  mixamorigRightHandRing1:   "mixamorigRightHandRing1",
  mixamorigRightHandRing2:   "mixamorigRightHandRing2",
  mixamorigRightHandRing3:   "mixamorigRightHandRing3",
  mixamorigRightHandPinky1:  "mixamorigRightHandPinky1",
  mixamorigRightHandPinky2:  "mixamorigRightHandPinky2",
  mixamorigRightHandPinky3:  "mixamorigRightHandPinky3",
};

// [parentLandmark, childLandmark] pairs for Mixamo finger bones (15 per hand).
// Ordered Thumb123 / Index123 / Middle123 / Ring123 / Pinky123.
export const FINGER_LM_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];

export const FINGER_BONES_L: readonly string[] = [
  "mixamorigLeftHandThumb1",  "mixamorigLeftHandThumb2",  "mixamorigLeftHandThumb3",
  "mixamorigLeftHandIndex1",  "mixamorigLeftHandIndex2",  "mixamorigLeftHandIndex3",
  "mixamorigLeftHandMiddle1", "mixamorigLeftHandMiddle2", "mixamorigLeftHandMiddle3",
  "mixamorigLeftHandRing1",   "mixamorigLeftHandRing2",   "mixamorigLeftHandRing3",
  "mixamorigLeftHandPinky1",  "mixamorigLeftHandPinky2",  "mixamorigLeftHandPinky3",
];

export const FINGER_BONES_R: readonly string[] = [
  "mixamorigRightHandThumb1",  "mixamorigRightHandThumb2",  "mixamorigRightHandThumb3",
  "mixamorigRightHandIndex1",  "mixamorigRightHandIndex2",  "mixamorigRightHandIndex3",
  "mixamorigRightHandMiddle1", "mixamorigRightHandMiddle2", "mixamorigRightHandMiddle3",
  "mixamorigRightHandRing1",   "mixamorigRightHandRing2",   "mixamorigRightHandRing3",
  "mixamorigRightHandPinky1",  "mixamorigRightHandPinky2",  "mixamorigRightHandPinky3",
];

export const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// Canonical bone length as a fraction of hand length (wrist→middle-fingertip).
export const HAND_BONE_FRAC: readonly number[] = [
  0.28, 0.16, 0.12, 0.10,   // thumb
  0.46, 0.22, 0.13, 0.09,   // index (palm 0→5, then phalanges)
  0.07, 0.24, 0.14, 0.09,   // middle
  0.07, 0.22, 0.13, 0.09,   // ring
  0.07, 0.18, 0.10, 0.08,   // little
  0.42,                     // palm edge 0→17 (drawn only)
];

// Which finger each HAND_BONES entry belongs to → index into per-frame multiplier array.
// Bone 20 (palm edge) is structural, never scaled (-1).
export const HAND_BONE_FINGER: readonly number[] = [
  0, 0, 0, 0,   // thumb
  1, 1, 1, 1,   // index
  2, 2, 2, 2,   // middle
  3, 3, 3, 3,   // ring
  4, 4, 4, 4,   // little
  -1,           // palm edge
];

// Per-bone radius as a fraction of the base finger radius.
export const HAND_BONE_R: readonly number[] = [
  1.05, 0.92, 0.80, 0.66,   // thumb
  0.98, 0.84, 0.72, 0.58,   // index
  0.98, 0.86, 0.74, 0.60,   // middle
  0.92, 0.80, 0.68, 0.56,   // ring
  0.84, 0.72, 0.62, 0.52,   // little
  0.80,                     // palm edge
];

// Palm-fan metacarpal bones (wrist/knuckle web): NOT drawn as thin cylinders.
export const PALM_FAN_BONES = new Set<number>([4, 8, 12, 16]);

// Eyelid-ring landmarks, ordered around each eye (lower lid then upper lid).
export const RIGHT_EYE_RING = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const LEFT_EYE_RING  = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
