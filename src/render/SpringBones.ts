import * as THREE from 'three';

const _qErr  = new THREE.Quaternion();
const _axis  = new THREE.Vector3();
const _dQ    = new THREE.Quaternion();

export class SpringBoneSimulator {
  private _angVels = new Map<string, THREE.Vector3>();

  /** Advance one spring bone by dt seconds toward restQ. Mutates bone.quaternion. */
  step(
    bone: THREE.Bone,
    restQ: THREE.Quaternion,
    stiffness: number,
    damping: number,
    dt: number,
  ): void {
    let vel = this._angVels.get(bone.uuid);
    if (!vel) { vel = new THREE.Vector3(); this._angVels.set(bone.uuid, vel); }

    // q_err = current^-1 * rest: right-multiply brings current → rest
    _qErr.multiplyQuaternions(
      new THREE.Quaternion(-bone.quaternion.x, -bone.quaternion.y, -bone.quaternion.z, bone.quaternion.w),
      restQ,
    ).normalize();

    const w = Math.min(1, Math.abs(_qErr.w));
    const angle = 2 * Math.acos(w);
    if (angle > 1e-4) {
      const sinHalf = Math.sqrt(Math.max(0, 1 - w * w));
      const sign = _qErr.w >= 0 ? 1 : -1;
      _axis.set(_qErr.x / sinHalf * sign, _qErr.y / sinHalf * sign, _qErr.z / sinHalf * sign);
      vel.addScaledVector(_axis, angle * stiffness * 30 * dt);
    }

    vel.multiplyScalar(Math.max(0, 1 - damping * 8 * dt));

    const speed = vel.length();
    if (speed * dt > 1e-5) {
      _dQ.setFromAxisAngle(_axis.copy(vel).normalize(), speed * dt);
      bone.quaternion.multiply(_dQ).normalize();
    }
  }

  reset(): void { this._angVels.clear(); }
}
