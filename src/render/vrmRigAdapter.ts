import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { computeRestDirLength, resolveChainChild } from './rigMath';
import { bindWorldDirOf, type VtubeRig, type VtubeRigEntry } from './GlbBoneDriver';

/**
 * Builds a VtubeRig straight from a VRM's humanoid bone map instead of the
 * userData.vtubeRig recipe AI-CAD embeds in plain GLBs — VRM already has a
 * standardized humanoid skeleton, so there's nothing to "prepare" first.
 * See vault/vtube/vrm-support.md.
 */

const ARM_LEG_JOINTS: Partial<Record<VRMHumanBoneName, { jointFrom: string; jointTo: string }>> = {
  leftUpperArm:  { jointFrom: 'shL',   jointTo: 'elL' },
  rightUpperArm: { jointFrom: 'shR',   jointTo: 'elR' },
  leftLowerArm:  { jointFrom: 'elL',   jointTo: 'wrL' },
  rightLowerArm: { jointFrom: 'elR',   jointTo: 'wrR' },
  neck:          { jointFrom: 'shMid', jointTo: 'headC' },
  leftUpperLeg:  { jointFrom: 'hipL',  jointTo: 'knL' },
  rightUpperLeg: { jointFrom: 'hipR',  jointTo: 'knR' },
  leftLowerLeg:  { jointFrom: 'knL',   jointTo: 'anL' },
  rightLowerLeg: { jointFrom: 'knR',   jointTo: 'anR' },
  leftFoot:      { jointFrom: 'anL',   jointTo: 'toeL' },
  rightFoot:     { jointFrom: 'anR',   jointTo: 'toeR' },
};

// jointFrom/jointTo here is a FALLBACK (elbow->wrist FK, same pair that
// drives the forearm bone) for when hand landmarks aren't available that
// frame — see the lmPair-falls-back-to-jointFrom/jointTo comment on
// VtubeRigEntry in GlbBoneDriver.ts. Keeps the hand tracking the arm even
// when fine hand tracking drops out, instead of freezing in bind pose.
const HAND_JOINTS: Partial<Record<VRMHumanBoneName, { side: 'L' | 'R'; jointFrom: string; jointTo: string }>> = {
  leftHand:  { side: 'L', jointFrom: 'elL', jointTo: 'wrL' },
  rightHand: { side: 'R', jointFrom: 'elR', jointTo: 'wrR' },
};

// The real skeletal continuation for each driven bone — NOT necessarily its
// first child in the node hierarchy. VRoid/VRM exports commonly attach
// secondary/spring bones (skirt joints, bust jiggle) as EARLIER children than
// the actual next joint (e.g. UpperChest's children are often
// [bustL, bustR, Neck, shoulderL, shoulderR]), so picking "first Bone child"
// for a bone's rest direction silently references a physics bone instead of
// the real chain — see computeRestDirLength()/bindWorldDirOf() in rigMath.ts
// / GlbBoneDriver.ts. Declaring the intended child here sidesteps that.
const CHAIN_CHILD: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {
  neck: 'head',
  leftUpperArm: 'leftLowerArm',   rightUpperArm: 'rightLowerArm',
  leftLowerArm: 'leftHand',       rightLowerArm: 'rightHand',
  leftHand: 'leftMiddleProximal', rightHand: 'rightMiddleProximal',
  leftUpperLeg: 'leftLowerLeg',   rightUpperLeg: 'rightLowerLeg',
  leftLowerLeg: 'leftFoot',       rightLowerLeg: 'rightFoot',
  leftFoot: 'leftToes',           rightFoot: 'rightToes',
};

// Prefer the highest bone in the spine chain that exists (upperChest > chest > spine)
// for the single torso jointFrom/jointTo=hipMid/shMid driven bone.
const SPINE_PREFERENCE: VRMHumanBoneName[] = ['upperChest', 'chest', 'spine'];

// Eyes are driven separately below (gaze angle from frame.pupil), not left
// locked like these — see the eulerEntry() calls in buildVrmRig().
const LOCKED_BONES: VRMHumanBoneName[] = ['hips', 'jaw', 'leftToes', 'rightToes'];

// thumb has Metacarpal/Proximal/Distal (no Intermediate); the rest have
// Proximal/Intermediate/Distal — matches VRMHumanBoneName's finger segments.
const FINGERS: Array<{ prefix: string; segments: string[]; lmPairs: [number, number][] }> = [
  { prefix: 'Thumb',  segments: ['Metacarpal', 'Proximal', 'Distal'],       lmPairs: [[1, 2], [2, 3], [3, 4]] },
  { prefix: 'Index',  segments: ['Proximal', 'Intermediate', 'Distal'],     lmPairs: [[5, 6], [6, 7], [7, 8]] },
  { prefix: 'Middle', segments: ['Proximal', 'Intermediate', 'Distal'],     lmPairs: [[9, 10], [10, 11], [11, 12]] },
  { prefix: 'Ring',   segments: ['Proximal', 'Intermediate', 'Distal'],     lmPairs: [[13, 14], [14, 15], [15, 16]] },
  { prefix: 'Little', segments: ['Proximal', 'Intermediate', 'Distal'],     lmPairs: [[17, 18], [18, 19], [19, 20]] },
];

function drivenEntry(bone: THREE.Bone, fields: Partial<VtubeRigEntry>, preferredChild?: THREE.Bone | null): VtubeRigEntry {
  const childBone = resolveChainChild(bone, preferredChild);
  const { dir, length } = computeRestDirLength(bone, childBone);
  return {
    bone,
    role: 'driven',
    restDir: dir,
    restQ: bone.quaternion.clone(),
    bindWorldDir: bindWorldDirOf(bone, childBone),
    childBone,
    length,
    ...fields,
  };
}

function lockedEntry(bone: THREE.Bone): VtubeRigEntry {
  return {
    bone,
    role: 'locked',
    restDir: new THREE.Vector3(0, 1, 0),
    restQ: bone.quaternion.clone(),
    bindWorldDir: bindWorldDirOf(bone),
    length: 0,
  };
}

/** A bone driven directly by a named Euler-rotation channel (head or eye
 *  gaze) rather than direction-matching — see VtubeRigEntry.eulerChannel. */
function eulerEntry(bone: THREE.Bone, channel: NonNullable<VtubeRigEntry['eulerChannel']>): VtubeRigEntry {
  return {
    bone,
    role: 'driven',
    restDir: new THREE.Vector3(0, 1, 0),
    restQ: bone.quaternion.clone(),
    bindWorldDir: bindWorldDirOf(bone),
    length: 0,
    eulerChannel: channel,
  };
}

/** Build a VtubeRig map from a loaded VRM's humanoid bones, keyed by each
 *  bone's raw (original) node name. Requires the scene's matrixWorld to
 *  already be up to date (call group.updateMatrixWorld(true) first, same
 *  requirement as parseVtubeRig). */
export function buildVrmRig(vrm: VRM): VtubeRig {
  const rig: VtubeRig = new Map();
  const humanoid = vrm.humanoid;
  if (!humanoid) return rig;

  const getBone = (name: VRMHumanBoneName): THREE.Bone | null => {
    const node = humanoid.getRawBoneNode(name);
    return node instanceof THREE.Bone ? node : null;
  };

  for (const name of SPINE_PREFERENCE) {
    const bone = getBone(name);
    if (bone) { rig.set(bone.name, drivenEntry(bone, { jointFrom: 'hipMid', jointTo: 'shMid' }, getBone('neck'))); break; }
  }

  for (const [name, pair] of Object.entries(ARM_LEG_JOINTS) as Array<[VRMHumanBoneName, { jointFrom: string; jointTo: string }]>) {
    const bone = getBone(name);
    if (bone) {
      const childName = CHAIN_CHILD[name];
      rig.set(bone.name, drivenEntry(bone, pair, childName ? getBone(childName) : undefined));
    }
  }

  for (const [name, hj] of Object.entries(HAND_JOINTS) as Array<[VRMHumanBoneName, { side: 'L' | 'R'; jointFrom: string; jointTo: string }]>) {
    const bone = getBone(name);
    if (bone) {
      const childName = CHAIN_CHILD[name];
      const entry = drivenEntry(
        bone,
        { lmHand: hj.side, lmPair: [0, 9], jointFrom: hj.jointFrom, jointTo: hj.jointTo },
        childName ? getBone(childName) : undefined,
      );
      // Second reference axis (wrist -> index-finger MCP) so the wrist gets
      // a full 2-axis orientation instead of single-vector alignment, which
      // leaves palm-facing/twist unconstrained — see restSideLocal's doc
      // comment on VtubeRigEntry in GlbBoneDriver.ts.
      const indexName = (hj.side === 'L' ? 'leftIndexProximal' : 'rightIndexProximal') as VRMHumanBoneName;
      const indexBone = getBone(indexName);
      if (indexBone) {
        entry.restSideLocal = computeRestDirLength(bone, indexBone).dir;
        entry.lmSidePair = [0, 5];
      }
      rig.set(bone.name, entry);
    }
  }

  // Head + eye gaze — driven by Kalidokit Euler channels (frame.head /
  // frame.pupil), not FK direction-matching, since there's no meaningful
  // "joint pair" for head orientation or eye look direction the way there is
  // for a limb. Previously unmapped (head) or explicitly locked (eyes).
  const headBone = getBone('head');
  if (headBone) rig.set(headBone.name, eulerEntry(headBone, 'head'));
  const leftEyeBone = getBone('leftEye');
  if (leftEyeBone) rig.set(leftEyeBone.name, eulerEntry(leftEyeBone, 'gazeL'));
  const rightEyeBone = getBone('rightEye');
  if (rightEyeBone) rig.set(rightEyeBone.name, eulerEntry(rightEyeBone, 'gazeR'));

  for (const side of ['left', 'right'] as const) {
    const lmHand: 'L' | 'R' = side === 'left' ? 'L' : 'R';
    for (const finger of FINGERS) {
      finger.segments.forEach((segment, i) => {
        const name = `${side}${finger.prefix}${segment}` as VRMHumanBoneName;
        const bone = getBone(name);
        if (bone) rig.set(bone.name, drivenEntry(bone, { lmHand, lmPair: finger.lmPairs[i] }));
      });
    }
  }

  for (const name of LOCKED_BONES) {
    const bone = getBone(name);
    if (bone) rig.set(bone.name, lockedEntry(bone));
  }

  return rig;
}
