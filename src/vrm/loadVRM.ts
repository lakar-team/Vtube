import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

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

/**
 * Try the local model first, then fall back to the hosted sample.
 */
export async function loadVRM(): Promise<LoadedVRM> {
  try {
    return { vrm: await loadFrom(LOCAL_MODEL_URL), sourceUrl: LOCAL_MODEL_URL };
  } catch (localErr) {
    console.info(
      `No local model at ${LOCAL_MODEL_URL} (drop one in public/models/). ` +
        `Falling back to hosted sample.`,
      localErr,
    );
    return {
      vrm: await loadFrom(FALLBACK_MODEL_URL),
      sourceUrl: FALLBACK_MODEL_URL,
    };
  }
}

export function disposeVRM(vrm: VRM): void {
  VRMUtils.deepDispose(vrm.scene);
}
