import { useEffect, useState } from "react";
import type { RefObject } from "react";

export interface WebcamState {
  ready: boolean;
  error: string | null;
}

/**
 * Acquire the webcam and attach it to the provided <video> element.
 * 640x480@30 is plenty for landmark tracking and keeps inference fast.
 */
export function useWebcam(videoRef: RefObject<HTMLVideoElement | null>): WebcamState {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 },
            facingMode: "user",
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        if (!cancelled) setReady(true);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof DOMException && err.name === "NotAllowedError"
              ? "Camera permission denied. Allow camera access and reload."
              : `Could not start webcam: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ready, error };
}
