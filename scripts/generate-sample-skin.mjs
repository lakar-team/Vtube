// Bake the bundled demo skin (public/skins/sample-skin.png) for the default
// avatar: the avatar's own base-color textures, with hair/clothing/shoes
// hue-rotated, composed in the SAME grid layout the runtime skin code uses
// (src/vrm/skin.ts) — one square cell per unique base-color texture, cells
// sorted by smallest material name, ceil(sqrt(n)) columns. Keep the two in
// sync if the layout rules change.
//
// Usage (cwd must be the build mirror so pngjs resolves — see BUILD.md):
//   cd %LOCALAPPDATA%\vtube-build
//   node "G:\My Drive\AI Platforms\vtube\scripts\generate-sample-skin.mjs" [vrmPath] [outPath]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// npm never runs in the Drive folder (BUILD.md), so pngjs is resolved from
// the cwd this script is launched from — the local build mirror.
const require = createRequire(join(process.cwd(), "package.json"));
const { PNG } = require("pngjs");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const vrmPath = resolve(process.argv[2] ?? join(scriptDir, "..", "public", "models", "avatar.vrm"));
const outPath = resolve(process.argv[3] ?? join(scriptDir, "..", "public", "skins", "sample-skin.png"));

const CELL = 512;

// --- label rules: copy of guessBodyPart in src/vrm/skin.ts ------------------
const LABEL_RULES = [
  [/facemouth|mouth/i, "Mouth (inside)"],
  [/eyeiris|iris/i, "Eyes: iris"],
  [/eyehighlight/i, "Eyes: highlight"],
  [/eyewhite|sclera/i, "Eyes: white"],
  [/facebrow|brow/i, "Eyebrows"],
  [/eyelash|lash/i, "Eyelashes"],
  [/eyeline/i, "Eye line"],
  [/face/i, "Face skin"],
  [/hairback/i, "Hair (back)"],
  [/hair/i, "Hair"],
  [/body|skin/i, "Body skin (torso, arms, legs)"],
  [/shoe|boot|foot/i, "Shoes"],
  [/bottom|pant|skirt/i, "Clothing: bottoms (hips, legs)"],
  [/top|shirt|jacket|onepiece|dress|cloth/i, "Clothing: top (torso, arms)"],
  [/accessor|glasses|hat/i, "Accessory"],
];
const guessBodyPart = (name) => {
  for (const [re, label] of LABEL_RULES) if (re.test(name)) return label;
  return name ? `Material: ${name}` : "Unknown part";
};

// Recolor everything that isn't skin/face — "same character, new look".
// Colorize (luminance × tint) rather than hue-rotate, so it shows up even on
// gray hair and white clothes.
const TINTS = [
  [/hair/i, [110, 220, 235]], // teal hair
  [/clothing: top/i, [150, 110, 235]], // purple top
  [/clothing: bottoms/i, [235, 120, 170]], // pink bottoms
  [/shoes/i, [240, 170, 80]], // orange shoes
  [/accessory/i, [235, 200, 90]], // gold accessories
];
const tintFor = (label) => {
  for (const [re, tint] of TINTS) if (re.test(label)) return tint;
  return null;
};

// --- parse GLB ---------------------------------------------------------------
const buf = readFileSync(vrmPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${vrmPath} is not a GLB/VRM`);
let off = 12;
let jsonBuf = null;
let binBuf = null;
while (off + 8 <= buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) jsonBuf = data;
  else if (type === 0x004e4942) binBuf = data;
  off += 8 + len;
}
const json = JSON.parse(jsonBuf.toString("utf8"));

// --- group materials by base-color image (same rule as skin.ts) -------------
const groups = new Map(); // image index -> { image, names: [] }
for (const mat of json.materials ?? []) {
  const texIdx = mat.pbrMetallicRoughness?.baseColorTexture?.index;
  if (texIdx == null) continue;
  const imgIdx = json.textures?.[texIdx]?.source;
  if (imgIdx == null) continue;
  let g = groups.get(imgIdx);
  if (!g) groups.set(imgIdx, (g = { image: imgIdx, names: [] }));
  g.names.push(mat.name || "~");
}
const cells = [...groups.values()].map((g) => ({
  ...g,
  sortName: g.names.slice().sort()[0],
}));
cells.sort((a, b) => (a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0));
if (cells.length === 0) throw new Error("No base-color textures found.");

const cols = Math.max(1, Math.ceil(Math.sqrt(cells.length)));
const rows = Math.max(1, Math.ceil(cells.length / cols));

// --- compose -----------------------------------------------------------------
const out = new PNG({ width: cols * CELL, height: rows * CELL });

cells.forEach((cell, i) => {
  const imgDef = json.images[cell.image];
  if (imgDef.mimeType !== "image/png") {
    throw new Error(`image ${cell.image} is ${imgDef.mimeType}; only PNG supported`);
  }
  const bv = json.bufferViews[imgDef.bufferView];
  const png = PNG.sync.read(
    Buffer.from(binBuf.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)),
  );

  const label = guessBodyPart(cell.sortName);
  const tint = tintFor(label);
  const cx = (i % cols) * CELL;
  const cy = Math.floor(i / cols) * CELL;

  // Nearest-neighbor stretch into the cell (matches the runtime's
  // stretch-to-fill convention).
  for (let y = 0; y < CELL; y++) {
    const sy = Math.min(png.height - 1, Math.floor((y * png.height) / CELL));
    for (let x = 0; x < CELL; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / CELL));
      const s = (sy * png.width + sx) * 4;
      const d = ((cy + y) * out.width + (cx + x)) * 4;
      const r = png.data[s];
      const g = png.data[s + 1];
      const b = png.data[s + 2];
      if (tint) {
        // Slightly lifted luminance so dark tints don't go muddy.
        const lum = Math.min(255, (0.299 * r + 0.587 * g + 0.114 * b) * 1.15);
        out.data[d] = Math.round((lum * tint[0]) / 255);
        out.data[d + 1] = Math.round((lum * tint[1]) / 255);
        out.data[d + 2] = Math.round((lum * tint[2]) / 255);
      } else {
        out.data[d] = r;
        out.data[d + 1] = g;
        out.data[d + 2] = b;
      }
      out.data[d + 3] = png.data[s + 3];
    }
  }

  console.log(
    `cell ${String(i + 1).padStart(2)} [${cx},${cy}] ${tint ? `TINT(${tint})` : "as-is"} ` +
      `${label} (${cell.sortName}, ${png.width}x${png.height})`,
  );
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, PNG.sync.write(out));
console.log(`\nwrote ${outPath} (${cols * CELL}x${rows * CELL}, ${cells.length} cells)`);
