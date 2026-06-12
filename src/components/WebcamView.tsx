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

      const { face, pose, leftHand, rightHand } = debugLandmarksRef.current;

      if (face) {
        ctx.fillStyle = "rgba(80, 250, 123, 0.85)";
        for (let i = 0; i < face.length; i += 2) {
          const p = face[i];
          ctx.fillRect(p.x * w - 0.75, p.y * h - 0.75, 1.5, 1.5);
        }
      }

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
          // 17-22 are the pose model's coarse hand points — the dedicated
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
