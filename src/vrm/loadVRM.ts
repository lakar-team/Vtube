import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { buildExpressionMap, type ExpressionMapping } from "./expressionMap";

/**
 * Put your own avatar at public/models/avatar.vrm (see public/models/README.md).
 */
export const LOCAL_MODEL_URL = "/models/avatar.vrm";

/**
 * Free-licensed sample model from the three-vrm repository (MIT example
 * asset). Minimal test model; requires network on first load.
 */
export const FALLBACK_MODEL_URL =
  "https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm";

export interface LoadedVRM {
  vrm: VRM;
  sourceUrl: string;
  expressionMap: ExpressionMapping;
}

async function loadFrom(url: string): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error(`${url} is not a VRM file`);

  // Perf helpers from three-vrm.
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  // combineSkeletons replaced removeUnnecessaryJoints in three-vrm v3.
  const utils = VRMUtils as unknown as {
    combineSkeletons?: (scene: THREE.Object3D) => void;
    removeUnnecessaryJoints?: (scene: THREE.Object3D) => void;
  };
  if (utils.combineSkeletons) utils.combineSkeletons(gltf.scene);
  else utils.removeUnnecessaryJoints?.(gltf.scene);

  // Make VRM 0.x models face the same direction as VRM 1.0 models (+Z).
  // After this, ONE rotation-sign convention works for both versions because
  // we drive the humanoid through NORMALIZED bones (see applyMocapToVRM.ts).
  VRMUtils.rotateVRM0(vrm);

  // Render avatar after the environment regardless of material transparency.
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });

  return vrm;
}

function finishLoad(vrm: VRM, sourceUrl: string): LoadedVRM {
  // Inspect what expressions/blendshapes this specific model exposes (VRM 1.0
  // presets, VRM 0.x BlendShapeClips, "Perfect Sync" custom expressions) and
  // build the mocap-channel -> model-expression map. Logged once so it's
  // visible in the console for debugging; the unsupported list also surfaces
  // in the debug HUD.
  const expressionMap = buildExpressionMap(vrm);
  console.info(
    `[vrm] expression mapping: ${expressionMap.map.size}/${expressionMap.total} ` +
      `mocap channels supported by this model.`,
    { unsupported: expressionMap.unsupported },
  );

  return { vrm, sourceUrl, expressionMap };
}

/**
 * Try the local model first, then fall back to the hosted sample.
 */
export async function loadVRM(): Promise<LoadedVRM> {
  let vrm: VRM;
  let sourceUrl: string;
  try {
    vrm = await loadFrom(LOCAL_MODEL_URL);
    sourceUrl = LOCAL_MODEL_URL;
  } catch (localErr) {
    console.info(
      `No local model at ${LOCAL_MODEL_URL} (drop one in public/models/). ` +
        `Falling back to hosted sample.`,
      localErr,
    );
    vrm = await loadFrom(FALLBACK_MODEL_URL);
    sourceUrl = FALLBACK_MODEL_URL;
  }

  return finishLoad(vrm, sourceUrl);
}

/**
 * Load a user-supplied .vrm file (from a file picker / drag-and-drop).
 * VRM files are self-contained glTF binaries, so a temporary object URL is
 * all the loader needs.
 */
export async function loadVRMFromFile(file: File): Promise<LoadedVRM> {
  const url = URL.createObjectURL(file);
  try {
    const vrm = await loadFrom(url);
    return finishLoad(vrm, file.name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function disposeVRM(vrm: VRM): void {
  VRMUtils.deepDispose(vrm.scene);
}
