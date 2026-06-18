import * as THREE from 'three';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { RigConfig } from '../mocap/rig';
import type { RuleFlags } from '../components/RoomViewport';
import { FACE_CONTOURS, FACE_TRIANGLES } from '../components/faceMeshData';
import { RIGHT_EYE_RING, LEFT_EYE_RING } from '../mocap/boneMap';

const FACE_W_FIT    = 0.92;
const FALLBACK_FACE_W = 0.13;

const len = (cm: number) => cm / 100;

// Module-scope temps.
const _fUp   = new THREE.Vector3();
const _fSide = new THREE.Vector3();
const _fN    = new THREE.Vector3();
const _v3a   = new THREE.Vector3();
const _v3b   = new THREE.Vector3();
const _v3c   = new THREE.Vector3();
// Face-local frame vectors — reused across the face and eye subsections.
const _faceR = new THREE.Vector3();
const _faceU = new THREE.Vector3();
const _faceF = new THREE.Vector3();
const _faceO = new THREE.Vector3();

interface SocketMesh {
  mesh: THREE.Mesh;
  geom: THREE.BufferGeometry;
  pos:  Float32Array;
}

export class FaceMeshRenderer {
  private _faceVerts:    Float32Array;
  private _facePosAttr:  THREE.BufferAttribute;
  private _faceFillGeom: THREE.BufferGeometry;
  private _matFaceFill:  THREE.MeshLambertMaterial;
  private _faceFill:     THREE.Mesh;
  private _faceLineGeom: THREE.BufferGeometry;
  private _matFaceLine:  THREE.LineBasicMaterial;
  private _faceLine:     THREE.LineSegments;

  private _socketL: SocketMesh;
  private _socketR: SocketMesh;

  private _matEye:  THREE.MeshBasicMaterial;
  private _matIris: THREE.MeshBasicMaterial;
  private _mEyeL:   THREE.Mesh;
  private _mEyeR:   THREE.Mesh;
  private _mIrisL:  THREE.Mesh;
  private _mIrisR:  THREE.Mesh;

  constructor(figure: THREE.Group) {
    this._faceVerts   = new Float32Array(468 * 3);
    this._facePosAttr = new THREE.BufferAttribute(this._faceVerts, 3);

    this._faceFillGeom = new THREE.BufferGeometry();
    this._faceFillGeom.setAttribute("position", this._facePosAttr);
    this._faceFillGeom.setIndex(new THREE.BufferAttribute(FACE_TRIANGLES, 1));
    // Stencil-tested: draws only where the eye masks did NOT write ref=1, so the
    // eye openings become smooth holes in the otherwise-solid surface.
    this._matFaceFill = new THREE.MeshLambertMaterial({
      color: 0xd9a079, side: THREE.FrontSide,
      transparent: false, opacity: 1, depthTest: true, depthWrite: true,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
    });
    this._faceFill = new THREE.Mesh(this._faceFillGeom, this._matFaceFill);
    this._faceFill.frustumCulled = false;
    this._faceFill.renderOrder = 2;
    this._faceFill.visible = false;
    figure.add(this._faceFill);

    this._faceLineGeom = new THREE.BufferGeometry();
    this._faceLineGeom.setAttribute("position", this._facePosAttr);
    this._faceLineGeom.setIndex(new THREE.BufferAttribute(FACE_CONTOURS, 1));
    this._matFaceLine = new THREE.LineBasicMaterial({
      color: 0x33586b, transparent: true, opacity: 0.7, depthTest: true, depthWrite: false,
    });
    this._faceLine = new THREE.LineSegments(this._faceLineGeom, this._matFaceLine);
    this._faceLine.frustumCulled = false;
    this._faceLine.renderOrder = 3;
    this._faceLine.visible = false;
    figure.add(this._faceLine);

    this._socketL = this._makeSocket(figure);
    this._socketR = this._makeSocket(figure);

    this._matEye  = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: true, depthWrite: true });
    this._matIris = new THREE.MeshBasicMaterial({ color: 0x223a5a, depthTest: true, depthWrite: true });
    const mkEye = (mat: THREE.Material, ro: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
      m.frustumCulled = false; m.visible = false; m.renderOrder = ro;
      figure.add(m); return m;
    };
    // renderOrder 4/5 — after the face (2) so face depth is written first.
    this._mEyeL  = mkEye(this._matEye,  4);
    this._mEyeR  = mkEye(this._matEye,  4);
    this._mIrisL = mkEye(this._matIris, 5);
    this._mIrisR = mkEye(this._matIris, 5);
  }

  private _makeSocket(figure: THREE.Group): SocketMesh {
    const pos = new Float32Array(17 * 3); // centroid + 16 ring points
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const idx: number[] = [];
    for (let k = 0; k < 16; k++) idx.push(0, 1 + k, 1 + ((k + 1) % 16));
    geom.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide, colorWrite: false, depthTest: false, depthWrite: false,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 1; mesh.visible = false;
    figure.add(mesh);
    return { mesh, geom, pos };
  }

  applySkin(hex: string): void {
    this._matFaceFill.color.set(hex);
  }

  update(
    face: NormalizedLandmark[] | null,
    headC: THREE.Vector3,
    rig: RigConfig,
    rules: RuleFlags,
    mx: number,
    pupil: { x: number; y: number } | undefined,
  ): void {
    const headR = Math.max(len(rig.headDiameterCm) * 0.65, 0.04);
    const faceVerts = this._faceVerts;

    let faceValid = false;

    if (face && face.length >= 468) {
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < 468; i++) { const p = face[i]; cx += p.x; cy += p.y; cz += p.z; }
      cx /= 468; cy /= 468; cz /= 468;

      const faceTarget = len(rig.headDiameterCm) * FACE_W_FIT * rig.faceScale;
      const faceW = Math.hypot(
        face[234].x - face[454].x, face[234].y - face[454].y, face[234].z - face[454].z,
      );
      const fScale = rules.cheekHingeNorm
        ? (faceW > 1e-4 ? faceTarget / faceW : rig.faceScale)
        : faceTarget / FALLBACK_FACE_W;

      for (let i = 0; i < 468; i++) {
        const p = face[i];
        faceVerts[i * 3]     = mx * (p.x - cx) * fScale;
        faceVerts[i * 3 + 1] = -(p.y - cy) * fScale;
        faceVerts[i * 3 + 2] = -(p.z - cz) * fScale;
      }

      const fx = headC.x + len(rig.faceOffXcm);
      const fy = headC.y + len(rig.faceOffYcm);
      const fz = headC.z + len(rig.faceOffZcm);
      this._faceFill.position.set(fx, fy, fz);
      this._faceLine.position.set(fx, fy, fz);

      const fv = (i: number, c: number) => faceVerts[i * 3 + c];
      _fUp.set(fv(10, 0) - fv(152, 0), fv(10, 1) - fv(152, 1), fv(10, 2) - fv(152, 2));
      _fSide.set(fv(454, 0) - fv(234, 0), fv(454, 1) - fv(234, 1), fv(454, 2) - fv(234, 2));
      _fN.crossVectors(_fSide, _fUp);
      if (_fN.lengthSq() > 1e-9 && _fUp.lengthSq() > 1e-9) {
        _faceF.copy(_fN).normalize();
        if (_faceF.z < 0) _faceF.multiplyScalar(-1);
        _faceU.copy(_fUp).addScaledVector(_faceF, -_fUp.dot(_faceF)).normalize();
        _faceR.crossVectors(_faceU, _faceF).normalize();
        if (_faceR.dot(_fSide) < 0) _faceR.multiplyScalar(-1);
        const shift = rules.faceFulcrum ? headR : 0;
        const sx = _faceF.x * shift, sy = _faceF.y * shift, sz = _faceF.z * shift;
        for (let i = 0; i < 468; i++) {
          faceVerts[i * 3] += sx; faceVerts[i * 3 + 1] += sy; faceVerts[i * 3 + 2] += sz;
        }
        _faceO.set(fx + sx, fy + sy, fz + sz);
        faceValid = true;

        // Pick FrontSide winding for THIS frame (mirror flips it).
        _v3a.set(fv(34, 0) - fv(127, 0), fv(34, 1) - fv(127, 1), fv(34, 2) - fv(127, 2));
        _v3b.set(fv(139, 0) - fv(127, 0), fv(139, 1) - fv(127, 1), fv(139, 2) - fv(127, 2));
        _v3c.crossVectors(_v3a, _v3b);
        this._matFaceFill.side = _v3c.dot(_faceF) >= 0 ? THREE.FrontSide : THREE.BackSide;

        this._fillSocket(this._socketL, LEFT_EYE_RING,  faceVerts);
        this._fillSocket(this._socketR, RIGHT_EYE_RING, faceVerts);
        this._socketL.mesh.position.set(fx, fy, fz);
        this._socketR.mesh.position.set(fx, fy, fz);
      }
      this._facePosAttr.needsUpdate = true;
      this._faceFillGeom.computeVertexNormals();
      this._faceFill.visible = rules.showFaceMesh;
      this._faceLine.visible = rules.showFaceMesh;
      const socketsOn = faceValid && rules.showFaceMesh && rules.showEyes;
      this._socketL.mesh.visible = socketsOn;
      this._socketR.mesh.visible = socketsOn;
    } else {
      this._faceFill.visible = false;
      this._faceLine.visible = false;
      this._socketL.mesh.visible = false;
      this._socketR.mesh.visible = false;
    }

    // ── eyeballs + gaze ───────────────────────────────────────────────────
    const eyeRm = len(rig.eyeRcm);
    const eyeXm = len(rig.eyeXcm), eyeYm = len(rig.eyeYcm), eyeZm = len(rig.eyeZcm);
    const gx = (pupil ? pupil.x : 0) * eyeRm * 0.55;
    const gy = (pupil ? pupil.y : 0) * eyeRm * 0.55;
    // faceLocalEyes off (or no face) → head-local frame whose anchor sits on
    // the FRONT SURFACE of the head sphere, so eyeZ keeps eyes on the head.
    if (!faceValid || !rules.faceLocalEyes) {
      _faceR.set(mx, 0, 0); _faceU.set(0, 1, 0); _faceF.set(0, 0, 1);
      _faceO.copy(headC).addScaledVector(_faceF, headR);
    }
    const placeEye = (eye: THREE.Mesh, iris: THREE.Mesh, sign: number) => {
      if (!rules.showEyes) { eye.visible = false; iris.visible = false; return; }
      const ep = _faceO.clone()
        .addScaledVector(_faceR, sign * eyeXm)
        .addScaledVector(_faceU, eyeYm)
        .addScaledVector(_faceF, eyeZm);
      eye.position.copy(ep); eye.scale.setScalar(eyeRm); eye.visible = true;
      iris.position.copy(ep)
        .addScaledVector(_faceR, gx)
        .addScaledVector(_faceU, gy)
        .addScaledVector(_faceF, eyeRm * 0.82);
      iris.scale.setScalar(eyeRm * 0.45); iris.visible = true;
    };
    placeEye(this._mEyeL, this._mIrisL, -1);
    placeEye(this._mEyeR, this._mIrisR,  1);
  }

  private _fillSocket(sk: SocketMesh, ring: number[], faceVerts: Float32Array): void {
    let scx = 0, scy = 0, scz = 0;
    for (let k = 0; k < 16; k++) {
      const r = ring[k];
      const x = faceVerts[r * 3], y = faceVerts[r * 3 + 1], z = faceVerts[r * 3 + 2];
      sk.pos[(k + 1) * 3] = x; sk.pos[(k + 1) * 3 + 1] = y; sk.pos[(k + 1) * 3 + 2] = z;
      scx += x; scy += y; scz += z;
    }
    sk.pos[0] = scx / 16; sk.pos[1] = scy / 16; sk.pos[2] = scz / 16;
    sk.geom.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this._matFaceFill.dispose();
    this._matFaceLine.dispose();
    this._matEye.dispose();
    this._matIris.dispose();
    this._mEyeL.geometry.dispose();
    this._mEyeR.geometry.dispose();
    this._mIrisL.geometry.dispose();
    this._mIrisR.geometry.dispose();
    this._faceFillGeom.dispose();
    this._faceLineGeom.dispose();
    for (const s of [this._socketL, this._socketR]) {
      s.geom.dispose();
      (s.mesh.material as THREE.Material).dispose();
    }
  }
}
