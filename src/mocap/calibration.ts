import {
  ALL_EXPRESSION_KEYS,
  ARM_KEYS,
  LEG_KEYS,
  zeroEuler,
  zeroExpressions,
  zeroLegs,
  type ArmKey,
  type ArmRotations,
  type EulerRotation,
  type ExpressionValues,
  type LegRotations,
  type MocapFrame,
  type PitchCalibration,
} from "./types";
import { apparentSizePitchMag } from "./kalidokitAdapter";
import { clamp } from "../utils/math";

/**
 * Calibration.
 *
 * FACE ("sit relaxed, look at the camera"): nobody sits perfectly straight
 * and centered, and no two webcams are mounted at the same angle. We record
 * ~2 s of frames, average them, and:
 * 1. The averaged head/pupil rotations become zero-offsets.
 * 2. The averaged expression values become per-channel baselines, and
 *    subsequent values are renormalized to use the remaining range:
 *        v' = (v - baseline) / (1 - baseline)
 *    e.g. if your resting face reads jawOpen = 0.15, the avatar's mouth now
 *    rests fully closed and still reaches 1.0 when you open wide.
 *
 * BODY: a guided pose sequence. The AVATAR demonstrates each pose on screen
 * and the user copies it; each pose has a countdown to get into position,
 * then a ~2 s capture, and can be skipped (no room / can't hold it).
 *
 * Why no T-pose anymore: it needs arm-span room most desk users don't have,
 * and it calibrated the WRONG neighborhood. Offsets here are an additive
 * euler correction (out = measured - offset), which is only locally valid —
 * Kalidokit's arm solve is highly nonlinear, so a bias measured with arms
 * horizontal is the wrong bias for arms hanging at your sides, i.e. for the
 * pose the user is actually in 95% of the time. That mismatch is what made
 * the resting avatar sit "funky" even with stable tracking. The new NEUTRAL
 * pose anchors every offset and reference (spine, hips rotation AND the hip
 * translation origin, legs, upright torso ratio) at the user's real
 * sitting/standing posture, so the default alignment is exact by
 * construction; the RAISE pose adds a second arm anchor mid-range; the BOW
 * pose measures how far each torso-pitch estimator actually swings for a
 * known ~30° bow and stores per-user gains.
 *
 * Expected solver outputs per pose (EXPECTED_ARMS below) were derived from
 * Kalidokit's calcArms source (findRotation / angleBetween3DCoords /
 * rigArm): for a pose at drop-angle θ from horizontal, upper-arm
 * z = ∓2.3·θ/π, y = ±(π−θ_shoulder)/π·π, x = atan2(Δx, Δz)-based. The
 * derivation reproduces the empirically-tuned RELAXED_UPPER_ARM_Z (±1.2 vs
 * derived ±1.15) which is the validation that the signs are right. Two
 * channels are degenerate and excluded:
 * - upper-arm x with arms hanging straight down (atan2(≈0, ≈0) noise) — x
 *   offsets come from the raise pose only;
 * - everything about arms pointed AT the camera — the image-plane projection
 *   collapses, which is why there is no "reach forward" pose: the solver
 *   physically can't measure it (its output for reach-forward is the same as
 *   arms-down plus noise).
 */

export const CALIBRATION_DURATION_MS = 2000;
export const POSE_COUNTDOWN_MS = 5000;

export type CalibrationMode = "face" | "body";

// ---------------------------------------------------------------------------
// Body pose sequence definitions

export type BodyPoseId =
  | "neutral"
  | "raise"
  | "bow"
  | "hips"
  | "overhead"
  | "salute"
  | "cross";

export interface CalibrationPoseDef {
  id: BodyPoseId;
  title: string;
  instruction: string;
  /**
   * What the avatar demonstrates, in rig-input space (Kalidokit euler
   * convention, the same space live mocap rotations are in before the
   * per-model VRM0/VRM1 sign mapping — see applyMocapToVRM.rotateBone).
   * Only sign-safe channels are used (arm z drop, spine x pitch), which
   * render correctly on both VRM versions through the same path as live
   * tracking.
   */
  demo: { spine: EulerRotation; arms: ArmRotations };
}

/** Relaxed arms-at-sides drop, rig-space (matches vrm RELAXED_UPPER_ARM_Z). */
const RELAX_Z = 1.2;
/** Demonstrated raise pose: arms 45° below horizontal ("gentle A"). */
const RAISE_Z = Math.PI / 4;
/** Demonstrated bow: ~30° forward lean (negative pitch = bowing). */
export const BOW_DEMO_PITCH = Math.PI / 6;

function demoArms(leftZ: number): ArmRotations {
  return {
    leftUpperArm: { x: 0, y: 0, z: leftZ },
    leftLowerArm: zeroEuler(),
    rightUpperArm: { x: 0, y: 0, z: -leftZ },
    rightLowerArm: zeroEuler(),
  };
}

/** Demonstrated "hands on hips": upper arms near horizontal, elbows out. */
const HIPS_Z = 0.3;
/** Demonstrated overhead: upper arms raised about 45° above horizontal. */
const OVERHEAD_Z = -0.6;

export const BODY_POSE_SEQUENCE: CalibrationPoseDef[] = [
  {
    id: "neutral",
    title: "Relax",
    instruction:
      "Sit or stand the way you normally do, arms hanging relaxed at your sides.",
    demo: { spine: zeroEuler(), arms: demoArms(RELAX_Z) },
  },
  {
    id: "raise",
    title: "Half raise",
    instruction:
      "Raise both arms out and down at about 45°, like the avatar — a gentle, narrow A shape.",
    demo: { spine: zeroEuler(), arms: demoArms(RAISE_Z) },
  },
  {
    id: "bow",
    title: "Bow",
    instruction: "Lean your upper body forward about 30°, like the avatar.",
    demo: { spine: { x: -BOW_DEMO_PITCH, y: 0, z: 0 }, arms: demoArms(RELAX_Z) },
  },
  {
    id: "hips",
    title: "Hands on hips",
    instruction:
      "Rest both hands on your hips with elbows pointing out to the sides, like the avatar.",
    demo: {
      spine: zeroEuler(),
      arms: {
        leftUpperArm:  { x: 0, y: 0, z: HIPS_Z },
        leftLowerArm:  { x: 0, y: 0, z: 1.2 },  // forearm bends down toward hip
        rightUpperArm: { x: 0, y: 0, z: -HIPS_Z },
        rightLowerArm: { x: 0, y: 0, z: -1.2 },
      },
    },
  },
  {
    id: "overhead",
    title: "Arms raised",
    instruction:
      "Raise both arms above your head with elbows roughly straight, like the avatar.",
    demo: {
      spine: zeroEuler(),
      arms: {
        leftUpperArm:  { x: 0, y: 0, z: OVERHEAD_Z },
        leftLowerArm:  zeroEuler(),
        rightUpperArm: { x: 0, y: 0, z: -OVERHEAD_Z },
        rightLowerArm: zeroEuler(),
      },
    },
  },
  {
    id: "salute",
    title: "Salute",
    instruction:
      "Bring one hand up to your forehead in a salute, other arm relaxed at your side.",
    demo: {
      spine: zeroEuler(),
      arms: {
        // Avatar's left arm salutes (user raises their right arm in mirror mode).
        leftUpperArm:  { x: 0, y: -0.4, z: 0.2 },  // near-horizontal, angled forward
        leftLowerArm:  { x: 0, y: 0, z: -1.3 },     // forearm bends up toward head
        rightUpperArm: { x: 0, y: 0, z: -RELAX_Z }, // right arm relaxed
        rightLowerArm: zeroEuler(),
      },
    },
  },
  {
    id: "cross",
    title: "Arms crossed",
    instruction:
      "Fold both arms across your chest, like the avatar.",
    demo: {
      spine: zeroEuler(),
      arms: {
        leftUpperArm:  { x: 0, y: -0.8, z: 0.7 },  // brought forward and across
        leftLowerArm:  { x: 0, y: -0.3, z: -0.5 },
        rightUpperArm: { x: 0, y: 0.8, z: -0.7 },
        rightLowerArm: { x: 0, y: 0.3, z: 0.5 },
      },
    },
  },
];

/**
 * Expected Kalidokit solver output per pose (mirror-mode convention; avatar
 * sides). offset = mean(measured) - expected, so only genuine bias (camera
 * angle, lens, solver quirks) is baked in — NOT the structural rotation of
 * the pose itself, which must keep flowing through live.
 * NaN marks a channel that is degenerate in that pose (excluded from the
 * offset for that pose).
 *
 * Formula recap (from Kalidokit calcArms source):
 *   upperArm.z = ∓2.3·θ/π   (θ = drop angle below horizontal; left=+, right=−)
 *   upperArm.y = ∓θ          (same sign convention as z)
 *   upperArm.x = atan2-based; only non-degenerate when arm is not pointing straight up/down.
 */
const EXPECTED_ARMS: Record<BodyPoseId, ArmRotations | null> = {
  neutral: {
    // Arms hanging straight down: θ = π/2
    // z = ∓2.3·(π/2)/π = ∓1.15; y = ∓π/2; x is atan2(≈0,≈0) noise.
    leftUpperArm:  { x: NaN, y: -Math.PI / 2, z: 1.15 },
    leftLowerArm:  { x: NaN, y: 0, z: 0 },
    rightUpperArm: { x: NaN, y: Math.PI / 2, z: -1.15 },
    rightLowerArm: { x: NaN, y: 0, z: 0 },
  },
  raise: {
    // 45° below horizontal: θ = π/4
    // z = ∓2.3·(π/4)/π = ∓0.575; y = ∓π/4; x = ∓0.2.
    leftUpperArm:  { x: -0.2, y: -Math.PI / 4, z: 0.575 },
    leftLowerArm:  { x: 0, y: 0, z: 0 },
    rightUpperArm: { x: 0.2, y: Math.PI / 4, z: -0.575 },
    rightLowerArm: { x: 0, y: 0, z: 0 },
  },
  bow: null,  // arms not calibrated from the bow pose
  hips: {
    // Upper arms near horizontal (θ ≈ π/6, ~30° below horizontal).
    // z = ∓2.3·(π/6)/π ≈ ∓0.383; y = ∓π/6 ≈ ∓0.524.
    // Lower arm is bent at the elbow — degenerate for calibration purposes.
    leftUpperArm:  { x: NaN, y: -Math.PI / 6, z: 0.383 },
    leftLowerArm:  { x: NaN, y: NaN, z: NaN },
    rightUpperArm: { x: NaN, y: Math.PI / 6, z: -0.383 },
    rightLowerArm: { x: NaN, y: NaN, z: NaN },
  },
  overhead: {
    // Arms raised ~45° above horizontal: θ = −π/4.
    // z = ∓2.3·(−π/4)/π ≈ ∓(−0.575); y = ∓(−π/4).
    leftUpperArm:  { x: NaN, y: Math.PI / 4, z: -0.575 },
    leftLowerArm:  { x: 0, y: 0, z: 0 },
    rightUpperArm: { x: NaN, y: -Math.PI / 4, z: 0.575 },
    rightLowerArm: { x: 0, y: 0, z: 0 },
  },
  // Salute and cross are asymmetric / complex — captured for display and
  // future use, but not used in the current arm-offset calibration.
  salute: null,
  cross:  null,
};

/**
 * Max magnitude (rad) of any single arm-offset channel. True camera/solver
 * bias is small; anything bigger means the capture was off (user not in the
 * pose, occlusion) and baking it in would distort live tracking.
 */
const ARM_OFFSET_LIMIT = 0.45;

// ---------------------------------------------------------------------------
// Data model

export interface BodyCalibrationData {
  /**
   * Spine offset (yaw/roll only — x is always 0 here; torso pitch is
   * centered/gained inside the solver via `pitch` instead, so it is never
   * corrected twice). Legacy v2 payloads may still carry a nonzero x with
   * pitch == null; applyCalibration handles both.
   */
  spine: EulerRotation;
  arms: ArmRotations;
  legs: LegRotations;
  hipsRotation: EulerRotation;
  /** Reference hip position in the user's NORMAL posture (solver units). */
  hipsPosition: { x: number; y: number; z: number };
  /**
   * Upright torso length / shoulder width (image space), the reference for
   * the apparent-size torso-pitch (bow) estimator. 0 = not captured —
   * the estimator then falls back to a running max maintained by useMocap.
   */
  torsoRatio: number;
  /** Torso-pitch center/gains (see types.ts). null on legacy v2 payloads. */
  pitch: PitchCalibration | null;
  legSamples: number;
  sampleCount: number;
}

export interface CalibrationData {
  head: EulerRotation;
  pupil: { x: number; y: number };
  expressionBaseline: ExpressionValues;
  faceSampleCount: number;
  body: BodyCalibrationData | null;
}

export function emptyCalibration(): CalibrationData {
  return {
    head: zeroEuler(),
    pupil: { x: 0, y: 0 },
    expressionBaseline: zeroExpressions(),
    faceSampleCount: 0,
    body: null,
  };
}

function subEuler(a: EulerRotation, b: EulerRotation): EulerRotation {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

// ---------------------------------------------------------------------------
// Face calibration (single capture, unchanged behavior)

export class FaceCalibrationRecorder {
  private samples: MocapFrame[] = [];
  private readonly startedAt: number;

  constructor(nowMs: number) {
    this.startedAt = nowMs;
  }

  /** Returns true while still recording. */
  add(frame: MocapFrame, nowMs: number): boolean {
    if (frame.faceTracked) this.samples.push(frame);
    return nowMs - this.startedAt < CALIBRATION_DURATION_MS;
  }

  get progress(): number {
    return clamp(this.samples.length / 30, 0, 1);
  }

  /** Average the capture into `prev` (keeps any body calibration). */
  finish(prev: CalibrationData | null): CalibrationData | null {
    if (this.samples.length < 10) return null; // not enough tracked frames

    const out: CalibrationData = prev ? { ...prev } : emptyCalibration();
    const n = this.samples.length;
    const head = zeroEuler();
    const pupil = { x: 0, y: 0 };
    const baseline = zeroExpressions();
    for (const s of this.samples) {
      head.x += s.head.x / n;
      head.y += s.head.y / n;
      head.z += s.head.z / n;
      pupil.x += s.pupil.x / n;
      pupil.y += s.pupil.y / n;
      for (const k of ALL_EXPRESSION_KEYS) {
        baseline[k] += s.expressions[k] / n;
      }
    }
    // Blinks: a neutral baseline above ~0.4 means the user blinked during
    // calibration or tracking is bad; don't bake that in.
    baseline.blinkLeft = Math.min(baseline.blinkLeft, 0.4);
    baseline.blinkRight = Math.min(baseline.blinkRight, 0.4);

    out.head = head;
    out.pupil = pupil;
    out.expressionBaseline = baseline;
    out.faceSampleCount = n;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Body calibration: guided pose sequence

/** Per-pose accumulated means over the capture window. */
interface PoseCapture {
  spine: EulerRotation;
  arms: ArmRotations;
  legs: LegRotations;
  hipsRotation: EulerRotation;
  hipsPosition: { x: number; y: number; z: number };
  worldPitchRaw: number;
  torsoRatio: number;
  ratioSamples: number;
  legSamples: number;
  sampleCount: number;
}

function emptyPoseCapture(): PoseCapture {
  return {
    spine: zeroEuler(),
    arms: {
      leftUpperArm: zeroEuler(),
      leftLowerArm: zeroEuler(),
      rightUpperArm: zeroEuler(),
      rightLowerArm: zeroEuler(),
    },
    legs: zeroLegs(),
    hipsRotation: zeroEuler(),
    hipsPosition: { x: 0, y: 0, z: 0 },
    worldPitchRaw: 0,
    torsoRatio: 0,
    ratioSamples: 0,
    legSamples: 0,
    sampleCount: 0,
  };
}

const MIN_POSE_SAMPLES = 10;

/** UI-facing snapshot of where the sequence is. */
export interface BodyPoseStatus {
  index: number;
  total: number;
  pose: CalibrationPoseDef;
  phase: "countdown" | "capture";
  /** Whole seconds left in the countdown (0 while capturing). */
  countdown: number;
  /** Capture progress 0..1 (0 while counting down). */
  progress: number;
}

export class BodySequenceRecorder {
  /** Mirror mode at capture time — flips the expected arm x channel. */
  private readonly mirror: boolean;
  private poseIndex = 0;
  private captureStartsAt: number;
  private sums = new Map<BodyPoseId, PoseCapture>();
  private current: PoseCapture = emptyPoseCapture();

  constructor(mirror: boolean, nowMs: number) {
    this.mirror = mirror;
    this.captureStartsAt = nowMs + POSE_COUNTDOWN_MS;
  }

  status(nowMs: number): BodyPoseStatus | null {
    const pose = BODY_POSE_SEQUENCE[this.poseIndex];
    if (!pose) return null;
    const countdownLeft = Math.max(0, this.captureStartsAt - nowMs);
    return {
      index: this.poseIndex,
      total: BODY_POSE_SEQUENCE.length,
      pose,
      phase: countdownLeft > 0 ? "countdown" : "capture",
      countdown: Math.ceil(countdownLeft / 1000),
      progress:
        countdownLeft > 0 ? 0 : clamp(this.current.sampleCount / 30, 0, 1),
    };
  }

  /** Skip the rest of the current pose and move on. */
  skip(nowMs: number): void {
    this.advance(nowMs, /* keepCapture */ false);
  }

  private advance(nowMs: number, keepCapture: boolean): void {
    const pose = BODY_POSE_SEQUENCE[this.poseIndex];
    if (pose && keepCapture && this.current.sampleCount >= MIN_POSE_SAMPLES) {
      this.sums.set(pose.id, this.current);
    }
    this.current = emptyPoseCapture();
    this.poseIndex++;
    this.captureStartsAt = nowMs + POSE_COUNTDOWN_MS;
  }

  /** Feed one RAW solved frame. Returns true while the sequence is running. */
  add(frame: MocapFrame, nowMs: number): boolean {
    if (this.poseIndex >= BODY_POSE_SEQUENCE.length) return false;
    if (nowMs < this.captureStartsAt) return true; // still counting down

    if (frame.poseTracked) {
      const c = this.current;
      c.sampleCount++;
      const n = c.sampleCount;
      const acc = (sum: EulerRotation, v: EulerRotation) => {
        // Running mean: sum holds the mean so far.
        sum.x += (v.x - sum.x) / n;
        sum.y += (v.y - sum.y) / n;
        sum.z += (v.z - sum.z) / n;
      };
      acc(c.spine, frame.spine);
      acc(c.hipsRotation, frame.hips.rotation);
      c.hipsPosition.x += (frame.hips.position.x - c.hipsPosition.x) / n;
      c.hipsPosition.y += (frame.hips.position.y - c.hipsPosition.y) / n;
      c.hipsPosition.z += (frame.hips.position.z - c.hipsPosition.z) / n;
      for (const k of ARM_KEYS) acc(c.arms[k], frame.arms[k]);
      c.worldPitchRaw +=
        ((frame.spineDebug?.worldPitchRaw ?? 0) - c.worldPitchRaw) / n;
      if (frame.torsoRatio > 0) {
        c.ratioSamples++;
        c.torsoRatio += (frame.torsoRatio - c.torsoRatio) / c.ratioSamples;
      }
      if (frame.legsTracked) {
        c.legSamples++;
        const m = c.legSamples;
        for (const k of LEG_KEYS) {
          c.legs[k].x += (frame.legs[k].x - c.legs[k].x) / m;
          c.legs[k].y += (frame.legs[k].y - c.legs[k].y) / m;
          c.legs[k].z += (frame.legs[k].z - c.legs[k].z) / m;
        }
      }
    }

    if (nowMs - this.captureStartsAt >= CALIBRATION_DURATION_MS) {
      this.advance(nowMs, /* keepCapture */ true);
    }
    return this.poseIndex < BODY_POSE_SEQUENCE.length;
  }

  /** Expected solver arm output for a pose under the capture mirror mode. */
  private expectedArms(id: BodyPoseId): ArmRotations | null {
    const base = EXPECTED_ARMS[id];
    if (!base || this.mirror) return base;
    // mirror=false un-mirrors the solver output: sides swap and y/z negate.
    const flip = (e: EulerRotation): EulerRotation => ({ x: e.x, y: -e.y, z: -e.z });
    return {
      leftUpperArm: flip(base.rightUpperArm),
      leftLowerArm: flip(base.rightLowerArm),
      rightUpperArm: flip(base.leftUpperArm),
      rightLowerArm: flip(base.leftLowerArm),
    };
  }

  /** offset = measured − expected per channel; NaN-expected channels -> NaN. */
  private armOffsets(id: BodyPoseId): Partial<Record<ArmKey, EulerRotation>> | null {
    const cap = this.sums.get(id);
    const expected = this.expectedArms(id);
    if (!cap || !expected) return null;
    const out: Partial<Record<ArmKey, EulerRotation>> = {};
    for (const k of ARM_KEYS) {
      out[k] = {
        x: Number.isNaN(expected[k].x) ? NaN : cap.arms[k].x - expected[k].x,
        y: cap.arms[k].y - expected[k].y,
        z: cap.arms[k].z - expected[k].z,
      };
    }
    return out;
  }

  /**
   * Assemble the captured poses into calibration data, merged over `prev`.
   * Skipped/failed poses simply don't contribute; returns prev-equivalent
   * data (or null) if nothing usable was captured.
   */
  finish(prev: CalibrationData | null): CalibrationData | null {
    const neutral = this.sums.get("neutral") ?? null;
    const raise = this.sums.get("raise") ?? null;
    const bow = this.sums.get("bow") ?? null;
    if (this.sums.size === 0) return null;

    const out: CalibrationData = prev ? { ...prev } : emptyCalibration();
    let body: BodyCalibrationData | null = out.body
      ? {
          ...out.body,
          spine: { ...out.body.spine },
          arms: {
            leftUpperArm: { ...out.body.arms.leftUpperArm },
            leftLowerArm: { ...out.body.arms.leftLowerArm },
            rightUpperArm: { ...out.body.arms.rightUpperArm },
            rightLowerArm: { ...out.body.arms.rightLowerArm },
          },
          legs: {
            leftUpperLeg: { ...out.body.legs.leftUpperLeg },
            leftLowerLeg: { ...out.body.legs.leftLowerLeg },
            rightUpperLeg: { ...out.body.legs.rightUpperLeg },
            rightLowerLeg: { ...out.body.legs.rightLowerLeg },
          },
          hipsRotation: { ...out.body.hipsRotation },
          hipsPosition: { ...out.body.hipsPosition },
          pitch: out.body.pitch ? { ...out.body.pitch } : null,
        }
      : null;

    // ---- neutral: every reference + the primary offsets
    if (neutral) {
      body = {
        // Pitch is handled by `pitch` (center inside the solver) — x stays 0
        // so applyCalibration never subtracts it a second time.
        spine: { x: 0, y: neutral.spine.y, z: neutral.spine.z },
        arms: {
          leftUpperArm: zeroEuler(),
          leftLowerArm: zeroEuler(),
          rightUpperArm: zeroEuler(),
          rightLowerArm: zeroEuler(),
        },
        legs: neutral.legSamples > 5 ? neutral.legs : zeroLegs(),
        hipsRotation: neutral.hipsRotation,
        hipsPosition: neutral.hipsPosition,
        torsoRatio: neutral.ratioSamples > 5 ? neutral.torsoRatio : 0,
        pitch: {
          worldCenter: neutral.worldPitchRaw,
          worldGain: 1,
          sizeGain: 1,
        },
        legSamples: neutral.legSamples,
        sampleCount: neutral.sampleCount,
      };
    } else if (body && body.pitch == null) {
      // Legacy v2 body being refined by a partial run: its spine.x offset
      // WAS the upright pitch reading — promote it to the solver-side center.
      body.pitch = { worldCenter: body.spine.x, worldGain: 1, sizeGain: 1 };
      body.spine = { ...body.spine, x: 0 };
    }

    // ---- arms: weighted blend across all available anchor poses.
    // Higher weight = more influence on the final calibration offset.
    // Neutral dominates as the primary resting position; other anchors extend
    // coverage across the arm-angle range (e.g. hips/overhead fix the offset
    // estimate for arm positions not well represented by neutral+raise alone).
    // NaN-expected channels (degenerate in a given pose) are excluded from the
    // weighted sum so they can't corrupt channels that ARE meaningful there.
    const ARM_ANCHOR_WEIGHTS: Partial<Record<BodyPoseId, number>> = {
      neutral:  0.50,
      raise:    0.20,
      hips:     0.20,
      overhead: 0.10,
    };
    const armCandidates = (
      Object.entries(ARM_ANCHOR_WEIGHTS) as Array<[BodyPoseId, number]>
    )
      .map(([id, w]) => ({ off: this.armOffsets(id), w }))
      .filter(
        (e): e is { off: Partial<Record<ArmKey, EulerRotation>>; w: number } =>
          e.off !== null,
      );

    if (body && armCandidates.length > 0) {
      const lim = (v: number) =>
        Number.isNaN(v) ? 0 : clamp(v, -ARM_OFFSET_LIMIT, ARM_OFFSET_LIMIT);
      for (const k of ARM_KEYS) {
        const blendAxis = (axis: "x" | "y" | "z"): number => {
          let wsum = 0;
          let vsum = 0;
          for (const { off, w } of armCandidates) {
            const v = off[k]?.[axis];
            if (v === undefined || Number.isNaN(v)) continue;
            vsum += v * w;
            wsum += w;
          }
          return wsum > 0 ? lim(vsum / wsum) : 0;
        };
        body.arms[k] = { x: blendAxis("x"), y: blendAxis("y"), z: blendAxis("z") };
      }
    }

    // ---- bow: per-user estimator gains against the known demo angle
    if (body && body.pitch && bow) {
      const dWorld = Math.abs(bow.worldPitchRaw - body.pitch.worldCenter);
      body.pitch.worldGain = clamp(BOW_DEMO_PITCH / Math.max(dWorld, 0.06), 0.5, 3);
      if (body.torsoRatio > 0.2 && bow.ratioSamples > 5 && bow.torsoRatio > 0) {
        const magBow = apparentSizePitchMag(bow.torsoRatio, body.torsoRatio);
        body.pitch.sizeGain = clamp(BOW_DEMO_PITCH / Math.max(magBow, 0.05), 0.5, 3);
      }
    }

    out.body = body;
    return out;
  }
}

/** Remap an expression value so `baseline` becomes the new zero. */
function remapExpression(v: number, baseline: number): number {
  const usable = Math.max(1 - baseline, 0.05);
  return clamp((v - baseline) / usable, 0, 1);
}

/**
 * Apply calibration offsets to a raw frame.
 *
 * Always called (even with calib == null) because it also establishes the
 * hip-translation contract: `hips.position` is converted from an absolute
 * solver position into an offset from the calibrated reference posture —
 * and zeroed when no body calibration exists, keeping the avatar planted.
 *
 * NOTE: torso pitch (spine.x) is calibrated INSIDE the solver (center+gain,
 * see kalidokitAdapter) for v3 data, where body.spine.x is stored as 0; the
 * subtraction below is then a no-op on x. Legacy v2 data has pitch == null
 * and a real spine.x offset, so the old subtract-the-T-pose-reading behavior
 * still applies to it.
 */
export function applyCalibration(
  frame: MocapFrame,
  calib: CalibrationData | null,
): MocapFrame {
  const body = calib?.body ?? null;

  const out: MocapFrame = {
    ...frame,
    head: calib ? subEuler(frame.head, calib.head) : frame.head,
    spine: body && frame.poseTracked ? subEuler(frame.spine, body.spine) : frame.spine,
    pupil: calib
      ? {
          x: clamp(frame.pupil.x - calib.pupil.x, -1, 1),
          y: clamp(frame.pupil.y - calib.pupil.y, -1, 1),
        }
      : frame.pupil,
    expressions: { ...frame.expressions },
    arms: { ...frame.arms },
    legs: { ...frame.legs },
    hips: {
      rotation:
        body && frame.poseTracked
          ? subEuler(frame.hips.rotation, body.hipsRotation)
          : frame.hips.rotation,
      position:
        body && frame.poseTracked
          ? {
              x: frame.hips.position.x - body.hipsPosition.x,
              y: frame.hips.position.y - body.hipsPosition.y,
              z: frame.hips.position.z - body.hipsPosition.z,
            }
          : { x: 0, y: 0, z: 0 },
    },
    hands: { ...frame.hands },
  };

  if (calib && calib.faceSampleCount > 0) {
    for (const k of ALL_EXPRESSION_KEYS) {
      out.expressions[k] = remapExpression(
        frame.expressions[k],
        calib.expressionBaseline[k],
      );
    }
  }

  if (body && frame.poseTracked) {
    for (const k of ARM_KEYS) {
      out.arms[k] = subEuler(frame.arms[k], body.arms[k]);
    }
    if (frame.legsTracked) {
      for (const k of LEG_KEYS) {
        out.legs[k] = subEuler(frame.legs[k], body.legs[k]);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Persistence — calibrating before every stream is tedious; keep the last
// calibration in localStorage (camera setups rarely move between sessions).

const STORAGE_KEY = "vtube.calibration.v2";

export function saveCalibration(data: CalibrationData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full / privacy mode — calibration just won't persist.
  }
}

export function loadCalibration(): CalibrationData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CalibrationData;
    // Minimal shape check: reject pre-v2 or corrupted payloads.
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!parsed.head || !parsed.expressionBaseline) return null;
    if (parsed.body) {
      // Fields added after v2 (apparent-size bow estimator, pose-sequence
      // pitch calibration): default them so old payloads keep working —
      // pitch == null routes spine.x through the legacy offset path.
      if (typeof parsed.body.torsoRatio !== "number") parsed.body.torsoRatio = 0;
      if (parsed.body.pitch === undefined) parsed.body.pitch = null;
    }
    return { ...emptyCalibration(), ...parsed };
  } catch {
    return null;
  }
}

export function clearStoredCalibration(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
