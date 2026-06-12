import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

/**
 * Minecraft-style "skin" support.
 *
 * The avatar's surface appearance is defined by its materials' base-color
 * textures. We expose those as a single paintable PNG (the "skin template")
 * and re-apply an edited copy of that PNG at runtime — same mesh, new paint.
 *
 * Layout: one square cell per unique base-color texture, in a fixed grid
 * (cells sorted by material name, ceil(sqrt(n)) columns). The layout is
 * deterministic for a given model, so a template downloaded from a model and
 * an edited copy uploaded later always line up. Each texture is stretched to
 * fill its cell and stretched back to its native resolution on upload, so
 * the round trip is exact regardless of per-texture sizes.
 *
 * scripts/generate-sample-skin.mjs re-implements the same grouping/ordering
 * rules to bake the bundled sample skin for the default avatar — keep them
 * in sync if the layout rules change.
 *
 * This deliberately only touches textures. Body-shape variants (taller,
 * larger, …) are a future concern: they would deform the mesh while keeping
 * this same UV/texture layer on top, so nothing here should ever assume a
 * specific geometry.
 */

export const SAMPLE_SKIN_URL = "/skins/sample-skin.png";

/**
 * Materials we can reskin: anything exposing a base-color `map` (MToon,
 * standard and unlit materials all do). `shadeMultiplyTexture` is MToon's
 * toon-shade texture — on VRoid models it's a tinted copy of the base
 * texture, so a custom skin must replace it too or shaded areas would keep
 * the original colors.
 */
type SkinnableMaterial = THREE.Material & {
  map?: THREE.Texture | null;
  shadeMultiplyTexture?: THREE.Texture | null;
};

interface WireRange {
  geometry: THREE.BufferGeometry;
  /** Range in index (or vertex) units covering this material's triangles. */
  start: number;
  count: number;
}

export interface SkinCell {
  /** Texture source uuid — all materials sharing this base image. */
  key: string;
  /** Best-effort body-part name guessed from the material names. */
  label: string;
  /** Lexicographically smallest material name; defines cell order. */
  sortName: string;
  /** The model's original texture for this cell. */
  texture: THREE.Texture;
  materials: SkinnableMaterial[];
  ranges: WireRange[];
}

export interface SkinLayout {
  cells: SkinCell[];
  cols: number;
  rows: number;
}

interface SkinState {
  layout: SkinLayout;
  /** Textures as they were when the model loaded, for resetSkin. */
  originals: Map<
    SkinnableMaterial,
    { map: THREE.Texture | null; shade: THREE.Texture | null | undefined }
  >;
  /** Canvas textures we created, disposed when replaced or reset. */
  applied: THREE.Texture[];
}

/**
 * Layout + originals are computed once per VRM and cached, so applying a
 * skin doesn't change how the next template/upload is interpreted.
 */
const stateCache = new WeakMap<VRM, SkinState>();

/** Ordered: first match wins. Tuned for VRoid naming, degrades to generic. */
const LABEL_RULES: Array<[RegExp, string]> = [
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

export function guessBodyPart(materialName: string): string {
  for (const [re, label] of LABEL_RULES) {
    if (re.test(materialName)) return label;
  }
  return materialName ? `Material: ${materialName}` : "Unknown part";
}

function buildLayout(vrm: VRM): SkinLayout {
  const cellsByKey = new Map<string, SkinCell>();

  vrm.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    materials.forEach((raw, materialIndex) => {
      const material = raw as SkinnableMaterial;
      const map = material.map;
      if (!map || !map.image) return;

      const key = map.source?.uuid ?? map.uuid;
      let cell = cellsByKey.get(key);
      if (!cell) {
        cell = {
          key,
          label: "",
          sortName: material.name || "~",
          texture: map,
          materials: [],
          ranges: [],
        };
        cellsByKey.set(key, cell);
      }
      if (!cell.materials.includes(material)) cell.materials.push(material);
      if (material.name && material.name < cell.sortName) cell.sortName = material.name;

      const fullCount = geometry.index
        ? geometry.index.count
        : geometry.attributes.position?.count ?? 0;
      if (Array.isArray(mesh.material) && geometry.groups.length > 0) {
        for (const group of geometry.groups) {
          if (group.materialIndex !== materialIndex) continue;
          const count =
            group.count === Infinity ? fullCount - group.start : group.count;
          cell.ranges.push({ geometry, start: group.start, count });
        }
      } else {
        cell.ranges.push({ geometry, start: 0, count: fullCount });
      }
    });
  });

  const cells = [...cellsByKey.values()].sort((a, b) =>
    a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0,
  );
  for (const cell of cells) cell.label = guessBodyPart(cell.sortName);

  const cols = Math.max(1, Math.ceil(Math.sqrt(cells.length)));
  const rows = Math.max(1, Math.ceil(cells.length / Math.max(cols, 1)));
  return { cells, cols, rows };
}

function getSkinState(vrm: VRM): SkinState {
  let state = stateCache.get(vrm);
  if (!state) {
    const layout = buildLayout(vrm);
    const originals: SkinState["originals"] = new Map();
    for (const cell of layout.cells) {
      for (const material of cell.materials) {
        originals.set(material, {
          map: material.map ?? null,
          // undefined = material has no shade slot; null/Texture = it does.
          shade:
            "shadeMultiplyTexture" in material
              ? material.shadeMultiplyTexture ?? null
              : undefined,
        });
      }
    }
    state = { layout, originals, applied: [] };
    stateCache.set(vrm, state);
  }
  return state;
}

/** Expose the layout (for UI/info); builds and caches it on first call. */
export function getSkinLayout(vrm: VRM): SkinLayout {
  return getSkinState(vrm).layout;
}

// ---------------------------------------------------------------------------
// Template generation
// ---------------------------------------------------------------------------

const TEMPLATE_CELL_SIZE = 1024;

/**
 * Render the paint-me template: per cell, the current texture with faint
 * gridlines, the UV wireframe of every triangle that samples it, and a
 * label naming the body part (best effort, from material names).
 */
export async function generateSkinTemplate(vrm: VRM): Promise<Blob> {
  const { layout } = getSkinState(vrm);
  if (layout.cells.length === 0) {
    throw new Error("This model has no base-color textures to template.");
  }

  const cell = TEMPLATE_CELL_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = layout.cols * cell;
  canvas.height = layout.rows * cell;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create a 2D canvas for the template.");

  ctx.fillStyle = "#202028";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  layout.cells.forEach((c, i) => {
    const cx = (i % layout.cols) * cell;
    const cy = Math.floor(i / layout.cols) * cell;

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx, cy, cell, cell);
    ctx.clip();

    // Current texture, stretched to fill the square cell (uploads stretch
    // back to native size, so painting over this round-trips exactly).
    try {
      ctx.drawImage(c.texture.image as CanvasImageSource, cx, cy, cell, cell);
    } catch {
      ctx.fillStyle = "#3a3a4a";
      ctx.fillRect(cx, cy, cell, cell);
    }

    // Gridlines: 8x8 per cell.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 1; g < 8; g++) {
      const o = (g * cell) / 8;
      ctx.moveTo(cx + o, cy);
      ctx.lineTo(cx + o, cy + cell);
      ctx.moveTo(cx, cy + o);
      ctx.lineTo(cx + cell, cy + o);
    }
    ctx.stroke();

    // UV wireframe.
    ctx.strokeStyle = "rgba(64, 224, 255, 0.28)";
    ctx.lineWidth = 1;
    for (const range of c.ranges) {
      const uv = range.geometry.attributes.uv as THREE.BufferAttribute | undefined;
      if (!uv) continue;
      const index = range.geometry.index;
      ctx.beginPath();
      const end = range.start + range.count;
      for (let t = range.start; t + 2 < end; t += 3) {
        const a = index ? index.getX(t) : t;
        const b = index ? index.getX(t + 1) : t + 1;
        const d = index ? index.getX(t + 2) : t + 2;
        const ax = cx + uv.getX(a) * cell;
        const ay = cy + uv.getY(a) * cell;
        ctx.moveTo(ax, ay);
        ctx.lineTo(cx + uv.getX(b) * cell, cy + uv.getY(b) * cell);
        ctx.lineTo(cx + uv.getX(d) * cell, cy + uv.getY(d) * cell);
        ctx.lineTo(ax, ay);
      }
      ctx.stroke();
    }

    // Cell border + label.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.strokeRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1);

    const title = `${i + 1}. ${c.label}`;
    const sub = c.sortName;
    const titlePx = Math.round(cell * 0.035);
    const subPx = Math.round(cell * 0.022);
    const pad = Math.round(cell * 0.015);
    ctx.font = `bold ${titlePx}px system-ui, sans-serif`;
    const titleW = ctx.measureText(title).width;
    ctx.font = `${subPx}px system-ui, sans-serif`;
    const subW = ctx.measureText(sub).width;
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(
      cx,
      cy,
      Math.max(titleW, subW) + pad * 2,
      titlePx + subPx + pad * 2.5,
    );
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${titlePx}px system-ui, sans-serif`;
    ctx.fillText(title, cx + pad, cy + pad + titlePx);
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = `${subPx}px system-ui, sans-serif`;
    ctx.fillText(sub, cx + pad, cy + pad * 1.5 + titlePx + subPx);

    ctx.restore();
  });

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed."))),
      "image/png",
    );
  });
}

// ---------------------------------------------------------------------------
// Applying a skin
// ---------------------------------------------------------------------------

/**
 * Slice an edited template image back into per-cell textures and swap them
 * onto the model's materials. The image can be any resolution — cells are
 * located proportionally — and a single-texture model accepts a plain
 * texture image (no grid).
 */
export function applySkinImage(
  vrm: VRM,
  image: HTMLImageElement | ImageBitmap,
): void {
  const state = getSkinState(vrm);
  const { layout } = state;
  if (layout.cells.length === 0) {
    throw new Error("This model has no base-color textures to reskin.");
  }

  const srcW = image.width;
  const srcH = image.height;
  if (!srcW || !srcH) throw new Error("That image has no size.");

  const newTextures: THREE.Texture[] = [];
  layout.cells.forEach((cell, i) => {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const sw = srcW / layout.cols;
    const sh = srcH / layout.rows;

    const texImage = cell.texture.image as { width?: number; height?: number };
    const outW = texImage?.width || 1024;
    const outH = texImage?.height || 1024;

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create a 2D canvas for the skin.");
    ctx.drawImage(image, col * sw, row * sh, sw, sh, 0, 0, outW, outH);

    const tex = new THREE.CanvasTexture(canvas);
    // Match glTF texture conventions so UVs line up with the original.
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = cell.texture.wrapS;
    tex.wrapT = cell.texture.wrapT;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    newTextures.push(tex);

    for (const material of cell.materials) {
      material.map = tex;
      if ("shadeMultiplyTexture" in material && material.shadeMultiplyTexture) {
        material.shadeMultiplyTexture = tex;
      }
      material.needsUpdate = true;
    }
  });

  for (const tex of state.applied) tex.dispose();
  state.applied = newTextures;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw new Error("Could not load/decode that image.");
  }
  return img;
}

export async function applySkinFromFile(vrm: VRM, file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    applySkinImage(vrm, img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function applySkinFromURL(vrm: VRM, url: string): Promise<void> {
  const img = await loadImage(url);
  applySkinImage(vrm, img);
}

/** Restore the model's original textures and free ours. */
export function resetSkin(vrm: VRM): void {
  const state = stateCache.get(vrm);
  if (!state) return;
  for (const [material, orig] of state.originals) {
    material.map = orig.map;
    if (orig.shade !== undefined && "shadeMultiplyTexture" in material) {
      material.shadeMultiplyTexture = orig.shade;
    }
    material.needsUpdate = true;
  }
  for (const tex of state.applied) tex.dispose();
  state.applied = [];
}
