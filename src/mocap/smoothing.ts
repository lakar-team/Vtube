import { OneEuroFilter, type OneEuroParams } from "./oneEuroFilter";
import {
  ARM_KEYS,
  EXPRESSION_KEYS,
  type EulerRotation,
  type MocapFrame,
} from "./types";

/**
 * Tunable smoothing parameters, grouped by signal type.
 *
 * These defaults were chosen for a ~30 fps webcam pipeline:
 * - rotations: enough smoothing to kill resting jitter without making head
 *   turns feel laggy.
 * - expressions: slightly snappier (blinks are fast; over-smoothing a blink
 *   makes the avatar look sleepy because the blink never reaches 1.0).
 * - pupil: gaze is tiny and noisy, so it gets the heaviest smoothing.
 *
 * If the avatar feels laggy: raise minCutoff and/or beta.
 * If the avatar jitters at rest: lower minCutoff.
 */
export const SMOOTHING_PARAMS = {
  rotation: { minCutoff: 1.0, beta: 0.6, dCutoff: 1.0 } satisfies OneEuroParams,
  expression: { minCutoff: 2.0, beta: 0.8, dCutoff: 1.0 } satisfies OneEuroParams,
  pupil: { minCutoff: 0.8, beta: 0.4, dCutoff: 1.0 } satisfies OneEuroParams,
};

/**
 * A keyed bank of One Euro filters. Every scalar channel (head.x, blinkLeft,
 * leftUpperArm.z, ...) gets its own filter instance, created lazily.
 */
export class FilterBank {
  private filters = new Map<string, OneEuroFilter>();

  value(key: string, params: OneEuroParams, raw: number, t: number): number {
    let f = this.filters.get(key);
    if (!f) {
      f = new OneEuroFilter(params);
      this.filters.set(key, f);
    }
    return f.filter(raw, t);
  }

  resetAll(): void {
    for (const f of this.filters.values()) f.reset();
  }
}

function smoothEuler(
  bank: FilterBank,
  key: string,
  e: EulerRotation,
  t: number,
  params: OneEuroParams,
): EulerRotation {
  return {
    x: bank.value(`${key}.x`, params, e.x, t),
    y: bank.value(`${key}.y`, params, e.y, t),
    z: bank.value(`${key}.z`, params, e.z, t),
  };
}

/**
 * Smooth every channel of a (calibrated) mocap frame.
 * Runs between calibration and the VRM rig update.
 */
export function smoothFrame(bank: FilterBank, frame: MocapFrame): MocapFrame {
  const t = frame.t;
  const out: MocapFrame = {
    ...frame,
    head: smoothEuler(bank, "head", frame.head, t, SMOOTHING_PARAMS.rotation),
    spine: smoothEuler(bank, "spine", frame.spine, t, SMOOTHING_PARAMS.rotation),
    pupil: {
      x: bank.value("pupil.x", SMOOTHING_PARAMS.pupil, frame.pupil.x, t),
      y: bank.value("pupil.y", SMOOTHING_PARAMS.pupil, frame.pupil.y, t),
    },
    expressions: { ...frame.expressions },
    arms: { ...frame.arms },
  };

  for (const k of EXPRESSION_KEYS) {
    out.expressions[k] = bank.value(
      `expr.${k}`,
      SMOOTHING_PARAMS.expression,
      frame.expressions[k],
      t,
    );
  }

  for (const k of ARM_KEYS) {
    out.arms[k] = smoothEuler(
      bank,
      `arm.${k}`,
      frame.arms[k],
      t,
      SMOOTHING_PARAMS.rotation,
    );
  }

  return out;
}
