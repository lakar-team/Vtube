import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { DebugLandmarks } from "../mocap/types";
import { FACE_TESSELATION, FACE_CONTOURS } from "./faceMeshData";

export interface FaceMeshDebugViewProps {
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
}

/**
 * Isolated face-mesh debug panel (sits under the avatar/VRM view).
 *
 * Crops and zooms to the face bounding box so the dense 468-point tessellation
 * is always large and clearly visible, independent of the webcam preview pane.
 * Canvas pixel size == CSS display size (no scaling mismatch), so 1px lineWidth
 * really is 1 screen pixel. Reads the same debug.face landmarks the skeleton
 * viewport uses, so it doubles as a sanity check: if the mesh shows here, the
 * face landmarks are flowing.
 */
export function FaceMeshDebugView({ debugLandmarksRef }: FaceMeshDebugViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let rafId = 0;

    function draw() {
      rafId = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Match canvas bitmap to its CSS display size so canvasPx = 1 always.
      const cw = canvas.clientWidth || 320;
      const ch = canvas.clientHeight || 200;
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, cw, ch);

      const face = debugLandmarksRef.current.face;

      if (!face) {
        ctx.fillStyle = "rgba(140,140,160,0.5)";
        ctx.font = "13px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("no face detected", cw / 2, ch / 2);
        return;
      }

      // Bounding box in normalised [0..1] space across 468 mesh landmarks
      let minX = 1, maxX = 0, minY = 1, maxY = 0;
      for (let i = 0; i < 468; i++) {
        const p = face[i];
        if (!p) continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }

      const bboxW = Math.max(maxX - minX, 0.01);
      const bboxH = Math.max(maxY - minY, 0.01);
      const pad = 0.12 * Math.max(bboxW, bboxH);
      const srcW = bboxW + 2 * pad;
      const srcH = bboxH + 2 * pad;

      // Uniform scale: fit padded bbox into canvas, centred
      const scale = Math.min(cw / srcW, ch / srcH);
      const ox = (cw - srcW * scale) / 2 - (minX - pad) * scale;
      const oy = (ch - srcH * scale) / 2 - (minY - pad) * scale;

      const toX = (nx: number) => nx * scale + ox;
      const toY = (ny: number) => ny * scale + oy;

      // Tessellation wireframe (faint)
      ctx.strokeStyle = "rgba(80, 250, 123, 0.35)";
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (let i = 0; i < FACE_TESSELATION.length; i += 2) {
        const pa = face[FACE_TESSELATION[i]];
        const pb = face[FACE_TESSELATION[i + 1]];
        if (!pa || !pb) continue;
        ctx.moveTo(toX(pa.x), toY(pa.y));
        ctx.lineTo(toX(pb.x), toY(pb.y));
      }
      ctx.stroke();

      // Key contours (bright)
      ctx.strokeStyle = "rgba(80, 250, 123, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < FACE_CONTOURS.length; i += 2) {
        const pa = face[FACE_CONTOURS[i]];
        const pb = face[FACE_CONTOURS[i + 1]];
        if (!pa || !pb) continue;
        ctx.moveTo(toX(pa.x), toY(pa.y));
        ctx.lineTo(toX(pb.x), toY(pb.y));
      }
      ctx.stroke();

      // Landmark dots
      ctx.fillStyle = "rgba(80, 250, 123, 0.85)";
      for (let i = 0; i < 468; i++) {
        const p = face[i];
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(toX(p.x), toY(p.y), 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Status label bottom-left
      ctx.fillStyle = "rgba(80,250,123,0.55)";
      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText("face mesh  " + face.length + " lm", 6, ch - 4);
    }

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [debugLandmarksRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    />
  );
}
