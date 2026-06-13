import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { DebugLandmarks } from "../mocap/types";

/**
 * Diagnostic skeleton view: renders raw MediaPipe pose + hand landmarks as
 * a Three.js stick figure, with ZERO retargeting or rotation inference.
 *
 * Coordinate mapping (image-normalized → Three.js):
 *   x: mirrored if mirror=true (so skeleton matches the webcam view)
 *   y: flipped (MediaPipe y grows downward; Three.js y grows upward)
 *   z: negated (MediaPipe image-z is depth toward camera; small effect but
 *      gives some 3-D when leaning forward/sideways)
 *
 * If this skeleton moves correctly but the VRM avatar doesn't → the issue
 * is in the retargeting layer (kalidokitAdapter / applyMocapToVRM).
 * If this skeleton also looks wrong → the issue is upstream in landmark
 * capture or smoothing.
 */

const SCALE = 4.0;

// Pose connections split by screen side (mirror convention: landmark 11 =
// anatomical left shoulder = LEFT side of the mirrored display, colored blue).
const POSE_LEFT: ReadonlyArray<readonly [number, number]> = [
  [0, 11],
  [11, 23],
  [11, 13],
  [13, 15],
  [23, 25],
  [25, 27],
  [27, 29],
  [29, 31],
  [27, 31],
];

const POSE_RIGHT: ReadonlyArray<readonly [number, number]> = [
  [0, 12],
  [12, 24],
  [12, 14],
  [14, 16],
  [24, 26],
  [26, 28],
  [28, 30],
  [30, 32],
  [28, 32],
];

const POSE_CENTER: ReadonlyArray<readonly [number, number]> = [
  [11, 12],
  [23, 24],
];

const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// Joint dots shown for major pose landmarks.
const POSE_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

// blue/red left/right, lighter variants for hands
const C_LEFT   = 0x4488ff;
const C_RIGHT  = 0xff4444;
const C_CENTER = 0x888899;
const C_HLEFT  = 0x88bbff;
const C_HRIGHT = 0xff8888;

function makeSegs(count: number, color: number): THREE.LineSegments {
  const buf = new Float32Array(count * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(buf, 3).setUsage(THREE.DynamicDrawUsage),
  );
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
}

function writeSegs(
  seg: THREE.LineSegments,
  lms: NormalizedLandmark[] | null,
  pairs: ReadonlyArray<readonly [number, number]>,
  mx: number,
  minVis = 0.45,
): void {
  if (!lms) { seg.visible = false; return; }
  seg.visible = true;
  const attr = seg.geometry.attributes.position as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  let i = 0;
  for (const [a, b] of pairs) {
    const la = lms[a];
    const lb = lms[b];
    if (la && lb && (la.visibility ?? 1) >= minVis && (lb.visibility ?? 1) >= minVis) {
      arr[i++] = mx * (la.x - 0.5) * SCALE;
      arr[i++] = -(la.y - 0.5) * SCALE;
      arr[i++] = -(la.z ?? 0) * SCALE;
      arr[i++] = mx * (lb.x - 0.5) * SCALE;
      arr[i++] = -(lb.y - 0.5) * SCALE;
      arr[i++] = -(lb.z ?? 0) * SCALE;
    } else {
      // Degenerate segment collapses to a point — invisible.
      arr[i] = arr[i + 1] = arr[i + 2] = arr[i + 3] = arr[i + 4] = arr[i + 5] = 0;
      i += 6;
    }
  }
  attr.needsUpdate = true;
}

export interface SkeletonViewportProps {
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  mirror: boolean;
}

export function SkeletonViewport({ debugLandmarksRef, mirror }: SkeletonViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / Math.max(container.clientHeight, 1),
      0.1,
      20,
    );
    camera.position.set(0, 0, 5.5);
    camera.lookAt(0, 0, 0);

    const grid = new THREE.GridHelper(8, 16, 0x333355, 0x1a1a2e);
    grid.position.y = -2.2;
    scene.add(grid);

    const poseL = makeSegs(POSE_LEFT.length,        C_LEFT);
    const poseR = makeSegs(POSE_RIGHT.length,        C_RIGHT);
    const poseC = makeSegs(POSE_CENTER.length,       C_CENTER);
    const hL    = makeSegs(HAND_CONNECTIONS.length,  C_HLEFT);
    const hR    = makeSegs(HAND_CONNECTIONS.length,  C_HRIGHT);
    scene.add(poseL, poseR, poseC, hL, hR);

    // Joint dot cloud — updated every frame.
    const MAX_PTS = POSE_JOINTS.length + 21 + 21;
    const ptPos = new Float32Array(MAX_PTS * 3);
    const ptCol = new Float32Array(MAX_PTS * 3);
    const ptGeo = new THREE.BufferGeometry();
    ptGeo.setAttribute("position", new THREE.BufferAttribute(ptPos, 3).setUsage(THREE.DynamicDrawUsage));
    ptGeo.setAttribute("color",    new THREE.BufferAttribute(ptCol, 3).setUsage(THREE.DynamicDrawUsage));
    const dots = new THREE.Points(
      ptGeo,
      new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true }),
    );
    scene.add(dots);

    let disposed = false;

    renderer.setAnimationLoop(() => {
      if (disposed) return;
      const debug = debugLandmarksRef.current;
      const mx = mirrorRef.current ? -1 : 1;

      writeSegs(poseL, debug.pose,      POSE_LEFT,        mx);
      writeSegs(poseR, debug.pose,      POSE_RIGHT,       mx);
      writeSegs(poseC, debug.pose,      POSE_CENTER,      mx);
      writeSegs(hL,    debug.leftHand,  HAND_CONNECTIONS, mx, 0);
      writeSegs(hR,    debug.rightHand, HAND_CONNECTIONS, mx, 0);

      // Update joint dots with per-point color.
      let ji = 0;
      const put = (lm: NormalizedLandmark, r: number, g: number, b: number) => {
        ptPos[ji * 3]     = mx * (lm.x - 0.5) * SCALE;
        ptPos[ji * 3 + 1] = -(lm.y - 0.5) * SCALE;
        ptPos[ji * 3 + 2] = -(lm.z ?? 0) * SCALE;
        ptCol[ji * 3] = r; ptCol[ji * 3 + 1] = g; ptCol[ji * 3 + 2] = b;
        ji++;
      };

      if (debug.pose) {
        for (const idx of POSE_JOINTS) {
          const lm = debug.pose[idx];
          if (lm && (lm.visibility ?? 1) >= 0.45) {
            if (idx === 0) {
              put(lm, 1, 1, 1);                    // nose: white
            } else if (idx >= 11 && idx % 2 === 1) {
              put(lm, 0.27, 0.53, 1);              // odd ≥11 = left: blue
            } else {
              put(lm, 1, 0.27, 0.27);              // even ≥12 = right: red
            }
          }
        }
      }

      if (debug.leftHand) {
        for (const lm of debug.leftHand) put(lm, 0.53, 0.73, 1);
      }
      if (debug.rightHand) {
        for (const lm of debug.rightHand) put(lm, 1, 0.53, 0.53);
      }

      ptGeo.setDrawRange(0, ji);
      (ptGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (ptGeo.attributes.color    as THREE.BufferAttribute).needsUpdate = true;

      renderer.render(scene, camera);
    });

    const onResize = () => {
      const w = container.clientWidth;
      const h = Math.max(container.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.domElement.remove();
      for (const seg of [poseL, poseR, poseC, hL, hR]) {
        seg.geometry.dispose();
        (seg.material as THREE.Material).dispose();
      }
      ptGeo.dispose();
      (dots.material as THREE.Material).dispose();
    };
  }, [debugLandmarksRef]);

  return (
    <div ref={containerRef} className="avatar-viewport">
      <div className="viewport-badge">
        skeleton diagnostic — raw MediaPipe landmarks ·{" "}
        <span style={{ color: "#4488ff" }}>blue=left</span> ·{" "}
        <span style={{ color: "#ff4444" }}>red=right</span>
      </div>
    </div>
  );
}
