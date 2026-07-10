import * as THREE from 'three';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { VRM } from '@pixiv/three-vrm';
import type { RigConfig } from '../mocap/rig';
import type { RuleFlags } from '../components/RoomViewport';
import type { EulerRotation } from '../mocap/types';
import { EXPRESSION_KEYS } from '../mocap/types';
import { lmHandDir } from '../mocap/worldFrame';
import { resolveChainChild } from './rigMath';
import { SpringBoneSimulator } from './SpringBones';

/** Max eye-bone rotation (yaw/pitch) at full pupil deflection (±1). Tuned by
 *  eye, not measured — a VRM's own eye-bone range varies by model, so this is
 *  a reasonable default rather than a derived constant. */
const EYE_GAZE_MAX_RAD = THREE.MathUtils.degToRad(20);

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
  /**
   * WORLD-space unit vector from this bone to its first child bone at bind
   * pose, captured once at parse time (after updateMatrixWorld, before any
   * driving). Used by rigDiagnostics.ts to compare bind pose against the
   * recipe's declared restDir/against live FK — never mutated by driving.
   */
  bindWorldDir: THREE.Vector3;
  /**
   * The child bone actually used to compute restDir/bindWorldDir (see
   * resolveChainChild() in rigMath.ts) — stored so rigDiagnostics.ts's own
   * restDir re-derivations reuse this same reference instead of re-guessing
   * via "first Bone child", which can land on a secondary/spring bone.
   * Undefined for parseVtubeRig()-sourced entries (recipe-declared restDir,
   * no live child resolution) and for leaf/locked bones.
   */
  childBone?: THREE.Bone;
  length:     number;
  // driven via FK position pair:
  jointFrom?: string;           // key in FKPositions
  jointTo?:   string;           // key in FKPositions
  // driven via MediaPipe hand landmarks — falls back to jointFrom/jointTo
  // (when both are also set) if the landmark data is unavailable that frame,
  // e.g. hand tracking dropped out but the arm is still tracked. Wrist bones
  // set both; finger phalanges set only lmHand/lmPair (no FK fallback since
  // there's no per-finger FK position to fall back to).
  lmHand?:    "L" | "R";
  lmPair?:    [number, number]; // [parentLmIdx, childLmIdx]
  /**
   * Second bone-LOCAL reference direction (bind pose) + landmark pair, for
   * wrist bones only — see the "wrist twist" fix in GlbBoneDriver.update().
   * `lmPair` alone only constrains ONE axis (which way the hand points,
   * wrist->middle-MCP); the rotation AROUND that axis — which way the palm
   * faces — is then whatever THREE.Quaternion.setFromUnitVectors()'s
   * minimal-rotation happens to produce, which has no relationship to the
   * hand's actual roll and can flip/drift unpredictably. Set on both: a
   * second live landmark pair (wrist->index-MCP) and its bind-pose
   * bone-local equivalent, so the driver can build a full 2-axis orthonormal
   * frame instead of aligning a single vector.
   */
  restSideLocal?: THREE.Vector3;
  lmSidePair?:    [number, number];
  /**
   * Forearm bones only: absorb this fraction (0-1) of the palm-facing twist
   * that the wrist would otherwise have to carry entirely by itself. A
   * single elbow->wrist position vector can't express rotation around the
   * forearm's own length axis, so without this 100% of a palm flip lands on
   * the one wrist joint — up to ~180° of axial twist over a single joint,
   * which candy-wraps the mesh into a pinch. The driver computes the twist
   * EXACTLY (swing-twist decomposition of the wrist's would-be local
   * rotation, see the twist-share block in update()), rotates the forearm by
   * this fraction of it, and the wrist's own 2-axis targeting — computed
   * against the freshly twisted parent frame in the same parent-before-child
   * pass — automatically covers only the remainder. Mirrors how a real arm
   * splits rotation between forearm pronation and the wrist joint.
   * Requires twistChildRestBasisInv.
   */
  twistShareFraction?: number;
  /**
   * Inverse of the child WRIST entry's bind-pose basis quaternion
   * (basisQuaternion(hand restDir, hand restSideLocal), inverted) —
   * precomputed at rig build so the forearm's twist-share block can compute
   * the wrist's would-be local rotation without a rig lookup per frame.
   */
  twistChildRestBasisInv?: THREE.Quaternion;
  /**
   * When set, this bone is driven directly from a named Kalidokit-solved
   * Euler-rotation channel on the current MocapFrame instead of the
   * jointFrom/jointTo or lmHand/lmPair direction-matching paths above:
   * 'head' -> frame.head, 'gazeL'/'gazeR' -> an eye-bone angle derived from
   * frame.pupil (same signal the procedural skeleton's eyeballs use, just
   * converted to a rotation instead of a translation).
   */
  eulerChannel?: 'head' | 'gazeL' | 'gazeR';
  // spring only:
  stiffness?: number;
  damping?:   number;
  /**
   * True if the GLB's recipe said role:"driven" for this bone but supplied
   * neither a usable jointFrom+jointTo pair nor lmHand/lmPair (even after the
   * inferFingerLmPair() fallback below) — parseVtubeRig() downgrades it to
   * role:"locked" rather than leaving a dead "driven" entry that never moves.
   * Purely informational for rigDiagnostics.ts; doesn't affect driving.
   */
  autoLockedFromDriven?: boolean;
}

/** Map from bone's original scene name → its compiled recipe entry. */
export type VtubeRig = Map<string, VtubeRigEntry>;

export interface LoadedModel {
  group:          THREE.Group;
  bones:          Map<string, THREE.Bone>;  // for logging / inspection
  hipsLocalY:     number;
  /**
   * Scaled bounding-box min Y at load time (group.position still (0,0,0), so
   * this is in "group-local but scaled" space) — how far the model's own
   * lowest point (feet, in a standing bind pose) sits above its own local
   * origin. Used by the `groundAnchorModel` rule to plant the model's own
   * feet on the room floor instead of anchoring it by hip height, for models
   * whose own proportions don't match the rig's (see hipsLocalY vs.
   * figurePosition.y mismatch — the whole reason this field exists).
   */
  groundOffsetY:  number;
  skeletonHelper: THREE.SkeletonHelper;
  vtubeFaceMode:  string | undefined;
  vtubeFaceMap:   Record<string, string> | undefined;
  vtubeRig:       VtubeRig | null;
  /** Set when the loaded file is a VRM (vs. an AI-CAD-prepared plain GLB) — see vrmRigAdapter.ts. */
  vrm:            VRM | null;
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

/** World-space unit direction from a bone to its child bone. Requires the
 *  scene's matrixWorld to already be up to date. Falls back to world-up for
 *  leaf bones (no child bone to point toward). Exported for reuse by
 *  vrmRigAdapter.ts, which builds VtubeRigEntry objects outside parseVtubeRig.
 *  `preferredChild` — see computeRestDirLength() in rigMath.ts for why this
 *  matters: a plain "first Bone child" pick can land on a secondary/spring
 *  bone (skirt, bust jiggle) instead of the real skeletal continuation. */
export function bindWorldDirOf(bone: THREE.Bone, preferredChild?: THREE.Bone | null): THREE.Vector3 {
  const child = resolveChainChild(bone, preferredChild);
  if (!child) return new THREE.Vector3(0, 1, 0);
  const a = bone.getWorldPosition(new THREE.Vector3());
  const b = child.getWorldPosition(new THREE.Vector3());
  const dir = b.sub(a);
  return dir.lengthSq() > 1e-12 ? dir.normalize() : new THREE.Vector3(0, 1, 0);
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
    let   role      = (e.role as VtubeRigEntry["role"]) ?? "locked";
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

    // Still nothing to drive it with, even after the fallback above (e.g. an
    // older AI-CAD export predating its own joint-pair validation, or a
    // hand-edited recipe with a typo'd joint name) — downgrade to locked
    // instead of shipping a "driven" bone that silently never moves. No
    // console warning: this is expected/handled, not an error worth logging
    // every frame's worth of noise for; rigDiagnostics.ts surfaces it as an
    // info-level notice instead.
    const autoLockedFromDriven = role === "driven" && !lmPair && !(jointFrom && jointTo);
    if (autoLockedFromDriven) role = "locked";

    rig.set(boneName, {
      bone,
      role,
      restDir:   rd ? new THREE.Vector3(rd[0], rd[1], rd[2]).normalize() : new THREE.Vector3(0, 1, 0),
      restQ:     bone.quaternion.clone(),
      bindWorldDir: bindWorldDirOf(bone),
      length:    (e.length as number) ?? 0,
      jointFrom,
      jointTo,
      lmHand,
      lmPair,
      stiffness: e.stiffness as number | undefined,
      damping:   e.damping   as number | undefined,
      autoLockedFromDriven,
    });
  }
  console.log(`[vtubeRig] parsed ${rig.size} bone entries (version ${raw.version})`);
  return rig;
}

/** Number of THREE.Bone ancestors above a bone (0 = its parent isn't a Bone). */
function boneDepth(bone: THREE.Bone): number {
  let depth = 0;
  let p: THREE.Object3D | null = bone.parent;
  while (p instanceof THREE.Bone) { depth++; p = p.parent; }
  return depth;
}

/** Find the world-space Y of the skeleton root bone — the SHALLOWEST bone
 *  among the rig's entries (fewest THREE.Bone ancestors), not merely one
 *  with zero Bone ancestors: some rigs (VRM models with a "Root" bone
 *  wrapping Hips) have a non-tracked Bone above the actual root, which a
 *  "parent isn't a Bone" check would skip past, mis-picking that wrapper
 *  (sitting at ground level) instead of Hips. Falls back to searching the
 *  entire group the same way if the rig doesn't include the root. */
export function findHipsLocalY(group: THREE.Group, vtubeRig: VtubeRig | null): number {
  let rootBone: THREE.Bone | undefined;
  let minDepth = Infinity;

  if (vtubeRig) {
    for (const entry of vtubeRig.values()) {
      const d = boneDepth(entry.bone);
      if (d < minDepth) { minDepth = d; rootBone = entry.bone; }
    }
  }
  if (!rootBone) {
    minDepth = Infinity;
    group.traverse((obj) => {
      if (obj instanceof THREE.Bone) {
        const d = boneDepth(obj);
        if (d < minDepth) { minDepth = d; rootBone = obj; }
      }
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
const _tEuler   = new THREE.Euler();
const _localSide   = new THREE.Vector3();
const _qRestBasis  = new THREE.Quaternion();
const _qLiveBasis  = new THREE.Quaternion();
const _qSwing      = new THREE.Quaternion();
const _qTwist      = new THREE.Quaternion();
const _qHandWorld  = new THREE.Quaternion();
const _qH0         = new THREE.Quaternion();
const _qTarget     = new THREE.Quaternion();

/**
 * Rate caps for the wrist/forearm anti-pop measures (see the rate-limit and
 * twist-share blocks in update()). 720°/s comfortably covers real wrist
 * motion — a fast deliberate flick is ~90° in 0.1s (900°/s) at the extreme,
 * and observed real recordings average ~165°/s — while a MediaPipe
 * tracking flip (a 45-176° single-frame pop) gets spread over a few frames
 * instead of snapping.
 */
const WRIST_MAX_RAD_PER_S = THREE.MathUtils.degToRad(720);
const TWIST_MAX_RAD_PER_S = THREE.MathUtils.degToRad(720);
const _obX = new THREE.Vector3();
const _obY = new THREE.Vector3();
const _obZ = new THREE.Vector3();
const _obM = new THREE.Matrix4();
const _clampAxis = new THREE.Vector3();
const _clampQ    = new THREE.Quaternion();

// No real finger joint bends anywhere near this far in one segment (DIP/PIP
// max out around 90-110anatomically). Bounding it keeps setFromUnitVectors
// away from its own well-known instability near the antipodal (180°) case,
// where the rotation axis becomes ill-defined and tiny per-frame tracking
// noise in the target direction produces wild, unstable swings in the
// output — confirmed against a real recording: restDir-vs-target angle sat
// at 130-166° for ~1.4s straight while the finger was held curled, and the
// driven bone's rotation swung through 150-250° during that exact window
// even though the underlying landmark positions were smooth and stable.
const MAX_FINGER_BEND_RAD = 110 * Math.PI / 180;

/** Clamps `dir` to at most `maxAngle` radians away from `ref` (both assumed
 *  normalized) by rotating it toward `ref` along their shared perpendicular
 *  axis. No-op if already within range. Falls back to leaving `dir`
 *  unchanged if `ref`/`dir` are (near-)exactly opposite — no stable axis to
 *  clamp along in that case, but keeping inputs from reaching that extreme
 *  in the first place is exactly what this clamp is for. */
function clampAngleFromRef(dir: THREE.Vector3, ref: THREE.Vector3, maxAngle: number): THREE.Vector3 {
  const angle = ref.angleTo(dir);
  if (angle <= maxAngle || angle < 1e-6) return dir;
  _clampAxis.crossVectors(ref, dir);
  if (_clampAxis.lengthSq() < 1e-10) return dir;
  _clampAxis.normalize();
  _clampQ.setFromAxisAngle(_clampAxis, maxAngle);
  return dir.copy(ref).applyQuaternion(_clampQ);
}

/**
 * Builds an absolute orientation quaternion from a primary axis (already
 * normalized) + a rough secondary reference (Gram-Schmidt-orthogonalized
 * against the primary, so it need not be exactly perpendicular). Used to
 * give the wrist a full 2-axis orientation instead of the single-vector
 * `setFromUnitVectors` alignment everything else uses — see
 * VtubeRigEntry.restSideLocal's doc comment for why the wrist specifically
 * needs this (twist/roll is unconstrained by a single direction vector).
 */
export function basisQuaternion(primary: THREE.Vector3, sideRough: THREE.Vector3, out: THREE.Quaternion): void {
  _obX.copy(primary);
  _obY.copy(sideRough).addScaledVector(primary, -sideRough.dot(primary));
  if (_obY.lengthSq() < 1e-8) {
    // sideRough was (near) parallel to primary — pick any non-parallel
    // fallback so the basis stays well-defined instead of degenerating.
    _obY.set(1, 0, 0);
    if (Math.abs(_obX.dot(_obY)) > 0.99) _obY.set(0, 1, 0);
    _obY.addScaledVector(_obX, -_obX.dot(_obY));
  }
  _obY.normalize();
  _obZ.crossVectors(_obX, _obY).normalize();
  _obM.makeBasis(_obX, _obY, _obZ);
  out.setFromRotationMatrix(_obM);
}

// ── Driver ────────────────────────────────────────────────────────────────────

export class GlbBoneDriver {
  private _spring = new SpringBoneSimulator();
  /** Per-forearm twist-share state: unwrapped target twist + rate-limited applied twist (radians). */
  private _twistState = new WeakMap<THREE.Bone, { target: number; applied: number }>();
  /** Last applied local quaternion per wrist bone, for the anti-pop rate limiter. */
  private _wristPrevQ = new WeakMap<THREE.Bone, THREE.Quaternion>();

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
    headEuler: EulerRotation | undefined,
    pupil: { x: number; y: number } | undefined,
    dt: number,
  ): void {
    // groundAnchorModel: plant the model's own feet on the floor (groundOffsetY
    // is its own bind-pose lowest point, scaled) instead of matching the rig's
    // hip height — see the rule's doc comment in RoomViewport.tsx for the
    // hip-anchor-vs-floor-contact trade-off this exists for.
    model.group.position.set(
      figurePosition.x,
      rules.groundAnchorModel ? -model.groundOffsetY : figurePosition.y - model.hipsLocalY,
      figurePosition.z,
    );

    if (rules.pauseBoneDriving || !model.vtubeRig) return;

    const vtubeRig = model.vtubeRig;
    const fkMap = fk as unknown as Record<string, THREE.Vector3>;

    // Eye-bone gaze angle, shared by both eyes (no independent convergence) —
    // pupil.x/y is already mirror-adjusted upstream (kalidokitAdapter.ts),
    // same as headEuler, so no `mx` handling needed here.
    const gazeEuler: EulerRotation | undefined = pupil
      ? { x: -pupil.y * EYE_GAZE_MAX_RAD, y: pupil.x * EYE_GAZE_MAX_RAD, z: 0 }
      : undefined;

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
          if (entry.eulerChannel) {
            const e = entry.eulerChannel === "head" ? headEuler : gazeEuler;
            if (e) {
              obj.quaternion.setFromEuler(_tEuler.set(e.x, e.y, e.z, "XYZ"));
              boneCount++;
            }
          } else {
            let worldDir: THREE.Vector3 | null = null;

            if (entry.lmPair) {
              // Hand-landmark driving
              const lm = entry.lmHand === "L" ? dataForL : dataForR;
              if (lm && lm.length > Math.max(entry.lmPair[0], entry.lmPair[1])) {
                worldDir = lmHandDir(lm[entry.lmPair[0]], lm[entry.lmPair[1]], mx);
              }
            }
            // Fall back to FK joint-pair direction (e.g. elbow->wrist) if hand
            // landmarks weren't available this frame — keeps the wrist tracking
            // the arm even when fine hand tracking drops out. Only wrist entries
            // set both lmPair and jointFrom/jointTo; finger phalanges set only
            // lmPair (no FK position to fall back to) and just freeze instead.
            if (!worldDir && entry.jointFrom && entry.jointTo) {
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
              // Finger phalanges (lmPair set, no jointFrom fallback, no
              // restSideLocal — i.e. not the wrist) — clamp to a plausible
              // bend angle. See MAX_FINGER_BEND_RAD's comment: fingers curl
              // through a wide enough range that the live target direction
              // can end up near-antipodal to restDir, which is exactly where
              // single-vector alignment becomes numerically unstable.
              if (entry.lmPair && !entry.jointFrom && !entry.restSideLocal) {
                clampAngleFromRef(_localDir, entry.restDir, MAX_FINGER_BEND_RAD);
              }
              if (_localDir.lengthSq() > 1e-4) {
                // Wrist bones (restSideLocal/lmSidePair set): full 2-axis
                // orientation — see restSideLocal's doc comment. Everything
                // else: single-axis alignment (fine for limbs, which only
                // need "which way does this segment point", not roll).
                let usedTwoAxis = false;
                if (entry.restSideLocal && entry.lmSidePair) {
                  const lm = entry.lmHand === "L" ? dataForL : dataForR;
                  const [sa, sb] = entry.lmSidePair;
                  if (lm && lm.length > Math.max(sa, sb)) {
                    const sideWorldDir = lmHandDir(lm[sa], lm[sb], mx);
                    if (obj.parent) {
                      // _parentQ was ALREADY inverted (in place) when _localDir
                      // was converted above — apply as-is. Calling .invert()
                      // again here was a bug that un-inverted it, converting
                      // the side vector by the parent's world rotation instead
                      // of its inverse: the palm-facing twist was computed in a
                      // garbage frame (wrong by ~2x the parent's world
                      // rotation) — fine with the arm at rest, wildly wrong as
                      // soon as the arm moved. The primary axis was unaffected
                      // (it used the correctly-inverted value), which is why
                      // direction audits showed perfect alignment while the
                      // wrist visibly twisted into a pinch.
                      _localSide.copy(sideWorldDir).applyQuaternion(_parentQ);
                    } else {
                      _localSide.copy(sideWorldDir);
                    }
                    basisQuaternion(entry.restDir, entry.restSideLocal, _qRestBasis);
                    basisQuaternion(_localDir, _localSide, _qLiveBasis);
                    obj.quaternion.copy(_qLiveBasis).multiply(_qRestBasis.invert());
                    usedTwoAxis = true;
                  }
                } else if (entry.twistShareFraction !== undefined && entry.twistChildRestBasisInv) {
                  // Forearm twist-sharing — see twistShareFraction's doc
                  // comment. Swing (elbow->wrist direction) is exactly the
                  // single-axis rotation as before; on top of it, rotate
                  // around the forearm's own length axis by a FRACTION of the
                  // twist the wrist would otherwise have to absorb alone.
                  //
                  // The twist is computed exactly: q_h0 below is the local
                  // rotation the WRIST would need if the forearm applied no
                  // twist (swing-only forearm world = Wparent * qSwing; wrist
                  // target world basis from live landmarks; hand rest basis
                  // precomputed). Its twist component about the forearm axis
                  // (swing-twist decomposition) is the exact angle that, if
                  // the forearm absorbs it, leaves the wrist with only
                  // bend/flexion. Algebra: forearm = qSwing * Rot(restDir, t)
                  // changes the wrist's required local rotation to
                  // Rot(restDir, -t) * q_h0, so t = fraction * twist(q_h0)
                  // shrinks the wrist's twist by exactly that fraction.
                  _qSwing.setFromUnitVectors(entry.restDir, _localDir);
                  let st = this._twistState.get(obj);
                  if (!st) { st = { target: 0, applied: 0 }; this._twistState.set(obj, st); }
                  const lm = entry.lmHand === "L" ? dataForL : dataForR;
                  if (lm && lm.length > 17) {
                    basisQuaternion(lmHandDir(lm[0], lm[9], mx), lmHandDir(lm[5], lm[17], mx), _qHandWorld);
                    _qH0.copy(_qSwing).invert();
                    if (obj.parent) _qH0.multiply(_parentQ); // _parentQ = Wparent⁻¹ (inverted above)
                    _qH0.multiply(_qHandWorld).multiply(entry.twistChildRestBasisInv);
                    // Twist of q_h0 about the forearm axis: project the
                    // quaternion's vector part onto the axis (standard
                    // swing-twist decomposition).
                    const a = entry.restDir;
                    const proj = _qH0.x * a.x + _qH0.y * a.y + _qH0.z * a.z;
                    let theta = 2 * Math.atan2(proj, _qH0.w);
                    if (theta > Math.PI) theta -= 2 * Math.PI;
                    else if (theta < -Math.PI) theta += 2 * Math.PI;
                    // Unwrap against the previous target so a near-±180°
                    // twist doesn't flip sign frame-to-frame (a partial
                    // fraction of +179° vs -179° are very different
                    // rotations even though the full angles nearly agree).
                    while (theta - st.target > Math.PI) theta -= 2 * Math.PI;
                    while (theta - st.target < -Math.PI) theta += 2 * Math.PI;
                    st.target = THREE.MathUtils.clamp(theta, -1.5 * Math.PI, 1.5 * Math.PI);
                  }
                  // When landmarks drop out, target holds its last value —
                  // matches the wrist freezing rather than snapping untwisted.
                  const desired = st.target * entry.twistShareFraction;
                  const maxStep = TWIST_MAX_RAD_PER_S * dt;
                  st.applied += THREE.MathUtils.clamp(desired - st.applied, -maxStep, maxStep);
                  _qTwist.setFromAxisAngle(entry.restDir, st.applied);
                  obj.quaternion.copy(_qSwing).multiply(_qTwist);
                  usedTwoAxis = true;
                }
                if (!usedTwoAxis) {
                  obj.quaternion.setFromUnitVectors(entry.restDir, _localDir);
                }
                // Rate-limit the wrist's local rotation: MediaPipe's hand
                // tracker occasionally flips the whole hand orientation for a
                // frame (mislabelled palm/back, or a dropout-reacquire pop) —
                // observed in real recordings as 45-176° single-frame jumps
                // on ~1-2% of frames. Real wrist motion stays well under the
                // rate cap; a genuine instant flip catches up over a few
                // frames instead of popping.
                if (entry.restSideLocal && entry.lmSidePair) {
                  let prev = this._wristPrevQ.get(obj);
                  if (prev) {
                    const ang = prev.angleTo(obj.quaternion);
                    const maxStep = WRIST_MAX_RAD_PER_S * dt;
                    if (ang > maxStep && ang > 1e-6) {
                      _qTarget.copy(obj.quaternion);
                      obj.quaternion.copy(prev).slerp(_qTarget, maxStep / ang);
                    }
                  } else {
                    prev = new THREE.Quaternion();
                    this._wristPrevQ.set(obj, prev);
                  }
                  prev.copy(obj.quaternion);
                }
              }
              boneCount++;
            }
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

    // VRM expressions — set BEFORE vrm.update(dt) below, since that call
    // cascades into expressionManager.update() which applies whatever values
    // were just set. EXPRESSION_KEYS (mocap/types.ts) are exactly VRM 1.0's
    // expression preset names (blinkLeft/blinkRight/aa/ih/ou/ee/oh), so no
    // name-remapping is needed the way the ARKit morph-target path below
    // needs vtubeFaceMap.
    if (rules.useModelFace && expressions && model.vrm?.expressionManager) {
      for (const key of EXPRESSION_KEYS) {
        const v = expressions[key];
        if (v !== undefined) model.vrm.expressionManager.setValue(key, v);
      }
    }

    // VRM spring bones (hair/clothing physics) — humanoid.autoUpdateHumanBones
    // is off (see vrmRigAdapter.ts / RoomViewport's VRMLoaderPlugin registration),
    // so this only runs spring bones/constraints, never overriding driven bones.
    // Also applies the expression values just set above.
    if (model.vrm) model.vrm.update(dt);

    // ARKit raw-morph-target path — only for plain AI-CAD GLBs, which expose
    // raw morph targets directly rather than a VRM expressionManager.
    if (rules.useModelFace && expressions && !model.vrm) {
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
