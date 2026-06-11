import type { VRM } from "@pixiv/three-vrm";
import { ALL_EXPRESSION_KEYS, type AllExpressionKey } from "../mocap/types";

/**
 * Per-model mapping from a MocapFrame expression channel name (VRM preset
 * vowels/blinks + the full 52 ARKit blendshape names) to whatever
 * expression name the LOADED VRM actually exposes.
 *
 * three-vrm's `expressionManager` already normalizes all three sources of
 * expressions into one name-keyed registry:
 * - VRM 1.0 `expressions.preset` (happy, blinkLeft, aa, ...)
 * - VRM 1.0 `expressions.custom` (arbitrary names, e.g. "Perfect Sync"
 *   ARKit-named blendshapes some VRoid exports include)
 * - VRM 0.x `blendShapeMaster.blendShapeGroups` (loaded as either presets or
 *   customs depending on whether the group name matches a VRM1 preset)
 *
 * So building the map is mostly a direct name lookup via
 * `expressionManager.getExpression(name)`. Any MediaPipe channel that has no
 * matching expression on this model is recorded in `unsupported` so the rig
 * layer can skip it (no-op) and the debug HUD can show a one-time warning.
 */
export interface ExpressionMapping {
  /** mocap channel name -> VRM expression name (1:1 here, but kept distinct
   *  in case future aliasing needs many-to-one). */
  map: Map<AllExpressionKey, string>;
  /** mocap channels this model has no expression for. */
  unsupported: AllExpressionKey[];
  /** total channels considered, for HUD display ("12/52 supported"). */
  total: number;
}

/**
 * A few common alternate spellings/casings seen in the wild for custom
 * "Perfect Sync" blendshape clips, tried if the exact ARKit name isn't
 * present on the model.
 */
function aliasesFor(name: AllExpressionKey): string[] {
  const aliases: string[] = [];
  // Some exporters capitalize the first letter of custom expression names.
  aliases.push(name.charAt(0).toUpperCase() + name.slice(1));
  // Some exporters use snake_case ARKit-ish names (e.g. "Eye_Blink_L").
  return aliases;
}

export function buildExpressionMap(vrm: VRM): ExpressionMapping {
  const manager = vrm.expressionManager;
  const map = new Map<AllExpressionKey, string>();
  const unsupported: AllExpressionKey[] = [];

  for (const channel of ALL_EXPRESSION_KEYS) {
    if (!manager) {
      unsupported.push(channel);
      continue;
    }

    let matched: string | null = null;
    if (manager.getExpression(channel)) {
      matched = channel;
    } else {
      for (const alias of aliasesFor(channel)) {
        if (manager.getExpression(alias)) {
          matched = alias;
          break;
        }
      }
    }

    if (matched) {
      map.set(channel, matched);
    } else {
      unsupported.push(channel);
    }
  }

  return { map, unsupported, total: ALL_EXPRESSION_KEYS.length };
}
