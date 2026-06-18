import * as THREE from 'three';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { RigConfig } from '../mocap/rig';
import type { RuleFlags } from '../components/RoomViewport';
import type { CanonicalPose } from '../mocap/worldFrame';
import { lmHandDir } from '../mocap/worldFrame';
import {
  HAND_BONES, HAND_BONE_FRAC, HAND_BONE_FINGER, HAND_BONE_R, PALM_FAN_BONES,
} from '../mocap/boneMap';

// Default rest-pose directions (figure-local space, Y-up).
// Duplicated from RoomViewport intentionally — renderer is self-contained.
// Phase 3c will consolidate when GlbBoneDriver is extracted.
const D_UP   = new THREE.Vector3(0,  1,  0);
const D_DOWN = new THREE.Vector3(0, -1,  0);
const D_X    = new THREE.Vector3(1,  0,  0);
const D_FOOT = new THREE.Vector3(0, -0.3, 1).normalize();
const D_UARM_REST_L = new THREE.Vector3(-0.45, -0.89,  0).normalize();
const D_UARM_REST_R = new THREE.Vector3( 0.45, -0.89,  0).normalize();
const D_LARM_REST_L = new THREE.Vector3(-0.28, -0.96,  0.02).normalize();
const D_LARM_REST_R = new THREE.Vector3( 0.28, -0.96,  0.02).normalize();

const LIMB_TAPER     = 0.72;
const HEAD_SPHERE_FIT = 0.72;

const len = (cm: number) => cm / 100;

// Module-scope temps — one allocation, reused every frame.
const _tv2  = new THREE.Vector3();
const _tq   = new THREE.Quaternion();
const _tY   = new THREE.Vector3(0, 1, 0);
const _tm4  = new THREE.Matrix4();
const _tpU  = new THREE.Vector3();
const _tpW  = new THREE.Vector3();
const _tpR  = new THREE.Vector3();
const _tpF  = new THREE.Vector3();
const _tpC  = new THREE.Vector3();
const _tv3a = new THREE.Vector3();
const _tv3b = new THREE.Vector3();
const _thq  = new THREE.Quaternion();

function makeCyl(mat: THREE.Material, taper = 1): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(taper, 1, 1, 14, 1), mat);
}
function makeSph(mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), mat);
}
function placeCyl(mesh: THREE.Mesh, a: THREE.Vector3 | null, b: THREE.Vector3 | null, radius: number): void {
  if (!a || !b) { mesh.visible = false; return; }
  const length = a.distanceTo(b);
  if (length < 1e-4) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  _tv2.subVectors(b, a).normalize();
  _tq.setFromUnitVectors(_tY, _tv2);
  mesh.quaternion.copy(_tq);
  mesh.scale.set(radius, length, radius);
}
function placeSph(mesh: THREE.Mesh, p: THREE.Vector3 | null, radius: number): void {
  if (!p) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.copy(p);
  mesh.scale.setScalar(radius);
}
function placeBox(
  mesh: THREE.Mesh, center: THREE.Vector3,
  x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3,
  sx: number, sy: number, sz: number,
): void {
  _tm4.makeBasis(x, y, z);
  mesh.quaternion.setFromRotationMatrix(_tm4);
  mesh.position.copy(center);
  mesh.scale.set(sx, sy, sz);
  mesh.visible = true;
}

interface HandRig {
  joints: THREE.Mesh[];
  bones: THREE.Mesh[];
  palm: THREE.Mesh;
}

export class ProceduralSkeletonRenderer {
  private _matL: THREE.MeshLambertMaterial;
  private _matR: THREE.MeshLambertMaterial;
  private _matC: THREE.MeshLambertMaterial;

  private _mHead:   THREE.Mesh;
  private _mNeck:   THREE.Mesh;
  private _mSpine:  THREE.Mesh;
  private _mSpine1: THREE.Mesh;
  private _mSpine2: THREE.Mesh;

  private _mUArmL: THREE.Mesh; private _mUArmR: THREE.Mesh;
  private _mLArmL: THREE.Mesh; private _mLArmR: THREE.Mesh;
  private _mHandL: THREE.Mesh; private _mHandR: THREE.Mesh;
  private _mULegL: THREE.Mesh; private _mULegR: THREE.Mesh;
  private _mLLegL: THREE.Mesh; private _mLLegR: THREE.Mesh;
  private _mFootL: THREE.Mesh; private _mFootR: THREE.Mesh;

  private _mJShL: THREE.Mesh; private _mJShR: THREE.Mesh;
  private _mJElL: THREE.Mesh; private _mJElR: THREE.Mesh;
  private _mJWrL: THREE.Mesh; private _mJWrR: THREE.Mesh;
  private _mJHpL: THREE.Mesh; private _mJHpR: THREE.Mesh;
  private _mJKnL: THREE.Mesh; private _mJKnR: THREE.Mesh;
  private _mJAnL: THREE.Mesh; private _mJAnR: THREE.Mesh;

  private _handLeft:  HandRig;
  private _handRight: HandRig;
  private _meshes: THREE.Mesh[];

  private _skin = new THREE.Color();
  private _blue = new THREE.Color(0x4477cc);
  private _red  = new THREE.Color(0xcc3344);

  constructor(figure: THREE.Group) {
    this._matL = new THREE.MeshLambertMaterial({ color: 0x4477cc });
    this._matR = new THREE.MeshLambertMaterial({ color: 0xcc3344 });
    this._matC = new THREE.MeshLambertMaterial({ color: 0xd4b080 });

    this._mHead   = makeSph(this._matC);
    this._mNeck   = makeCyl(this._matC);
    this._mSpine  = makeCyl(this._matC);
    this._mSpine1 = makeCyl(this._matC);
    this._mSpine2 = makeCyl(this._matC);

    this._mUArmL = makeCyl(this._matL, LIMB_TAPER); this._mUArmR = makeCyl(this._matR, LIMB_TAPER);
    this._mLArmL = makeCyl(this._matL, LIMB_TAPER); this._mLArmR = makeCyl(this._matR, LIMB_TAPER);
    this._mHandL = makeSph(this._matL);              this._mHandR = makeSph(this._matR);
    this._mULegL = makeCyl(this._matL, LIMB_TAPER); this._mULegR = makeCyl(this._matR, LIMB_TAPER);
    this._mLLegL = makeCyl(this._matL, LIMB_TAPER); this._mLLegR = makeCyl(this._matR, LIMB_TAPER);
    this._mFootL = makeCyl(this._matL, LIMB_TAPER); this._mFootR = makeCyl(this._matR, LIMB_TAPER);

    this._mJShL = makeSph(this._matL); this._mJShR = makeSph(this._matR);
    this._mJElL = makeSph(this._matL); this._mJElR = makeSph(this._matR);
    this._mJWrL = makeSph(this._matL); this._mJWrR = makeSph(this._matR);
    this._mJHpL = makeSph(this._matL); this._mJHpR = makeSph(this._matR);
    this._mJKnL = makeSph(this._matL); this._mJKnR = makeSph(this._matR);
    this._mJAnL = makeSph(this._matL); this._mJAnR = makeSph(this._matR);

    this._meshes = [
      this._mHead, this._mNeck, this._mSpine, this._mSpine1, this._mSpine2,
      this._mUArmL, this._mLArmL, this._mHandL, this._mULegL, this._mLLegL, this._mFootL,
      this._mUArmR, this._mLArmR, this._mHandR, this._mULegR, this._mLLegR, this._mFootR,
      this._mJShL,  this._mJElL,  this._mJWrL,  this._mJHpL,  this._mJKnL,  this._mJAnL,
      this._mJShR,  this._mJElR,  this._mJWrR,  this._mJHpR,  this._mJKnR,  this._mJAnR,
    ];
    for (const m of this._meshes) { m.visible = false; figure.add(m); }

    this._handLeft  = this._makeHand(this._matL, figure);
    this._handRight = this._makeHand(this._matR, figure);
  }

  private _makeHand(mat: THREE.Material, figure: THREE.Group): HandRig {
    const joints = Array.from({ length: 21 }, () => {
      const m = makeSph(mat); m.frustumCulled = false; m.visible = false; figure.add(m); return m;
    });
    const bones = Array.from({ length: HAND_BONES.length }, () => {
      const m = makeCyl(mat, 0.7); m.frustumCulled = false; m.visible = false; figure.add(m); return m;
    });
    const palm = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    palm.frustumCulled = false; palm.visible = false; figure.add(palm);
    return { joints, bones, palm };
  }

  applySkin(hex: string): void {
    this._skin.set(hex);
    this._matC.color.copy(this._skin);
    this._matL.color.copy(this._skin).lerp(this._blue, 0.25);
    this._matR.color.copy(this._skin).lerp(this._red,  0.25);
  }

  update(
    pose: CanonicalPose | null,
    legsTracked: boolean,
    rig: RigConfig,
    rules: RuleFlags,
    mx: number,
    dataForL: NormalizedLandmark[] | null,
    dataForR: NormalizedLandmark[] | null,
  ): void {
    // FK — fixed lengths from rig, directions from canonical pose.
    const hipMid   = new THREE.Vector3(0, 0, 0);
    const torsoDir = pose ? pose.shMid.clone().sub(pose.hipMid).normalize() : D_UP;
    const shMid    = hipMid.clone().addScaledVector(torsoDir, len(rig.torsoCm));
    const headDir  = pose ? pose.headC.clone().sub(pose.shMid).normalize() : D_UP;
    const headC    = shMid.clone().addScaledVector(headDir, len(rig.neckCm));

    const shAxis  = pose ? pose.shR.clone().sub(pose.shL).normalize()   : D_X;
    const hipAxis = pose ? pose.hipR.clone().sub(pose.hipL).normalize() : D_X;
    const shL  = shMid.clone().addScaledVector(shAxis,   -len(rig.shoulderWidthCm) / 2);
    const shR  = shMid.clone().addScaledVector(shAxis,    len(rig.shoulderWidthCm) / 2);
    const hipL = hipMid.clone().addScaledVector(hipAxis,  -len(rig.hipWidthCm) / 2);
    const hipR = hipMid.clone().addScaledVector(hipAxis,   len(rig.hipWidthCm) / 2);

    const elL  = shL.clone().addScaledVector(pose ? pose.elL.clone().sub(pose.shL).normalize()   : D_UARM_REST_L, len(rig.upperArmCm));
    const elR  = shR.clone().addScaledVector(pose ? pose.elR.clone().sub(pose.shR).normalize()   : D_UARM_REST_R, len(rig.upperArmCm));
    const wrL  = elL.clone().addScaledVector(pose ? pose.wrL.clone().sub(pose.elL).normalize()   : D_LARM_REST_L, len(rig.lowerArmCm));
    const wrR  = elR.clone().addScaledVector(pose ? pose.wrR.clone().sub(pose.elR).normalize()   : D_LARM_REST_R, len(rig.lowerArmCm));

    const legPose = (rules.legsRestOnLoss && !legsTracked) ? null : pose;
    const knL  = hipL.clone().addScaledVector(legPose ? legPose.knL.clone().sub(legPose.hipL).normalize() : D_DOWN, len(rig.upperLegCm));
    const knR  = hipR.clone().addScaledVector(legPose ? legPose.knR.clone().sub(legPose.hipR).normalize() : D_DOWN, len(rig.upperLegCm));
    const anL  = knL.clone().addScaledVector(legPose ? legPose.anL.clone().sub(legPose.knL).normalize()  : D_DOWN, len(rig.lowerLegCm));
    const anR  = knR.clone().addScaledVector(legPose ? legPose.anR.clone().sub(legPose.knR).normalize()  : D_DOWN, len(rig.lowerLegCm));
    const toeL = anL.clone().addScaledVector(legPose ? legPose.toeL.clone().sub(legPose.anL).normalize() : D_FOOT, len(rig.footCm));
    const toeR = anR.clone().addScaledVector(legPose ? legPose.toeR.clone().sub(legPose.anR).normalize() : D_FOOT, len(rig.footCm));

    const headR = Math.max(len(rig.headDiameterCm) * 0.65, 0.04);
    const jR    = len(rig.jointRcm);
    const spine  = hipMid.clone().lerp(shMid, 1 / 3);
    const spine1 = hipMid.clone().lerp(shMid, 2 / 3);

    placeSph(this._mHead,   headC,  headR * HEAD_SPHERE_FIT);
    placeCyl(this._mNeck,   headC,  shMid,  len(rig.neckRcm));
    placeCyl(this._mSpine,  hipMid, spine,  len(rig.torsoRcm));
    placeCyl(this._mSpine1, spine,  spine1, len(rig.torsoRcm));
    placeCyl(this._mSpine2, spine1, shMid,  len(rig.torsoRcm));

    placeCyl(this._mUArmL, shL,  elL,  len(rig.upperArmRcm)); placeCyl(this._mUArmR, shR,  elR,  len(rig.upperArmRcm));
    placeCyl(this._mLArmL, elL,  wrL,  len(rig.lowerArmRcm)); placeCyl(this._mLArmR, elR,  wrR,  len(rig.lowerArmRcm));
    placeCyl(this._mULegL, hipL, knL,  len(rig.upperLegRcm)); placeCyl(this._mULegR, hipR, knR,  len(rig.upperLegRcm));
    placeCyl(this._mLLegL, knL,  anL,  len(rig.lowerLegRcm)); placeCyl(this._mLLegR, knR,  anR,  len(rig.lowerLegRcm));
    placeCyl(this._mFootL, anL,  toeL, len(rig.footRcm));     placeCyl(this._mFootR, anR,  toeR, len(rig.footRcm));

    placeSph(this._mJShL, shL,  jR); placeSph(this._mJShR, shR,  jR);
    placeSph(this._mJElL, elL,  jR); placeSph(this._mJElR, elR,  jR);
    placeSph(this._mJWrL, wrL,  jR); placeSph(this._mJWrR, wrR,  jR);
    placeSph(this._mJHpL, hipL, jR); placeSph(this._mJHpR, hipR, jR);
    placeSph(this._mJKnL, knL,  jR); placeSph(this._mJKnR, knR,  jR);
    placeSph(this._mJAnL, anL,  jR); placeSph(this._mJAnR, anR,  jR);

    // Hands — FK fingers or fist fallback sphere.
    const fist = (wr: THREE.Vector3, el: THREE.Vector3): THREE.Vector3 =>
      wr.clone().addScaledVector(_tv2.subVectors(wr, el).normalize(), 0.03);
    const handLenM = len(rig.handLengthCm);
    const handR    = len(rig.handRcm);

    const lFingers = this._updateHand(this._handLeft,  rules.fingerFK ? dataForL : null, wrL, elL, mx, rig, handLenM);
    const rFingers = this._updateHand(this._handRight, rules.fingerFK ? dataForR : null, wrR, elR, mx, rig, handLenM);
    placeSph(this._mHandL, lFingers ? null : fist(wrL, elL), handR);
    placeSph(this._mHandR, rFingers ? null : fist(wrR, elR), handR);
  }

  private _updateHand(
    hr: HandRig,
    lm: NormalizedLandmark[] | null,
    wrist: THREE.Vector3,
    elbow: THREE.Vector3,
    mx: number,
    rig: RigConfig,
    handLenM: number,
  ): boolean {
    if (!lm || lm.length < 21) {
      for (const j of hr.joints) j.visible = false;
      for (const b of hr.bones) b.visible = false;
      hr.palm.visible = false;
      return false;
    }
    const fingerMul = [
      rig.fingerThumb, rig.fingerIndex, rig.fingerMiddle, rig.fingerRing, rig.fingerLittle,
    ];
    const jp: THREE.Vector3[] = new Array(21);
    jp[0] = wrist.clone();
    for (let k = 0; k < 20; k++) {
      const [a, b] = HAND_BONES[k];
      const d = lmHandDir(lm[a], lm[b], mx);
      const fi = HAND_BONE_FINGER[k];
      const mul = fi >= 0 ? fingerMul[fi] : 1;
      jp[b] = jp[a].clone().addScaledVector(d, HAND_BONE_FRAC[k] * mul * handLenM);
    }
    // Orient the hand along the forearm (elbow→wrist) so it continues the arm.
    _tv3a.subVectors(jp[9], jp[0]);
    _tv3b.subVectors(wrist, elbow);
    if (_tv3a.lengthSq() > 1e-9 && _tv3b.lengthSq() > 1e-9) {
      _thq.setFromUnitVectors(_tv3a.normalize(), _tv3b.normalize());
      for (let i = 1; i < 21; i++) jp[i].sub(jp[0]).applyQuaternion(_thq).add(jp[0]);
    }
    const baseFingerR = Math.max(len(rig.fingerRcm), 0.004);
    for (let k = 0; k < 20; k++) {
      if (PALM_FAN_BONES.has(k)) { hr.bones[k].visible = false; continue; }
      const [a, b] = HAND_BONES[k];
      placeCyl(hr.bones[k], jp[a], jp[b], baseFingerR * HAND_BONE_R[k]);
    }
    hr.bones[20].visible = false;
    for (let i = 0; i < 21; i++) placeSph(hr.joints[i], jp[i], baseFingerR * 0.78);

    // Palm box spanning wrist → knuckle row.
    const knuckleMid = jp[5].clone().add(jp[9]).add(jp[13]).add(jp[17]).multiplyScalar(0.25);
    _tpU.subVectors(knuckleMid, jp[0]);
    _tpW.subVectors(jp[5], jp[17]);
    const palmLen = _tpU.length(), palmW = _tpW.length();
    if (palmLen > 1e-4 && palmW > 1e-4) {
      _tpU.normalize();
      _tpR.copy(_tpW).addScaledVector(_tpU, -_tpW.dot(_tpU)).normalize();
      _tpF.crossVectors(_tpR, _tpU).normalize();
      _tpC.addVectors(jp[0], knuckleMid).multiplyScalar(0.5);
      placeBox(hr.palm, _tpC, _tpR, _tpU, _tpF, palmW * 1.08, palmLen * 1.05, len(rig.palmRcm) * 2);
    } else {
      hr.palm.visible = false;
    }
    return true;
  }

  dispose(): void {
    this._matL.dispose();
    this._matR.dispose();
    this._matC.dispose();
    for (const m of this._meshes) m.geometry.dispose();
    for (const h of [this._handLeft, this._handRight]) {
      for (const j of h.joints) j.geometry.dispose();
      for (const b of h.bones) b.geometry.dispose();
      h.palm.geometry.dispose();
    }
  }
}
