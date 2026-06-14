import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { DebugLandmarks } from "../mocap/types";


/** Body bone connections (MediaPipe pose indices). */
const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [11, 12], // shoulders
  [11, 13], // L shoulder -> elbow
  [13, 15], // L elbow -> wrist
  [12, 14], // R shoulder -> elbow
  [14, 16], // R elbow -> wrist
  [11, 23], // torso sides
  [12, 24],
  [23, 24], // hips
  [23, 25], // L hip -> knee
  [25, 27], // L knee -> ankle
  [24, 26], // R hip -> knee
  [26, 28], // R knee -> ankle
  [27, 29], // L ankle -> heel
  [29, 31], // L heel -> toe
  [27, 31], // L ankle -> toe
  [28, 30], // R ankle -> heel
  [30, 32], // R heel -> toe
  [28, 32], // R ankle -> toe
];

/** Hand bone connections (MediaPipe hand landmark indices, 21 points). */
const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [5, 9], [9, 10], [10, 11], [11, 12], // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20], // little
  [0, 17], // palm
];

/** Face key contour connections — face oval, eyes, eyebrows, lips. */
const FACE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [61,146],[146,91],[91,181],[181,84],[84,17],[17,314],[314,405],[405,321],[321,375],[375,291],
  [61,185],[185,40],[40,39],[39,37],[37,0],[0,267],[267,269],[269,270],[270,409],[409,291],
  [78,95],[95,88],[88,178],[178,87],[87,14],[14,317],[317,402],[402,318],[318,324],[324,308],
  [78,191],[191,80],[80,81],[81,82],[82,13],[13,312],[312,311],[311,310],[310,415],[415,308],
  [263,249],[249,390],[390,373],[373,374],[374,380],[380,381],[381,382],[382,362],
  [263,466],[466,388],[388,387],[387,386],[386,385],[385,384],[384,398],[398,362],
  [276,283],[283,282],[282,295],[295,285],[300,293],[293,334],[334,296],[296,336],
  [33,7],[7,163],[163,144],[144,145],[145,153],[153,154],[154,155],[155,133],
  [33,246],[246,161],[161,160],[160,159],[159,158],[158,157],[157,173],[173,133],
  [46,53],[53,52],[52,65],[65,55],[70,63],[63,105],[105,66],[66,107],
  [10,338],[338,297],[297,332],[332,284],[284,251],[251,389],[389,356],[356,454],[454,323],
  [323,361],[361,288],[288,397],[397,365],[365,379],[379,378],[378,400],[400,377],[377,152],
  [152,148],[148,176],[176,149],[149,150],[150,136],[136,172],[172,58],[58,132],[132,93],
  [93,234],[234,127],[127,162],[162,21],[21,54],[54,103],[103,67],[67,109],[109,10],
];

export interface WebcamViewProps {
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  mirror: boolean;
  showOverlay: boolean;
}

/**
 * Webcam preview with an optional landmark debug overlay.
 * The overlay canvas is drawn in un-mirrored video space and flipped with the
 * same CSS transform as the <video>, so points always line up with the image.
 */
export function WebcamView({
  videoRef,
  debugLandmarksRef,
  mirror,
  showOverlay,
}: WebcamViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let rafId = 0;

    function draw() {
      rafId = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;

      const w = video.videoWidth || 640;
      const h = video.videoHeight || 480;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      if (!showOverlay) return;

      // Canvas native resolution vs CSS display size (e.g. 1280-wide video shown
      // in a 400px pane gives canvasPx ≈ 3.2). All drawing sizes are in canvas
      // pixels; multiply by canvasPx so they appear at the intended CSS-pixel
      // size on screen regardless of how much the pane CSS-scales the canvas.
      const canvasPx = canvas.clientWidth > 0 ? w / canvas.clientWidth : 1;

      const { face, pose, leftHand, rightHand } = debugLandmarksRef.current;

      if (pose) {
        ctx.strokeStyle = "rgba(255, 184, 108, 0.9)";
        ctx.lineWidth = 2;
        for (const [a, b] of POSE_CONNECTIONS) {
          const pa = pose[a];
          const pb = pose[b];
          if (!pa || !pb) continue;
          if ((pa.visibility ?? 1) < 0.5 || (pb.visibility ?? 1) < 0.5) continue;
          ctx.beginPath();
          ctx.moveTo(pa.x * w, pa.y * h);
          ctx.lineTo(pb.x * w, pb.y * h);
          ctx.stroke();
        }
        ctx.fillStyle = "rgba(255, 121, 198, 0.95)";
        for (let i = 0; i < Math.min(pose.length, 33); i++) {
          // 17-22 are the pose model's coarse hand points â€" the dedicated
          // hand overlay covers those.
          if (i >= 17 && i <= 22) continue;
          const p = pose[i];
          if (!p || (p.visibility ?? 1) < 0.5) continue;
          ctx.beginPath();
          ctx.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      for (const hand of [leftHand, rightHand]) {
        if (!hand) continue;
        ctx.strokeStyle = "rgba(140, 220, 255, 0.9)";
        ctx.lineWidth = 1.5;
        for (const [a, b] of HAND_CONNECTIONS) {
          const pa = hand[a];
          const pb = hand[b];
          if (!pa || !pb) continue;
          ctx.beginPath();
          ctx.moveTo(pa.x * w, pa.y * h);
          ctx.lineTo(pb.x * w, pb.y * h);
          ctx.stroke();
        }
        ctx.fillStyle = "rgba(140, 220, 255, 0.95)";
        for (const p of hand) {
          ctx.beginPath();
          ctx.arc(p.x * w, p.y * h, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (face) {
        ctx.strokeStyle = "rgba(140, 200, 255, 0.85)";
        ctx.lineWidth = 1.5 * canvasPx;
        for (const [a, b] of FACE_CONNECTIONS) {
          const pa = face[a];
          const pb = face[b];
          if (!pa || !pb) continue;
          ctx.beginPath();
          ctx.moveTo(pa.x * w, pa.y * h);
          ctx.lineTo(pb.x * w, pb.y * h);
          ctx.stroke();
        }
      }

      // Face detection status badge — always drawn last so it's on top.
      // Shows "face: 478 lm" (green) when landmarks arrive, "face: –" (red) when not.
      // Counter-mirror: canvas+video both have CSS scaleX(-1). Drawing near the
      // right edge of canvas-space appears at the left after the CSS flip. We
      // apply translate+scale(-1,1) so text is pre-mirrored (double-flip = readable)
      // and positioned at the visual top-left corner of the display.
      {
        const txt = face ? `face: ${face.length} lm` : "face: –";
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        const tf = Math.round(12 * canvasPx);
        ctx.font = `bold ${tf}px monospace`;
        const tw = ctx.measureText(txt).width;
        const pad = 5 * canvasPx;
        const bh = 22 * canvasPx;
        ctx.fillStyle = face ? "rgba(0,160,70,0.85)" : "rgba(200,30,30,0.85)";
        ctx.fillRect(4 * canvasPx, 4 * canvasPx, tw + pad * 2, bh);
        ctx.fillStyle = "#fff";
        ctx.fillText(txt, 4 * canvasPx + pad, 4 * canvasPx + bh * 0.72);
        ctx.restore();
      }
    }

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [showOverlay, debugLandmarksRef, videoRef]);

  const flip = mirror ? { transform: "scaleX(-1)" } : undefined;

  return (
    <div className="webcam-view">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={flip}
        className="webcam-video"
      />
      <canvas ref={canvasRef} style={flip} className="webcam-overlay" />
    </div>
  );
}
