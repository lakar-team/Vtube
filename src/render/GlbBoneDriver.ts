import * as THREE from 'three';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { RigConfig } from '../mocap/rig';
import type { RuleFlags } from '../components/RoomViewport';
import { worldDirToBoneLocal, lmHandDir } from '../mocap/worldFrame';
import { FINGER_LM_PAIRS, FINGER_BONES_L, FINGER_BONES_R } from '../mocap/boneMap';

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

export interface LoadedModel {
  group:          THREE.Group;
  bones:          Map<string, THREE.Bone>;
  boneMap:        Record<string, string>;
  hipsLocalY:     number;
  boneRestDirs:   Map<string, THREE.Vector3>;
  skeletonHelper: THREE.SkeletonHelper;
  /** "arkit" | "custom" | undefined — blendshape convention exported by vtube tools. */
  vtubeFaceMode:  string | undefined;
  /** ARKit name → morph target name, used when vtubeFaceMode === "custom". */
  vtubeFaceMap:   Record<string, string> | undefined;
}

const D_UP   = new THREE.Vector3(0,  1, 0);
const D_DOWN = new THREE.Vector3(0, -1, 0);
const D_FOOT = new THREE.Vector3(0, -0.3, 1).normalize();
const D_UARM_REST_L = new THREE.Vector3(-0.45, -0.89, 0).normalize();
const D_UARM_REST_R = new THREE.Vector3( 0.45, -0.89, 0).normalize();
const D_LARM_REST_L = new THREE.Vector3(-0.28, -0.96, 0.02).normalize();
const D_LARM_REST_R = new THREE.Vector3( 0.28, -0.96, 0.02).normalize();

const _bDir       = new THREE.Vector3();
const _bYup       = new THREE.Vector3(0, 1, 0);
const _qTorsoFull = new THREE.Quaternion();
const _qSpinePart = new THREE.Quaternion();
const _qIdent     = new THREE.Quaternion();
const _spineD     = new THREE.Vector3();
const _fingerD    = new THREE.Vector3();
const _wristDir   = new THREE.Vector3();

const len = (cm: number) => cm / 100;

export class GlbBoneDriver {
  private _debugLogged = new Set<string>();

  update(
    model: LoadedModel,
    figurePosition: THREE.Vector3,
    fk: FKPositions,
    rig: RigConfig,
    rules: RuleFlags,
    mx: number,
    dataForL: NormalizedLandmark[] | null,
    dataForR: NormalizedLandmark[] | null,
    expressions: Record<string, number> | undefined,
  ): void {
    model.group.position.set(
      figurePosition.x,
      figurePosition.y - model.hipsLocalY,
      figurePosition.z,
    );

    if (rules.pauseBoneDriving) return;

    let boneCount = 0;

    const driveBoneByDir = (joint: string, worldDir: THREE.Vector3) => {
      if (boneCount >= rules.driveBonesUpTo) return;
      const bName = model.boneMap[joint];
      const bone = bName ? model.bones.get(bName) : undefined;
      if (!bone) return;
      boneCount++;
      const restDir = model.boneRestDirs.get(bName) ?? _bYup;
      if (!this._debugLogged.has(bone.name)) {
        this._debugLogged.add(bone.name);
        const parentWorldQ = new THREE.Quaternion();
        if (bone.parent) (bone.parent as THREE.Object3D).getWorldQuaternion(parentWorldQ);
        const localDir = worldDir.clone().applyQuaternion(parentWorldQ.clone().invert()).normalize();
        if (isNaN(localDir.x) || localDir.lengthSq() < 0.001) {
          console.warn(`[GlbBoneDriver] bad localDir for ${bone.name}:`, localDir, 'targetWorldDir:', worldDir, 'parentWorldQ:', parentWorldQ);
        }
        console.log(`[GlbBoneDriver] ${bone.name}: restDir=${restDir.toArray().map(n => n.toFixed(2))}, localDir=${localDir.toArray().map(n => n.toFixed(2))}`);
      }
      bone.quaternion.copy(worldDirToBoneLocal(worldDir, bone, restDir));
      bone.updateMatrix();
      if (bone.parent) {
        bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
      } else {
        bone.matrixWorld.copy(bone.matrix);
      }
    };
    const driveBone = (
      joint: string,
      a: THREE.Vector3 | null,
      b: THREE.Vector3 | null,
      fallback: THREE.Vector3,
    ) => {
      const d = (a && b && _bDir.subVectors(b, a).lengthSq() > 1e-8)
        ? _bDir.subVectors(b, a).normalize()
        : fallback;
      driveBoneByDir(joint, d);
    };

    model.group.updateMatrixWorld(true);

    const { torsoDir, shMid, headC, headDir, shL, shR, hipL, hipR, elL, elR, wrL, wrR, knL, knR, anL, anR, toeL, toeR } = fk;

    _qTorsoFull.setFromUnitVectors(_bYup, torsoDir);
    _qSpinePart.slerpQuaternions(_qIdent, _qTorsoFull, 0.20);
    driveBoneByDir("mixamorigSpine",  _spineD.copy(_bYup).applyQuaternion(_qSpinePart));
    _qSpinePart.slerpQuaternions(_qIdent, _qTorsoFull, 0.55);
    driveBoneByDir("mixamorigSpine1", _spineD.copy(_bYup).applyQuaternion(_qSpinePart));
    driveBoneByDir("mixamorigSpine2", torsoDir);

    driveBone("mixamorigNeck", shMid, headC, D_UP);
    driveBone("mixamorigHead", headC, headC.clone().addScaledVector(headDir, len(rig.headDiameterCm) * 0.5), headDir);

    driveBone("mixamorigLeftShoulder",  shMid, shL, D_UARM_REST_L);
    driveBone("mixamorigRightShoulder", shMid, shR, D_UARM_REST_R);

    driveBone("mixamorigLeftArm",      shL, elL, D_UARM_REST_L);
    driveBone("mixamorigRightArm",     shR, elR, D_UARM_REST_R);
    driveBone("mixamorigLeftForeArm",  elL, wrL, D_LARM_REST_L);
    driveBone("mixamorigRightForeArm", elR, wrR, D_LARM_REST_R);
    // Hand bones: clamp elbow→wrist to ≤90° from shoulder→elbow.
    _bDir.subVectors(elL, shL).normalize();
    _wristDir.subVectors(wrL, elL);
    if (_wristDir.lengthSq() > 1e-9) {
      _wristDir.normalize();
      const angL = Math.acos(Math.max(-1, Math.min(1, _bDir.dot(_wristDir))));
      if (angL > Math.PI / 2) _wristDir.lerpVectors(_bDir, _wristDir, (Math.PI / 2) / angL).normalize();
      driveBoneByDir("mixamorigLeftHand", _wristDir);
    } else {
      driveBoneByDir("mixamorigLeftHand", D_LARM_REST_L);
    }
    _bDir.subVectors(elR, shR).normalize();
    _wristDir.subVectors(wrR, elR);
    if (_wristDir.lengthSq() > 1e-9) {
      _wristDir.normalize();
      const angR = Math.acos(Math.max(-1, Math.min(1, _bDir.dot(_wristDir))));
      if (angR > Math.PI / 2) _wristDir.lerpVectors(_bDir, _wristDir, (Math.PI / 2) / angR).normalize();
      driveBoneByDir("mixamorigRightHand", _wristDir);
    } else {
      driveBoneByDir("mixamorigRightHand", D_LARM_REST_R);
    }

    driveBone("mixamorigLeftUpLeg",  hipL, knL,  D_DOWN);
    driveBone("mixamorigRightUpLeg", hipR, knR,  D_DOWN);
    driveBone("mixamorigLeftLeg",    knL,  anL,  D_DOWN);
    driveBone("mixamorigRightLeg",   knR,  anR,  D_DOWN);
    driveBone("mixamorigLeftFoot",   anL,  toeL, D_FOOT);
    driveBone("mixamorigRightFoot",  anR,  toeR, D_FOOT);

    const driveFingers = (lm: NormalizedLandmark[] | null, names: readonly string[]) => {
      if (!lm || lm.length < 21) return;
      for (let f = 0; f < 15; f++) {
        const [ia, ib] = FINGER_LM_PAIRS[f];
        _fingerD.copy(lmHandDir(lm[ia], lm[ib], mx));
        if (_fingerD.lengthSq() < 1e-9) continue;
        driveBoneByDir(names[f], _fingerD.normalize());
      }
    };
    driveFingers(dataForL, FINGER_BONES_L);
    driveFingers(dataForR, FINGER_BONES_R);

    model.group.traverse((obj) => {
      if (obj instanceof THREE.SkinnedMesh) obj.skeleton.update();
    });
    if (model.skeletonHelper.visible) model.skeletonHelper.update();

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
