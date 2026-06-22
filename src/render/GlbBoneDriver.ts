import * as THREE from 'three';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { RigConfig } from '../mocap/rig';
import type { RuleFlags } from '../components/RoomViewport';
import { lmHandDir } from '../mocap/worldFrame';
import { SpringBoneSimulator } from './SpringBones';

// ── Public types ──────────────────────────────────────────────────────────────

export interface FKPositions {
  hipMid:   THREE.Vector3;
  torsoDir: THREE.Vector3;
  shMid:    THREE.Vector3;
  headDir:  THREE.Vector3;
  headC:    THREE.Vector3;
  shL:  THREE.Vector3; shR:  THREE.Vector3;
  hipL: THREE.Vector3; hipR: THREE.Vector3;
  elL:  THREE.Vector3; elR:  THREE.Vector3;
  wrL:  THREE.Vector3; wrR:  THREE.Vector3;
  knL:  THREE.Vector3; knR:  THREE.Vector3;
  anL:  THREE.Vector3; anR:  THREE.Vector3;
  toeL: THREE.Vector3; toeR: THREE.Vector3;
}

/** Single entry in a parsed vtubeRig — one bone's driving recipe. */
export interface VtubeRigEntry {
  bone:       THREE.Bone;
  role:       "driven" | "spring" | "locked";
  /** Bone-LOCAL unit vector pointing toward the child bone at bind pose. */
  restDir:    THREE.Vector3;
  /** Bind-pose local quaternion — spring target and locked reference. */
  restQ:      THREE.Quaternion;
  length:     number;
  // driven via FK position pair:
  jointFrom?: string;           // key in FKPositions
  jointTo?:   string;           // key in FKPositions
  // driven via MediaPipe hand landmarks (mutually exclusive with jointFrom/To):
  lmHand?:    "L" | "R";
  lmPair?:    [number, number]; // [parentLmIdx, childLmIdx]
  // spring only:
  stiffness?: number;
  damping?:   number;
}

/** Map from bone's original scene name → its compiled recipe entry. */
export type VtubeRig = Map<string, VtubeRigEntry>;

export interface LoadedModel {
  group:          THREE.Group;
  bones:          Map<string, THREE.Bone>;  // for logging / inspection
  hipsLocalY:     number;
  skeletonHelper: THREE.SkeletonHelper;
  vtubeFaceMode:  string | undefined;
  vtubeFaceMap:   Record<string, string> | undefined;
  vtubeRig:       VtubeRig | null;
}

// ── Loader helpers (called from RoomViewport GLB loader) ──────────────────────

// Mixamo finger/hand segment name → MediaPipe hand landmark pair [parent, child].
// Used as a fallback when the vtubeRig recipe marks a bone "driven" but omits
// lmHand/lmPair (current AI-CAD exporter marks fingers driven but doesn't yet
// populate the landmark mapping).  Keyed by the segment that appears in the bone
// name after stripping the mixamorig prefix and Left/Right side marker.
const MIXAMO_FINGER_LM: Readonly<Record<string, [number, number]>> = {
  // thumb: CMC→MCP, MCP→IP, IP→TIP
  HandThumb1: [1, 2],  HandThumb2: [2, 3],  HandThumb3: [3, 4],
  // index
  HandIndex1:  [5, 6],  HandIndex2:  [6, 7],  HandIndex3:  [7, 8],
  // middle
  HandMiddle1: [9, 10], HandMiddle2: [10, 11], HandMiddle3: [11, 12],
  // ring
  HandRing1:  [13, 14], HandRing2:  [14, 15], HandRing3:  [15, 16],
  // pinky
  HandPinky1: [17, 18], HandPinky2: [18, 19], HandPinky3: [19, 20],
};

/** If a driven bone has no lmPair/jointFrom+jointTo, try to infer MediaPipe
 *  hand landmark driving from its Mixamo-style name.  Returns null if the name
 *  doesn't match any known finger/hand pattern. */
function inferFingerLmPair(
  boneName: string,
): { lmHand: "L" | "R"; lmPair: [number, number] } | null {
  const side: "L" | "R" | null =
    boneName.includes("Left") ? "L" : boneName.includes("Right") ? "R" : null;
  if (!side) return null;

  for (const [seg, pair] of Object.entries(MIXAMO_FINGER_LM)) {
    if (boneName.includes(seg)) return { lmHand: side, lmPair: pair };
  }
  // Bare hand/wrist bone (e.g. LeftHand): no finger segment matched.
  // Drive from wrist (lm 0) → middle-finger MCP (lm 9) for palm orientation.
  if (boneName.includes("Hand") && !/Thumb|Index|Middle|Ring|Pinky/.test(boneName)) {
    return { lmHand: side, lmPair: [0, 9] };
  }
  return null;
}

/** Parse gltf.scene.userData.vtubeRig into a compiled VtubeRig.
 *  Returns null if the userData doesn't contain a valid recipe. */
export function parseVtubeRig(group: THREE.Group): VtubeRig | null {
  // The GLTFExporter serializes userData on a root Group as a *node* extras block,
  // not as the scene's own extras — so the recipe may live on a child node rather
  // than on gltf.scene itself.  Walk the hierarchy and use the first hit.
  // Box the result to avoid TypeScript's control-flow narrowing to `never`
  // when the variable is assigned inside a closure.
  const found = { raw: null as Record<string, unknown> | null };
  group.traverse((obj) => {
    if (found.raw) return;
    const ud = obj.userData?.vtubeRig;
    if (ud && typeof ud === "object" && (ud as Record<string, unknown>).version === 1 && (ud as Record<string, unknown>).bones)
      found.raw = ud as Record<string, unknown>;
  });
  const raw = found.raw;
  if (!raw) return null;

  const rig: VtubeRig = new Map();
  for (const [boneName, rawEntry] of Object.entries(raw.bones as Record<string, unknown>)) {
    const e = rawEntry as Record<string, unknown>;
    const bone = group.getObjectByName(boneName);
    if (!(bone instanceof THREE.Bone)) {
      console.warn(`[vtubeRig] bone "${boneName}" not found in model — skipped`);
      continue;
    }
    const rd = e.restDir as [number, number, number] | undefined;
    const role      = (e.role as VtubeRigEntry["role"]) ?? "locked";
    const jointFrom = (e.jointFrom as string | undefined) || undefined;
    const jointTo   = (e.jointTo   as string | undefined) || undefined;
    let   lmHand    = (e.lmHand    as "L" | "R" | undefined) || undefined;
    let   lmPair    = (e.lmPair    as [number, number] | undefined) || undefined;

    // Fallback: recipe marks bone "driven" but omits MediaPipe landmark params
    // (current AI-CAD exporter sets role=driven for finger bones but doesn't yet
    // emit lmHand/lmPair).  Infer from Mixamo bone naming so these models work.
    if (role === "driven" && !lmPair && !(jointFrom && jointTo)) {
      const inferred = inferFingerLmPair(boneName);
      if (inferred) { lmHand = inferred.lmHand; lmPair = inferred.lmPair; }
    }

    rig.set(boneName, {
      bone,
      role,
      restDir:   rd ? new THREE.Vector3(rd[0], rd[1], rd[2]).normalize() : new THREE.Vector3(0, 1, 0),
      restQ:     bone.quaternion.clone(),
      length:    (e.length as number) ?? 0,
      jointFrom,
      jointTo,
      lmHand,
      lmPair,
      stiffness: e.stiffness as number | undefined,
      damping:   e.damping   as number | undefined,
    });
  }
  console.log(`[vtubeRig] parsed ${rig.size} bone entries (version ${raw.version})`);
  return rig;
}

/** Find the world-space Y of the skeleton root bone (parent is not a Bone).
 *  Falls back to searching the entire group if the rig doesn't include the root. */
export function findHipsLocalY(group: THREE.Group, vtubeRig: VtubeRig | null): number {
  let rootBone: THREE.Bone | undefined;

  if (vtubeRig) {
    for (const entry of vtubeRig.values()) {
      if (!(entry.bone.parent instanceof THREE.Bone)) { rootBone = entry.bone; break; }
    }
  }
  if (!rootBone) {
    group.traverse((obj) => {
      if (obj instanceof THREE.Bone && !(obj.parent instanceof THREE.Bone)) rootBone = obj;
    });
  }

  return rootBone ? rootBone.getWorldPosition(new THREE.Vector3()).y : 0;
}

// ── Module-scope temps (one allocation, reused every frame) ──────────────────

const _bDir     = new THREE.Vector3();
const _parentQ  = new THREE.Quaternion();
const _tmpPos   = new THREE.Vector3();
const _tmpScale = new THREE.Vector3();
const _localDir = new THREE.Vector3();

// ── Driver ────────────────────────────────────────────────────────────────────

export class GlbBoneDriver {
  private _spring = new SpringBoneSimulator();

  update(
    model: LoadedModel,
    figurePosition: THREE.Vector3,
    fk: FKPositions,
    _rig: RigConfig,
    rules: RuleFlags,
    mx: number,
    dataForL: NormalizedLandmark[] | null,
    dataForR: NormalizedLandmark[] | null,
    expressions: Record<string, number> | undefined,
    dt: number,
  ): void {
    model.group.position.set(
      figurePosition.x,
      figurePosition.y - model.hipsLocalY,
      figurePosition.z,
    );

    if (rules.pauseBoneDriving || !model.vtubeRig) return;

    const vtubeRig = model.vtubeRig;
    const fkMap = fk as unknown as Record<string, THREE.Vector3>;

    // Prime the hierarchy with last frame's quaternions → gives each bone's parent a
    // fresh matrixWorld before the driving pass begins.
    model.group.updateMatrixWorld(true);

    // Single traversal pass (DFS, parent visited before children):
    //  1. For Bone nodes in the recipe: compute and set the new local quaternion.
    //  2. For ALL nodes: recompute matrix and propagate matrixWorld downward.
    //
    // Because parent comes before child in the traversal, each bone's new quaternion
    // is computed using its parent's matrixWorld that was JUST updated in this same
    // pass — eliminating the one-frame stale-parent lag of the two-pass approach.
    let boneCount = 0;
    model.group.traverse((obj) => {
      if (obj instanceof THREE.Bone) {
        const entry = vtubeRig.get(obj.name);
        if (entry && entry.role === "driven" && boneCount < rules.driveBonesUpTo) {
          let worldDir: THREE.Vector3 | null = null;

          if (entry.lmPair) {
            // Hand-landmark driving
            const lm = entry.lmHand === "L" ? dataForL : dataForR;
            if (lm && lm.length > Math.max(entry.lmPair[0], entry.lmPair[1])) {
              worldDir = lmHandDir(lm[entry.lmPair[0]], lm[entry.lmPair[1]], mx);
            }
          } else if (entry.jointFrom && entry.jointTo) {
            const a = fkMap[entry.jointFrom];
            const b = fkMap[entry.jointTo];
            if (a && b) {
              _bDir.subVectors(b, a);
              if (_bDir.lengthSq() > 1e-8) worldDir = _bDir.normalize();
            }
          }

          if (worldDir) {
            // Convert world direction to parent-local space using parent's fresh matrixWorld.
            if (obj.parent) {
              obj.parent.matrixWorld.decompose(_tmpPos, _parentQ, _tmpScale);
              _localDir.copy(worldDir).applyQuaternion(_parentQ.invert());
            } else {
              _localDir.copy(worldDir);
            }
            _localDir.normalize();
            if (_localDir.lengthSq() > 1e-4) {
              obj.quaternion.setFromUnitVectors(entry.restDir, _localDir);
            }
            boneCount++;
          }
        } else if (entry?.role === "spring") {
          this._spring.step(obj, entry.restQ, entry.stiffness ?? 0.5, entry.damping ?? 0.5, dt);
        }
        // "locked": leave quaternion unchanged (bind pose from GLB)
      }

      // Refresh this node's matrix and matrixWorld. Parent is guaranteed fresh
      // because traverse visits parent before children.
      obj.updateMatrix();
      if (obj.parent) {
        obj.matrixWorld.multiplyMatrices(obj.parent.matrixWorld, obj.matrix);
      } else {
        obj.matrixWorld.copy(obj.matrix);
      }
    });

    // After all bone transforms are settled, push them to the skinned mesh deformers.
    model.group.traverse((obj) => {
      if (obj instanceof THREE.SkinnedMesh) obj.skeleton.update();
    });

    if (rules.useModelFace && expressions) {
      const faceMap = model.vtubeFaceMap;
      model.group.traverse((obj) => {
        if (!(obj instanceof THREE.SkinnedMesh)) return;
        const dict = obj.morphTargetDictionary;
        const infl = obj.morphTargetInfluences;
        if (!dict || !infl) return;
        for (const [arkit, value] of Object.entries(expressions)) {
          const morphName = faceMap ? (faceMap[arkit] ?? arkit) : arkit;
          const idx = dict[morphName];
          if (idx !== undefined) infl[idx] = value as number;
        }
      });
    }
  }
}
