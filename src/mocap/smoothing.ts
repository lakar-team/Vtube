import { OneEuroFilter, type OneEuroParams } from "./oneEuroFilter";
import {
  ALL_EXPRESSION_KEYS,
  ARM_KEYS,
  FINGER_SEGMENTS,
  LEG_KEYS,
  type EulerRotation,
  type HandRotations,
  type MocapFrame,
} from "./types";
import { clamp } from "../utils/math";

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
  // Torso pitch (bowing) moves the whole upper body, so resting noise here is
  // far more visible than on any other channel — much lower cutoff than the
  // generic rotation params, with beta still letting a deliberate bow through.
  spinePitch: { minCutoff: 0.3, beta: 0.4, dCutoff: 1.0 } satisfies OneEuroParams,
  expression: { minCutoff: 2.0, beta: 0.8, dCutoff: 1.0 } satisfies OneEuroParams,
  pupil: { minCutoff: 0.8, beta: 0.4, dCutoff: 1.0 } satisfies OneEuroParams,
  // Fingers move fast (taps, gestures) but webcam hand landmarks are noisy —
  // a touch snappier than body rotation smoothing.
  finger: { minCutoff: 1.2, beta: 0.7, dCutoff: 1.0 } satisfies OneEuroParams,
  // Hip translation: heavy smoothing — it moves the whole model, so jitter
  // here reads as the avatar vibrating on the spot.
  hipsPosition: { minCutoff: 0.5, beta: 0.3, dCutoff: 1.0 } satisfies OneEuroParams,
};

/**
 * Max angular speed (rad/s) let through per channel, applied AFTER the One
 * Euro filters. One Euro is built to let fast motion through (that's its
 * selling point), which is exactly wrong for the single-frame spikes
 * MediaPipe produces when a hand near the lens occludes its own arm — a
 * 90°-in-one-frame arm snap is never real motion. The limits are high enough
 * that genuine fast gestures pass untouched; only physically impossible jumps
 * get spread over a few frames.
 *
 * Previous values (arm: 9, wrist: 11) capped a quick 90° arm lift (1.57 rad)
 * at only 1.57 / 9 * 30fps = 5 frames = 167ms of artificial lag. Raised to
 * allow a fast arm-to-face raise (~1.5 rad in ~0.15s = 10 rad/s real) through
 * cleanly. A genuine MediaPipe spike (90° in one frame at 30fps = 47 rad/s)
 * is still capped well below the limit.
 */
export const SLEW_LIMITS = {
  arm: 15,
  wrist: 18,
} as const;

/**
 * A keyed bank of One Euro filters. Every scalar channel (head.x, blinkLeft,
 * leftUpperArm.z, ...) gets its own filter instance, created lazily.
 * Also hosts the slew-limiter state (see SLEW_LIMITS) so one resetAll()
 * clears both when calibration offsets jump.
 */
export class FilterBank {
  private filters = new Map<string, OneEuroFilter>();
  private slewPrev = new Map<string, { v: number; t: number }>();

  value(key: string, params: OneEuroParams, raw: number, t: number): number {
    let f = this.filters.get(key);
    if (!f) {
      f = new OneEuroFilter(params);
      this.filters.set(key, f);
    }
    return f.filter(raw, t);
  }

  /** Clamp the per-second rate of change of a channel. */
  slew(key: string, v: number, t: number, maxRate: number): number {
    const p = this.slewPrev.get(key);
    let out = v;
    if (p && t > p.t) {
      const maxStep = maxRate * (t - p.t);
      out = clamp(v, p.v - maxStep, p.v + maxStep);
    }
    if (p) {
      p.v = out;
      p.t = t;
    } else {
      this.slewPrev.set(key, { v: out, t });
    }
    return out;
  }

  resetAll(): void {
    for (const f of this.filters.values()) f.reset();
    this.slewPrev.clear();
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

function smoothHand(
  bank: FilterBank,
  side: "left" | "right",
  hand: HandRotations | null,
  t: number,
): HandRotations | null {
  if (!hand) return null;
  const out: HandRotations = {};
  for (const segment of FINGER_SEGMENTS) {
    const rot = hand[segment];
    if (!rot) continue;
    out[segment] = smoothEuler(bank, `hand.${side}.${segment}`, rot, t, SMOOTHING_PARAMS.finger);
  }
  return out;
}

/**
 * Soft deadzone for torso pitch (bowing).
 *
 * Both bow estimators jitter a few degrees around upright, and the hybrid
 * selector takes whichever magnitude is LARGER — at rest that's pure noise
 * bias away from zero, which read as constant tiny nodding. Inside the
 * deadzone the output is exactly 0; between the deadzone and the knee the
 * value ramps in with a smoothstep (C1 — no pop when crossing the edge);
 * past the knee it passes through UNTOUCHED, so a deliberate bow registers
 * at full depth. Applied to the CALIBRATED pitch (zero = the user's actual
 * upright), before its One Euro filter.
 */
export const SPINE_PITCH_DEADZONE = 0.07; // rad (~4°): pure postural sway
export const SPINE_PITCH_KNEE = 0.22; // rad (~12.6°): clearly bowing

function spinePitchDeadzone(x: number): number {
  const m = Math.abs(x);
  if (m <= SPINE_PITCH_DEADZONE) return 0;
  if (m >= SPINE_PITCH_KNEE) return x;
  const t = (m - SPINE_PITCH_DEADZONE) / (SPINE_PITCH_KNEE - SPINE_PITCH_DEADZONE);
  return x * t * t * (3 - 2 * t);
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
    spine: {
      x: bank.value(
        "spine.x",
        SMOOTHING_PARAMS.spinePitch,
        spinePitchDeadzone(frame.spine.x),
        t,
      ),
      y: bank.value("spine.y", SMOOTHING_PARAMS.rotation, frame.spine.y, t),
      z: bank.value("spine.z", SMOOTHING_PARAMS.rotation, frame.spine.z, t),
    },
    pupil: {
      x: bank.value("pupil.x", SMOOTHING_PARAMS.pupil, frame.pupil.x, t),
      y: bank.value("pupil.y", SMOOTHING_PARAMS.pupil, frame.pupil.y, t),
    },
    expressions: { ...frame.expressions },
    arms: { ...frame.arms },
    legs: { ...frame.legs },
    hips: {
      rotation: smoothEuler(bank, "hips.rot", frame.hips.rotation, t, SMOOTHING_PARAMS.rotation),
      position: {
        x: bank.value("hips.pos.x", SMOOTHING_PARAMS.hipsPosition, frame.hips.position.x, t),
        y: bank.value("hips.pos.y", SMOOTHING_PARAMS.hipsPosition, frame.hips.position.y, t),
        z: bank.value("hips.pos.z", SMOOTHING_PARAMS.hipsPosition, frame.hips.position.z, t),
      },
    },
    hands: { ...frame.hands },
  };

  for (const k of ALL_EXPRESSION_KEYS) {
    out.expressions[k] = bank.value(
      `expr.${k}`,
      SMOOTHING_PARAMS.expression,
      frame.expressions[k],
      t,
    );
  }

  for (const k of ARM_KEYS) {
    const e = smoothEuler(bank, `arm.${k}`, frame.arms[k], t, SMOOTHING_PARAMS.rotation);
    out.arms[k] = {
      x: bank.slew(`arm.${k}.x`, e.x, t, SLEW_LIMITS.arm),
      y: bank.slew(`arm.${k}.y`, e.y, t, SLEW_LIMITS.arm),
      z: bank.slew(`arm.${k}.z`, e.z, t, SLEW_LIMITS.arm),
    };
  }

  for (const k of LEG_KEYS) {
    out.legs[k] = smoothEuler(
      bank,
      `leg.${k}`,
      frame.legs[k],
      t,
      SMOOTHING_PARAMS.rotation,
    );
  }

  out.hands.left = smoothHand(bank, "left", frame.hands.left, t);
  out.hands.right = smoothHand(bank, "right", frame.hands.right, t);
  out.hands.leftWrist = frame.hands.leftWrist
    ? slewEuler(
        bank,
        "wrist.left",
        smoothEuler(bank, "wrist.left", frame.hands.leftWrist, t, SMOOTHING_PARAMS.rotation),
        t,
        SLEW_LIMITS.wrist,
      )
    : null;
  out.hands.rightWrist = frame.hands.rightWrist
    ? slewEuler(
        bank,
        "wrist.right",
        smoothEuler(bank, "wrist.right", frame.hands.rightWrist, t, SMOOTHING_PARAMS.rotation),
        t,
        SLEW_LIMITS.wrist,
      )
    : null;

  return out;
}

function slewEuler(
  bank: FilterBank,
  key: string,
  e: EulerRotation,
  t: number,
  maxRate: number,
): EulerRotation {
  return {
    x: bank.slew(`${key}.x`, e.x, t, maxRate),
    y: bank.slew(`${key}.y`, e.y, t, maxRate),
    z: bank.slew(`${key}.z`, e.z, t, maxRate),
  };
}
