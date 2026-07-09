import * as THREE from 'three';
import { flipJointSide, computeRestDirLength } from '../render/rigMath';
import type { FKPositions, LoadedModel, VtubeRig, VtubeRigEntry } from '../render/GlbBoneDriver';

/**
 * Diagnostic + calibration pipeline for a loaded vtubeRig: catches recipes
 * that drive a model wrong (stale restDir, L/R swapped joint pairs, a
 * model exported facing the wrong way) and lets the user fix them live in
 * vtube instead of guessing and round-tripping through AI-CAD blind.
 * See vault/vtube/rig-diagnostics.md.
 */

// ── Static (load-time) checks ────────────────────────────────────────────────

export interface DiagIssue {
  boneName: string;
  kind: 'staleRestDir' | 'sideMismatch' | 'emptyJoint' | 'autoLockedFromDriven';
  /** 'warn' needs user attention; 'info' is FYI-only — the driver already
   *  handles it correctly (see GlbBoneDriver.ts's autoLockedFromDriven). */
  severity: 'warn' | 'info';
  message: string;
  errDeg?: number;
}

const STALE_RESTDIR_DEG = 10;

function angleDeg(a: THREE.Vector3, b: THREE.Vector3): number {
  const d = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  return THREE.MathUtils.radToDeg(Math.acos(d));
}

/** Trailing-side letter a Mixamo-style bone name implies ("...Left..." / "...Right..."), if any. */
function nameSide(boneName: string): 'L' | 'R' | null {
  if (boneName.includes('Left')) return 'L';
  if (boneName.includes('Right')) return 'R';
  return null;
}

/** Run cheap load-time sanity checks against a freshly parsed vtubeRig — no mocap needed. */
export function staticChecks(model: LoadedModel): DiagIssue[] {
  const issues: DiagIssue[] = [];
  const rig = model.vtubeRig;
  if (!rig) return issues;

  for (const [boneName, entry] of rig.entries()) {
    // Info-only: parseVtubeRig() already downgraded this from driven to
    // locked because the recipe gave it no usable joint pair or hand-landmark
    // mapping. The model moves correctly regardless — this is just an FYI
    // that the AI-CAD export could give this bone a real joint pair.
    if (entry.autoLockedFromDriven) {
      issues.push({
        boneName,
        kind: 'autoLockedFromDriven',
        severity: 'info',
        message: `"${boneName}" was recipe'd driven with no usable joint pair — auto-locked (re-export from AI-CAD to give it one).`,
      });
    }

    if (entry.role !== 'driven') continue;

    // Empty mapping: marked driven but nothing tells the driver how to drive
    // it. Should be unreachable now that parseVtubeRig() auto-locks this case
    // (see autoLockedFromDriven above) — kept as a defensive check in case a
    // rig entry is ever constructed some other way (e.g. a future non-GLB
    // loader) without going through that downgrade.
    if (!entry.lmPair && !(entry.jointFrom && entry.jointTo)) {
      issues.push({
        boneName,
        kind: 'emptyJoint',
        severity: 'warn',
        message: `"${boneName}" is role:driven but has no jointFrom/jointTo or lmHand/lmPair — it will never move.`,
      });
      continue;
    }

    // Side mismatch: bone name says Left/Right but the joint pair it's driven
    // from ends in the opposite canonical-joint side letter.
    const side = nameSide(boneName);
    if (side) {
      const wantSuffix = side; // 'L' bone should be driven by joints ending 'L'
      const jointSides = [entry.jointFrom, entry.jointTo, ...(entry.lmHand ? [entry.lmHand] : [])]
        .filter((j): j is string => !!j)
        .filter((j) => j.endsWith('L') || j.endsWith('R') || j === 'L' || j === 'R');
      const mismatched = jointSides.find((j) => {
        const jSide = j === 'L' || j === 'R' ? j : j.slice(-1);
        return jSide !== wantSuffix;
      });
      if (mismatched) {
        issues.push({
          boneName,
          kind: 'sideMismatch',
          severity: 'warn',
          message: `"${boneName}" reads as ${side === 'L' ? 'Left' : 'Right'} by name but is driven by "${mismatched}" (opposite side).`,
        });
      }
    }

    // Stale restDir: recompute the bone's actual local dir-to-child from the
    // live hierarchy and compare against what the recipe declared.
    if (entry.length > 0) {
      const { dir: liveDir } = computeRestDirLength(entry.bone, entry.childBone);
      if (liveDir.lengthSq() > 1e-8) {
        const err = angleDeg(liveDir, entry.restDir);
        if (err > STALE_RESTDIR_DEG) {
          issues.push({
            boneName,
            kind: 'staleRestDir',
            severity: 'warn',
            message: `"${boneName}"'s recipe restDir is ${err.toFixed(1)}° off the model's actual bind-pose direction.`,
            errDeg: err,
          });
        }
      }
    }
  }

  return issues;
}

// ── Live (T-pose) calibration ────────────────────────────────────────────────

export interface CalibRow {
  boneName: string;
  jointFrom?: string;
  jointTo?: string;
  errDeg: number;
  suggestion?: string;
}

export type RigFix =
  | { type: 'swap'; pair: [string, string] }
  | { type: 'facingFlip' }
  | { type: 'restDirRefresh'; boneName: string };

export interface CalibReport {
  rows: CalibRow[];
  fixes: RigFix[];
}

const SWAP_MARGIN_DEG = 25;
const FACING_FLIP_DEG = 150;
const RESTDIR_REFRESH_DEG = 20;
const MIN_HORIZ = 0.2; // ignore near-vertical bones (spine/neck) for the facing-flip check

/** Spherical mean direction of a set of world-space vectors (each normalized first). */
function meanDir(vecs: THREE.Vector3[]): THREE.Vector3 | null {
  const sum = new THREE.Vector3();
  let n = 0;
  for (const v of vecs) {
    if (v.lengthSq() < 1e-8) continue;
    sum.add(v.clone().normalize());
    n++;
  }
  if (n === 0 || sum.lengthSq() < 1e-8) return null;
  return sum.normalize();
}

/** fk[jointFrom] -> fk[jointTo] direction for one FK frame, or null if either joint is unknown. */
function jointDir(fk: FKPositions, jointFrom: string, jointTo: string): THREE.Vector3 | null {
  const map = fk as unknown as Record<string, THREE.Vector3>;
  const a = map[jointFrom];
  const b = map[jointTo];
  if (!a || !b) return null;
  const d = b.clone().sub(a);
  return d.lengthSq() > 1e-8 ? d : null;
}

/**
 * Compare each driven (joint-pair) bone's bind-pose direction against the
 * live T-pose FK direction, and suggest fixes: L/R swap, whole-rig facing
 * flip, or a one-off restDir refresh.
 */
export function captureCalibration(model: LoadedModel, fkSamples: FKPositions[]): CalibReport {
  const rows: CalibRow[] = [];
  const fixes: RigFix[] = [];
  const rig = model.vtubeRig;
  if (!rig || fkSamples.length === 0) return { rows, fixes };

  // Only joint-pair (FK) driven bones participate — lmPair (hand-landmark)
  // driven bones have no FKPositions correspondence to calibrate against.
  const candidates: Array<{ boneName: string; entry: VtubeRigEntry; err: number; errSwapped: number; meanD: THREE.Vector3; meanDSwapped: THREE.Vector3 | null }> = [];

  for (const [boneName, entry] of rig.entries()) {
    if (entry.role !== 'driven' || !entry.jointFrom || !entry.jointTo) continue;

    const dirs = fkSamples.map((fk) => jointDir(fk, entry.jointFrom!, entry.jointTo!)).filter((d): d is THREE.Vector3 => !!d);
    const meanD = meanDir(dirs);
    if (!meanD) continue;
    const err = angleDeg(entry.bindWorldDir, meanD);

    const flippedFrom = flipJointSide(entry.jointFrom);
    const flippedTo = flipJointSide(entry.jointTo);
    const swappedDirs = fkSamples.map((fk) => jointDir(fk, flippedFrom, flippedTo)).filter((d): d is THREE.Vector3 => !!d);
    const meanDSwapped = meanDir(swappedDirs);
    const errSwapped = meanDSwapped ? angleDeg(entry.bindWorldDir, meanDSwapped) : Infinity;

    candidates.push({ boneName, entry, err, errSwapped, meanD, meanDSwapped });
  }

  // ── swap suggestions: pair each bone with its flipJointSide counterpart ──
  const consumed = new Set<string>();
  for (const c of candidates) {
    if (consumed.has(c.boneName)) continue;
    const oppJointFrom = flipJointSide(c.entry.jointFrom!);
    const oppJointTo = flipJointSide(c.entry.jointTo!);
    const opp = candidates.find(
      (o) => !consumed.has(o.boneName) && o.boneName !== c.boneName &&
        o.entry.jointFrom === oppJointFrom && o.entry.jointTo === oppJointTo,
    );
    if (opp && (c.err - c.errSwapped > SWAP_MARGIN_DEG) && (opp.err - opp.errSwapped > SWAP_MARGIN_DEG)) {
      fixes.push({ type: 'swap', pair: [c.boneName, opp.boneName] });
      consumed.add(c.boneName);
      consumed.add(opp.boneName);
    }
  }

  // ── facing-flip: majority of horizontal-signal bones ~180° off in XZ ──
  let horizChecked = 0;
  let horizFlipped = 0;
  for (const c of candidates) {
    const bindXZ = new THREE.Vector2(c.entry.bindWorldDir.x, c.entry.bindWorldDir.z);
    const liveXZ = new THREE.Vector2(c.meanD.x, c.meanD.z);
    if (bindXZ.length() < MIN_HORIZ || liveXZ.length() < MIN_HORIZ) continue;
    horizChecked++;
    const angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(bindXZ.clone().normalize().dot(liveXZ.clone().normalize()), -1, 1)));
    if (angle > FACING_FLIP_DEG) horizFlipped++;
  }
  const facingFlipSuggested = horizChecked >= 3 && horizFlipped / horizChecked > 0.5;
  if (facingFlipSuggested) fixes.push({ type: 'facingFlip' });

  // ── restDirRefresh: remaining high-error bones not already explained by swap/facing-flip ──
  for (const c of candidates) {
    if (consumed.has(c.boneName)) continue;
    if (facingFlipSuggested) continue;
    if (c.err > RESTDIR_REFRESH_DEG) {
      fixes.push({ type: 'restDirRefresh', boneName: c.boneName });
    }
  }

  // ── build the display table, sorted by error descending ──
  for (const c of candidates) {
    let suggestion: string | undefined;
    const swapFix = fixes.find((f) => f.type === 'swap' && (f.pair[0] === c.boneName || f.pair[1] === c.boneName));
    if (swapFix && swapFix.type === 'swap') {
      const other = swapFix.pair[0] === c.boneName ? swapFix.pair[1] : swapFix.pair[0];
      suggestion = `swap with "${other}"`;
    } else if (facingFlipSuggested) {
      suggestion = 'facing flip (whole rig)';
    } else if (fixes.some((f) => f.type === 'restDirRefresh' && f.boneName === c.boneName)) {
      suggestion = 'refresh restDir';
    }
    rows.push({ boneName: c.boneName, jointFrom: c.entry.jointFrom, jointTo: c.entry.jointTo, errDeg: c.err, suggestion });
  }
  rows.sort((a, b) => b.errDeg - a.errDeg);

  return { rows, fixes };
}

// ── Apply fixes to the in-memory rig ─────────────────────────────────────────

function refreshRestDir(entry: VtubeRigEntry): void {
  const { dir } = computeRestDirLength(entry.bone, entry.childBone);
  if (dir.lengthSq() > 1e-8) entry.restDir = dir;
}

/** Mutate `rig` in place to apply one suggested fix. */
export function applyFix(rig: VtubeRig, fix: RigFix): void {
  if (fix.type === 'swap') {
    for (const boneName of fix.pair) {
      const entry = rig.get(boneName);
      if (!entry || !entry.jointFrom || !entry.jointTo) continue;
      entry.jointFrom = flipJointSide(entry.jointFrom);
      entry.jointTo = flipJointSide(entry.jointTo);
      refreshRestDir(entry);
      entry.restQ = entry.bone.quaternion.clone();
    }
  } else if (fix.type === 'restDirRefresh') {
    const entry = rig.get(fix.boneName);
    if (entry) refreshRestDir(entry);
  } else if (fix.type === 'facingFlip') {
    for (const entry of rig.values()) {
      if (entry.jointFrom) entry.jointFrom = flipJointSide(entry.jointFrom);
      if (entry.jointTo) entry.jointTo = flipJointSide(entry.jointTo);
    }
  }
}

// ── Export back to the vtubeRig JSON contract ────────────────────────────────

/** Serialize the (possibly fixed-up) in-memory rig back to the vtubeRig-contract JSON shape. */
export function exportCorrectedRecipe(rig: VtubeRig): string {
  const bones: Record<string, Record<string, unknown>> = {};
  for (const [boneName, entry] of rig.entries()) {
    const out: Record<string, unknown> = { role: entry.role };
    if (entry.role === 'driven') {
      if (entry.lmPair) {
        out.lmHand = entry.lmHand;
        out.lmPair = entry.lmPair;
      } else if (entry.jointFrom && entry.jointTo) {
        out.jointFrom = entry.jointFrom;
        out.jointTo = entry.jointTo;
      }
      out.restDir = [entry.restDir.x, entry.restDir.y, entry.restDir.z];
      out.length = entry.length;
    } else if (entry.role === 'spring') {
      out.stiffness = entry.stiffness ?? 0.5;
      out.damping = entry.damping ?? 0.5;
    }
    bones[boneName] = out;
  }
  return JSON.stringify({ version: 1, bones }, null, 2);
}
