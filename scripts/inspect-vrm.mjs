// Quick GLB/VRM inspector: dumps materials, their base-color textures, and
// image metadata so we can design the skin-template layout. No deps.
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "public/models/avatar.vrm";
const buf = readFileSync(path);

const magic = buf.readUInt32LE(0);
if (magic !== 0x46546c67) throw new Error("not a GLB");
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));

console.log("generator:", json.asset?.generator);
console.log("extensions:", Object.keys(json.extensions ?? {}));
const vrm0 = json.extensions?.VRM;
const vrm1 = json.extensions?.VRMC_vrm;
console.log("VRM version:", vrm0 ? `0.x (${vrm0.exporterVersion})` : vrm1 ? `1.x (spec ${vrm1.specVersion})` : "?");

const images = json.images ?? [];
console.log(`\nimages (${images.length}):`);
images.forEach((img, i) => {
  const bv = json.bufferViews[img.bufferView];
  console.log(`  [${i}] name=${JSON.stringify(img.name)} mime=${img.mimeType} bytes=${bv.byteLength}`);
});

const textures = json.textures ?? [];
console.log(`\nmaterials (${(json.materials ?? []).length}):`);
(json.materials ?? []).forEach((m, i) => {
  const texIdx = m.pbrMetallicRoughness?.baseColorTexture?.index;
  const imgIdx = texIdx != null ? textures[texIdx]?.source : null;
  console.log(`  [${i}] ${JSON.stringify(m.name)} baseColorTex=${texIdx ?? "-"} image=${imgIdx ?? "-"}`);
});

if (vrm0?.materialProperties) {
  console.log(`\nVRM0 materialProperties (${vrm0.materialProperties.length}):`);
  vrm0.materialProperties.forEach((mp, i) => {
    console.log(`  [${i}] ${JSON.stringify(mp.name)} shader=${mp.shader} _MainTex=${mp.textureProperties?._MainTex ?? "-"}`);
  });
}

console.log(`\nmeshes (${(json.meshes ?? []).length}):`);
(json.meshes ?? []).forEach((m, i) => {
  const prims = m.primitives.map((p) => p.material).join(",");
  console.log(`  [${i}] ${JSON.stringify(m.name)} primitive materials=[${prims}]`);
});
