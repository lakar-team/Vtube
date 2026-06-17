import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { DebugLandmarks, MocapFrame } from "../mocap/types";
import type { RigConfig } from "../mocap/rig";
import { FACE_CONTOURS, FACE_TRIANGLES } from "./faceMeshData";

/**
 * VIEWPORT: 3D Room View (right pane) — Performance View.
 *
 * Renders the mocap subject as a real-scale mannequin in a metric room, driven
 * as a FIXED-PROPORTION rig: bone LENGTHS and thicknesses come from the captured
 * RigConfig (constant), and each frame mocap supplies only the bone DIRECTIONS
 * (from poseWorld landmark deltas — direction is scale-invariant, so the
 * subject's distance never changes any size). Joints are rebuilt by forward
 * kinematics from a hip root at the captured hip height; head/face/hands are
 * sized from RigConfig too. When a direction isn't available the bone falls back
 * to a default T-pose direction, so the mannequin is always visible (e.g. for
 * tuning before any mocap).
 *
 * COORDINATE CONVENTION: poseWorld is meters, y-DOWN, hip-origin. Directions are
 * computed in room space = (mirror*x, -y, -z), normalized; lengths/radii come
 * from RigConfig (cm → m). All cylinders/spheres are unit-sized and scaled per
 * frame, so tuning radii is live.
 */

const MIN_VIS = 0.5;
const ROOM_DEFAULT = 2.5;
const LIMB_TAPER = 0.72;        // distal-end radius as a fraction of the proximal end
const FACE_W_FIT = 0.92;        // rendered face width as a fraction of the head diameter (at faceScale 1)
const FALLBACK_FACE_W = 0.13;   // constant cheek-hinge width used when cheekHingeNorm is OFF
const HEAD_SPHERE_FIT = 0.72;   // visible head-sphere radius vs headR — shrunk so it sits BEHIND the eyes

const NOSE = 0, EAR_L = 7, EAR_R = 8;
const SH_L = 11, SH_R = 12, EL_L = 13, EL_R = 14, WR_L = 15, WR_R = 16;
const HIP_L = 23, HIP_R = 24, KN_L = 25, KN_R = 26, AN_L = 27, AN_R = 28;
const TOE_L = 31, TOE_R = 32;

const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
// Canonical bone length as a fraction of hand length (wrist→middle-fingertip),
// matching HAND_BONES order. Finger lengths = fraction × captured handLengthCm
// (fixed), with live directions — so the hand never rescales with distance.
const HAND_BONE_FRAC: readonly number[] = [
  0.28, 0.16, 0.12, 0.10,   // thumb
  0.46, 0.22, 0.13, 0.09,   // index (palm 0→5, then phalanges)
  0.07, 0.24, 0.14, 0.09,   // middle
  0.07, 0.22, 0.13, 0.09,   // ring
  0.07, 0.18, 0.10, 0.08,   // little
  0.42,                     // palm edge 0→17 (drawn only)
];
// Which finger each HAND_BONES entry belongs to → index into the per-frame
// multiplier array [thumb, index, middle, ring, little]. Bone 20 (palm edge) is
// structural, never scaled (-1).
const HAND_BONE_FINGER: readonly number[] = [
  0, 0, 0, 0,   // thumb
  1, 1, 1, 1,   // index
  2, 2, 2, 2,   // middle
  3, 3, 3, 3,   // ring
  4, 4, 4, 4,   // little
  -1,           // palm edge
];
// Per-bone radius as a fraction of the base finger radius — thicker near the
// palm, thinner toward the tips, so each finger tapers naturally.
const HAND_BONE_R: readonly number[] = [
  1.05, 0.92, 0.80, 0.66,   // thumb
  0.98, 0.84, 0.72, 0.58,   // index
  0.98, 0.86, 0.74, 0.60,   // middle
  0.92, 0.80, 0.68, 0.56,   // ring
  0.84, 0.72, 0.62, 0.52,   // little
  0.80,                     // palm edge
];

// Default directions in room space, used when a live direction is missing. These
// describe a relaxed STANDING REST POSE (A-pose): arms hanging slightly out from
// the body, legs straight down, head/torso upright — so a lost or partial body
// snaps to a natural stance instead of a curled/fetal extrapolation.
const D_UP   = new THREE.Vector3(0, 1, 0);
const D_DOWN = new THREE.Vector3(0, -1, 0);
const D_X    = new THREE.Vector3(1, 0, 0);
const D_FOOT = new THREE.Vector3(0, -0.3, 1).normalize();
// Upper arms angle ~27° out from vertical, forearms hang nearer vertical.
const D_UARM_REST_L = new THREE.Vector3(-0.45, -0.89, 0).normalize();
const D_UARM_REST_R = new THREE.Vector3( 0.45, -0.89, 0).normalize();
const D_LARM_REST_L = new THREE.Vector3(-0.28, -0.96, 0.02).normalize();
const D_LARM_REST_R = new THREE.Vector3( 0.28, -0.96, 0.02).normalize();

// Palm-fan metacarpal bones (wrist/knuckle web): NOT drawn as thin cylinders —
// the palm is rendered as one flattened box instead. Keyed by HAND_BONES index.
const PALM_FAN_BONES = new Set<number>([4, 8, 12, 16]);

// Mixamo bone name → GLB bone name lookup.
// Keys ARE the standard Mixamo names; values match by default but are rewritten
// for colon-prefix exports (mixamorig:Hips style) or overridden by a sidecar .json.
const DEFAULT_BONE_MAP: Record<string, string> = {
  // Body
  mixamorigHips:           "mixamorigHips",
  mixamorigSpine:          "mixamorigSpine",
  mixamorigSpine1:         "mixamorigSpine1",
  mixamorigSpine2:         "mixamorigSpine2",
  mixamorigNeck:           "mixamorigNeck",
  mixamorigHead:           "mixamorigHead",
  mixamorigLeftShoulder:   "mixamorigLeftShoulder",
  mixamorigRightShoulder:  "mixamorigRightShoulder",
  mixamorigLeftArm:        "mixamorigLeftArm",
  mixamorigRightArm:       "mixamorigRightArm",
  mixamorigLeftForeArm:    "mixamorigLeftForeArm",
  mixamorigRightForeArm:   "mixamorigRightForeArm",
  mixamorigLeftHand:       "mixamorigLeftHand",
  mixamorigRightHand:      "mixamorigRightHand",
  mixamorigLeftUpLeg:      "mixamorigLeftUpLeg",
  mixamorigRightUpLeg:     "mixamorigRightUpLeg",
  mixamorigLeftLeg:        "mixamorigLeftLeg",
  mixamorigRightLeg:       "mixamorigRightLeg",
  mixamorigLeftFoot:       "mixamorigLeftFoot",
  mixamorigRightFoot:      "mixamorigRightFoot",
  // Left fingers
  mixamorigLeftHandThumb1:  "mixamorigLeftHandThumb1",
  mixamorigLeftHandThumb2:  "mixamorigLeftHandThumb2",
  mixamorigLeftHandThumb3:  "mixamorigLeftHandThumb3",
  mixamorigLeftHandIndex1:  "mixamorigLeftHandIndex1",
  mixamorigLeftHandIndex2:  "mixamorigLeftHandIndex2",
  mixamorigLeftHandIndex3:  "mixamorigLeftHandIndex3",
  mixamorigLeftHandMiddle1: "mixamorigLeftHandMiddle1",
  mixamorigLeftHandMiddle2: "mixamorigLeftHandMiddle2",
  mixamorigLeftHandMiddle3: "mixamorigLeftHandMiddle3",
  mixamorigLeftHandRing1:   "mixamorigLeftHandRing1",
  mixamorigLeftHandRing2:   "mixamorigLeftHandRing2",
  mixamorigLeftHandRing3:   "mixamorigLeftHandRing3",
  mixamorigLeftHandPinky1:  "mixamorigLeftHandPinky1",
  mixamorigLeftHandPinky2:  "mixamorigLeftHandPinky2",
  mixamorigLeftHandPinky3:  "mixamorigLeftHandPinky3",
  // Right fingers
  mixamorigRightHandThumb1:  "mixamorigRightHandThumb1",
  mixamorigRightHandThumb2:  "mixamorigRightHandThumb2",
  mixamorigRightHandThumb3:  "mixamorigRightHandThumb3",
  mixamorigRightHandIndex1:  "mixamorigRightHandIndex1",
  mixamorigRightHandIndex2:  "mixamorigRightHandIndex2",
  mixamorigRightHandIndex3:  "mixamorigRightHandIndex3",
  mixamorigRightHandMiddle1: "mixamorigRightHandMiddle1",
  mixamorigRightHandMiddle2: "mixamorigRightHandMiddle2",
  mixamorigRightHandMiddle3: "mixamorigRightHandMiddle3",
  mixamorigRightHandRing1:   "mixamorigRightHandRing1",
  mixamorigRightHandRing2:   "mixamorigRightHandRing2",
  mixamorigRightHandRing3:   "mixamorigRightHandRing3",
  mixamorigRightHandPinky1:  "mixamorigRightHandPinky1",
  mixamorigRightHandPinky2:  "mixamorigRightHandPinky2",
  mixamorigRightHandPinky3:  "mixamorigRightHandPinky3",
};

// [parentLandmark, childLandmark] pairs for Mixamo finger bones (15 per hand).
// Ordered Thumb123 / Index123 / Middle123 / Ring123 / Pinky123.
const FINGER_LM_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];
const FINGER_BONES_L: readonly string[] = [
  "mixamorigLeftHandThumb1",  "mixamorigLeftHandThumb2",  "mixamorigLeftHandThumb3",
  "mixamorigLeftHandIndex1",  "mixamorigLeftHandIndex2",  "mixamorigLeftHandIndex3",
  "mixamorigLeftHandMiddle1", "mixamorigLeftHandMiddle2", "mixamorigLeftHandMiddle3",
  "mixamorigLeftHandRing1",   "mixamorigLeftHandRing2",   "mixamorigLeftHandRing3",
  "mixamorigLeftHandPinky1",  "mixamorigLeftHandPinky2",  "mixamorigLeftHandPinky3",
];
const FINGER_BONES_R: readonly string[] = [
  "mixamorigRightHandThumb1",  "mixamorigRightHandThumb2",  "mixamorigRightHandThumb3",
  "mixamorigRightHandIndex1",  "mixamorigRightHandIndex2",  "mixamorigRightHandIndex3",
  "mixamorigRightHandMiddle1", "mixamorigRightHandMiddle2", "mixamorigRightHandMiddle3",
  "mixamorigRightHandRing1",   "mixamorigRightHandRing2",   "mixamorigRightHandRing3",
  "mixamorigRightHandPinky1",  "mixamorigRightHandPinky2",  "mixamorigRightHandPinky3",
];

// Eyelid-ring landmarks, ordered around each eye (lower lid then upper lid), used
// to build a smooth almond eye SOCKET (triangle fan) rather than a jagged
// triangle cutout.
const RIGHT_EYE_RING = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const LEFT_EYE_RING = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];

// ─── shared temporaries ───────────────────────────────────────────────────
const _v2 = new THREE.Vector3();
const _q  = new THREE.Quaternion();
const _Y  = new THREE.Vector3(0, 1, 0);
const _fUp   = new THREE.Vector3();
const _fSide = new THREE.Vector3();
const _fN    = new THREE.Vector3();
const _pU = new THREE.Vector3();
const _pW = new THREE.Vector3();
const _pR = new THREE.Vector3();
const _pF = new THREE.Vector3();
const _pC = new THREE.Vector3();
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _hq = new THREE.Quaternion();

/** Unit cylinder, optionally tapered: top (distal, +Y) radius = `taper` × bottom. */
function makeCyl(mat: THREE.Material, taper = 1): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(taper, 1, 1, 14, 1), mat);
}
function makeSph(mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), mat);
}

/** Place a unit cylinder as a bone a→b with the given radius (meters). */
function placeCyl(mesh: THREE.Mesh, a: THREE.Vector3 | null, b: THREE.Vector3 | null, radius: number): void {
  if (!a || !b) { mesh.visible = false; return; }
  const length = a.distanceTo(b);
  if (length < 1e-4) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  _v2.subVectors(b, a).normalize();
  _q.setFromUnitVectors(_Y, _v2);
  mesh.quaternion.copy(_q);
  mesh.scale.set(radius, length, radius);
}
/** Place a unit sphere at p with the given radius (meters). */
function placeSph(mesh: THREE.Mesh, p: THREE.Vector3 | null, radius: number): void {
  if (!p) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.copy(p);
  mesh.scale.setScalar(radius);
}
const _m4 = new THREE.Matrix4();
/** Place a unit box at `center`, oriented by an orthonormal basis (x,y,z), with
 *  full extents (sx,sy,sz) in meters. */
function placeBox(
  mesh: THREE.Mesh, center: THREE.Vector3,
  x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3,
  sx: number, sy: number, sz: number,
): void {
  _m4.makeBasis(x, y, z);
  mesh.quaternion.setFromRotationMatrix(_m4);
  mesh.position.copy(center);
  mesh.scale.set(sx, sy, sz);
  mesh.visible = true;
}

interface HandRig {
  joints: THREE.Mesh[];   // 21 small spheres (rounded knuckle/tip caps)
  bones: THREE.Mesh[];    // 21 tapered cylinders, one per HAND_BONES entry
  palm: THREE.Mesh;       // flattened box across the metacarpals
}

/** Landmark persistence (hold-last-good) + temporal smoothing options. */
export interface LandmarkOptions {
  persistPose: boolean;
  persistHands: boolean;
  persistFace: boolean;
  smoothing: boolean;
  /** 0 = none … ~0.9 = heavy (EMA amount). */
  smoothAmount: number;
}

/**
 * Behavioural processing rules — every meaningful modifier the render loop can
 * apply, exposed as live toggles by the Rules Inspector view. All default true.
 */
export interface RuleFlags {
  /** Legs snap to a straight-down rest pose when the lower body isn't tracked. */
  legsRestOnLoss: boolean;
  /** Face mesh orbits the head-sphere centre (fulcrum shift), not its own plane. */
  faceFulcrum: boolean;
  /** Forward-kinematics fingers (off → just a fist sphere at the wrist). */
  fingerFK: boolean;
  /** Eyes anchored in the face-local frame (off → head-local frame). */
  faceLocalEyes: boolean;
  /** Face size from the cheek-hinge width (off → distance-variant fixed guess). */
  cheekHingeNorm: boolean;
  /** Draw the face surface mesh. */
  showFaceMesh: boolean;
  /** Draw the eyeballs + irises. */
  showEyes: boolean;
  /** Drive the loaded GLB model instead of the procedural skeleton. */
  useCustomModel: boolean;
  /** Apply ARKit blendshapes to the GLB model's face mesh (disable for helmets/robots). */
  useModelFace: boolean;
}

export const DEFAULT_RULES: RuleFlags = {
  legsRestOnLoss: true,
  faceFulcrum: true,
  fingerFK: true,
  faceLocalEyes: true,
  cheekHingeNorm: true,
  showFaceMesh: true,
  showEyes: true,
  useCustomModel: false,
  useModelFace: true,
};

export interface RoomViewportProps {
  debugLandmarksRef: MutableRefObject<DebugLandmarks>;
  /** Smoothed mocap frame — read for eye gaze (pupil). */
  frameRef: MutableRefObject<MocapFrame | null>;
  /** Captured (or tuned) fixed body proportions — drives the whole rig. */
  rigConfig: RigConfig;
  mirror: boolean;
  /** Room cube side length (meters). */
  roomM: number;
  /** Per-stream persistence + smoothing. */
  lmOpts: LandmarkOptions;
  /** Behavioural processing rules (Rules Inspector toggles). */
  rules?: RuleFlags;
  /** Object URL for a loaded GLB/GLTF file to drive instead of the procedural skeleton. */
  modelUrl?: string | null;
  /** Overrides for the default Mixamo bone name map. Keys = Mixamo bone names. */
  modelBoneMapOverride?: Record<string, string> | null;
}

interface LoadedModel {
  group: THREE.Group;
  bones: Map<string, THREE.Bone>;
  boneMap: Record<string, string>;
  hipsLocalY: number;
}

// Module-scope temps for bone driving — allocated once, reused every frame.
const _bDir       = new THREE.Vector3();
const _bTQ        = new THREE.Quaternion();
const _bPQ        = new THREE.Quaternion();
const _bYup       = new THREE.Vector3(0, 1, 0);
const _qTorsoFull = new THREE.Quaternion();
const _qSpinePart = new THREE.Quaternion();
const _qIdent     = new THREE.Quaternion(); // stays identity (0,0,0,1)
const _spineD     = new THREE.Vector3();
const _fingerD    = new THREE.Vector3();

export function RoomViewport({
  debugLandmarksRef,
  frameRef,
  rigConfig,
  mirror,
  roomM,
  lmOpts,
  rules = DEFAULT_RULES,
  modelUrl,
  modelBoneMapOverride,
}: RoomViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const roomMRef = useRef(roomM);
  roomMRef.current = roomM;
  const rigRef = useRef(rigConfig);
  rigRef.current = rigConfig;
  const lmOptsRef = useRef(lmOpts);
  lmOptsRef.current = lmOpts;
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  // GLB model loading state — bridged between the scene effect and the load effect.
  const sceneRef           = useRef<THREE.Scene | null>(null);
  const figureRef          = useRef<THREE.Group | null>(null);
  const loadedModelRef     = useRef<LoadedModel | null>(null);
  const modelBoneMapRef    = useRef(modelBoneMapOverride ?? null);
  modelBoneMapRef.current  = modelBoneMapOverride ?? null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w0 = container.clientWidth;
    const h0 = Math.max(container.clientHeight, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w0, h0);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.05, 500);
    const r0 = roomMRef.current || ROOM_DEFAULT;
    camera.position.set(r0 * 0.85, 1.55, r0 * 1.45);
    camera.lookAt(0, 1.0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.enableDamping = true;
    controls.update();

    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
    key.position.set(1.5, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xaaccff, Math.PI * 0.3);
    fill.position.set(-2, 1, -1);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));

    const grid = new THREE.GridHelper(1, 10, 0x556699, 0x2a2a40);
    scene.add(grid);
    const cube = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x445577 }),
    );
    scene.add(cube);

    const matL = new THREE.MeshLambertMaterial({ color: 0x4477cc }); // blue = left
    const matR = new THREE.MeshLambertMaterial({ color: 0xcc3344 }); // red  = right
    const matC = new THREE.MeshLambertMaterial({ color: 0xd4b080 }); // tan  = centre

    const figure = new THREE.Group();
    figureRef.current = figure;
    scene.add(figure);

    const mHead   = makeSph(matC);
    const mNeck   = makeCyl(matC);
    const mSpine  = makeCyl(matC);
    const mSpine1 = makeCyl(matC);
    const mSpine2 = makeCyl(matC);

    // Limb cylinders taper toward the extremity for a more anatomical look.
    const mUArmL = makeCyl(matL, LIMB_TAPER); const mUArmR = makeCyl(matR, LIMB_TAPER);
    const mLArmL = makeCyl(matL, LIMB_TAPER); const mLArmR = makeCyl(matR, LIMB_TAPER);
    const mHandL = makeSph(matL); const mHandR = makeSph(matR);
    const mULegL = makeCyl(matL, LIMB_TAPER); const mULegR = makeCyl(matR, LIMB_TAPER);
    const mLLegL = makeCyl(matL, LIMB_TAPER); const mLLegR = makeCyl(matR, LIMB_TAPER);
    const mFootL = makeCyl(matL, LIMB_TAPER); const mFootR = makeCyl(matR, LIMB_TAPER);

    const mJShL = makeSph(matL); const mJShR = makeSph(matR);
    const mJElL = makeSph(matL); const mJElR = makeSph(matR);
    const mJWrL = makeSph(matL); const mJWrR = makeSph(matR);
    const mJHpL = makeSph(matL); const mJHpR = makeSph(matR);
    const mJKnL = makeSph(matL); const mJKnR = makeSph(matR);
    const mJAnL = makeSph(matL); const mJAnR = makeSph(matR);

    const meshes: THREE.Mesh[] = [
      mHead, mNeck, mSpine, mSpine1, mSpine2,
      mUArmL, mLArmL, mHandL, mULegL, mLLegL, mFootL,
      mUArmR, mLArmR, mHandR, mULegR, mLLegR, mFootR,
      mJShL, mJElL, mJWrL, mJHpL, mJKnL, mJAnL,
      mJShR, mJElR, mJWrR, mJHpR, mJKnR, mJAnR,
    ];
    for (const m of meshes) { m.visible = false; figure.add(m); }

    // Face: one shared 468-vertex position buffer feeds a SOLID, FULLY OPAQUE
    // triangle surface (FACE_TRIANGLES) — a true occluder. It is single-sided
    // (FrontSide; the correct winding is chosen per-frame, since mirroring flips
    // it) so back-facing triangles never render, and it writes depth so the
    // contour overlay and anything behind the head are properly hidden.
    const faceVerts = new Float32Array(468 * 3);
    const facePosAttr = new THREE.BufferAttribute(faceVerts, 3);

    const faceFillGeom = new THREE.BufferGeometry();
    faceFillGeom.setAttribute("position", facePosAttr);
    faceFillGeom.setIndex(new THREE.BufferAttribute(FACE_TRIANGLES, 1));
    // Stencil-tested: draws only where the eye masks did NOT write ref=1, so the
    // eye openings become smooth holes in the otherwise-solid surface.
    const matFaceFill = new THREE.MeshLambertMaterial({
      color: 0xd9a079, side: THREE.FrontSide,
      transparent: false, opacity: 1, depthTest: true, depthWrite: true,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
    });
    const faceFill = new THREE.Mesh(faceFillGeom, matFaceFill);
    faceFill.frustumCulled = false;
    faceFill.renderOrder = 2;
    faceFill.visible = false;
    figure.add(faceFill);

    const faceLineGeom = new THREE.BufferGeometry();
    faceLineGeom.setAttribute("position", facePosAttr);
    faceLineGeom.setIndex(new THREE.BufferAttribute(FACE_CONTOURS, 1));
    // Contours are depth-tested (but don't write depth) so the opaque face
    // occludes the segments on the FAR side of the head — only the near contours
    // show through.
    const matFaceLine = new THREE.LineBasicMaterial({
      color: 0x33586b, transparent: true, opacity: 0.7, depthTest: true, depthWrite: false,
    });
    const faceLine = new THREE.LineSegments(faceLineGeom, matFaceLine);
    faceLine.frustumCulled = false;
    faceLine.renderOrder = 3;
    faceLine.visible = false;
    figure.add(faceLine);

    // Eye masks: a smooth almond polygon (triangle fan over the eyelid ring) per
    // eye. Rendered BEFORE the face writing stencil ref=1 (no colour/depth) — it
    // punches a smooth eye-shaped HOLE in the face, through which the recessed,
    // depth-tested eyeball shows (and is hidden by a hand passing in front).
    const makeSocket = () => {
      const pos = new Float32Array(17 * 3); // centroid + 16 ring points
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const idx: number[] = [];
      for (let k = 0; k < 16; k++) idx.push(0, 1 + k, 1 + ((k + 1) % 16));
      geom.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide, colorWrite: false, depthTest: false, depthWrite: false,
        stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false; mesh.renderOrder = 1; mesh.visible = false;
      figure.add(mesh);
      return { mesh, geom, pos };
    };
    const socketL = makeSocket();
    const socketR = makeSocket();

    // Fingers: tapered cylinder per bone + small spheres at the joints (rounded
    // caps), using the skin-tinted limb material so the hand reads as one piece.
    const makeHand = (mat: THREE.Material): HandRig => {
      const joints = Array.from({ length: 21 }, () => {
        const m = makeSph(mat); m.frustumCulled = false; m.visible = false; figure.add(m); return m;
      });
      const bones = Array.from({ length: HAND_BONES.length }, () => {
        const m = makeCyl(mat, 0.7); m.frustumCulled = false; m.visible = false; figure.add(m); return m;
      });
      const palm = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      palm.frustumCulled = false; palm.visible = false; figure.add(palm);
      return { joints, bones, palm };
    };
    const handLeft = makeHand(matL);
    const handRight = makeHand(matR);

    // ── eyeballs (white) + irises (gaze-driven). DEPTH-TESTED + depth-writing:
    //    they sit recessed behind the face and show only through the stencil eye
    //    holes (the solid face occludes them elsewhere), and a hand passing in
    //    front of the face occludes them too. The head sphere is shrunk (below) so
    //    it doesn't cover the eye area.
    const matEye = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: true, depthWrite: true });
    const matIris = new THREE.MeshBasicMaterial({ color: 0x223a5a, depthTest: true, depthWrite: true });
    const mkEyeSph = (mat: THREE.Material, ro: number) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
      m.frustumCulled = false; m.visible = false; m.renderOrder = ro;
      figure.add(m);
      return m;
    };
    // renderOrder 4/5 — after the face (2) so face depth is written first; depth
    // then governs visibility (through the eye holes, behind hands).
    const mEyeL = mkEyeSph(matEye, 4); const mEyeR = mkEyeSph(matEye, 4);
    const mIrisL = mkEyeSph(matIris, 5); const mIrisR = mkEyeSph(matIris, 5);

    // ── per-stream persistence (hold-last-good) + EMA smoothing ──
    interface LmProc { held: NormalizedLandmark[] | null; sm: NormalizedLandmark[] | null; }
    const poseProc: LmProc = { held: null, sm: null };
    const faceProc: LmProc = { held: null, sm: null };
    const handLProc: LmProc = { held: null, sm: null };
    const handRProc: LmProc = { held: null, sm: null };
    const procLm = (
      st: LmProc, live: NormalizedLandmark[] | null,
      persist: boolean, smoothOn: boolean, alpha: number,
    ): NormalizedLandmark[] | null => {
      if (live) st.held = live;
      const target = live ?? (persist ? st.held : null);
      if (!target) { st.sm = null; return null; }
      if (!smoothOn) { st.sm = null; return target; }
      if (!st.sm || st.sm.length !== target.length) {
        st.sm = target.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 }));
      } else {
        for (let i = 0; i < target.length; i++) {
          const t = target[i], s = st.sm[i];
          s.x += (t.x - s.x) * alpha;
          s.y += (t.y - s.y) * alpha;
          s.z += (t.z - s.z) * alpha;
          (s as { visibility: number }).visibility = t.visibility ?? 1;
        }
      }
      return st.sm;
    };

    let disposed = false;

    // Skin tone — recolour materials only when rig.skinHex changes. Head/neck/
    // torso/face use the pure skin colour; limbs keep a 75/25 blue/red tint so
    // the left/right cue survives.
    let lastSkin = "";
    const _skin = new THREE.Color();
    const _blue = new THREE.Color(0x4477cc);
    const _red  = new THREE.Color(0xcc3344);
    const applySkin = (hex: string) => {
      _skin.set(hex);
      matC.color.copy(_skin);
      matFaceFill.color.copy(_skin);
      matL.color.copy(_skin).lerp(_blue, 0.25);
      matR.color.copy(_skin).lerp(_red, 0.25);
    };

    renderer.setAnimationLoop(() => {
      if (disposed) return;

      const roomMv = roomMRef.current || ROOM_DEFAULT;
      grid.scale.set(roomMv, 1, roomMv);
      cube.scale.setScalar(roomMv);
      cube.position.y = roomMv / 2;
      controls.update();

      const o = lmOptsRef.current;
      const rls = rulesRef.current;
      const alpha = o.smoothing ? Math.max(0.04, 1 - o.smoothAmount) : 1;
      const pw = procLm(poseProc, debugLandmarksRef.current.poseWorld, o.persistPose, o.smoothing, alpha);
      const rig = rigRef.current;
      if (rig.skinHex !== lastSkin) { lastSkin = rig.skinHex; applySkin(rig.skinHex); }
      const mx = mirrorRef.current ? -1 : 1;
      const len = (cm: number) => cm / 100; // cm → meters

      figure.position.set(0, len(rig.hipHeightCm), 0);

      // Legs "tracked" = hips + knees confidently visible. When they aren't
      // (lower body out of frame, e.g. the subject walked up close) ONLY the legs
      // snap to the straight-down rest pose, so the mannequin doesn't fold into a
      // fetal crouch at the bottom. The UPPER body keeps its held/live pose
      // (persistence), so a hand raised to the camera still shows — we never
      // force the arms to a rest pose here.
      const visOk = (i: number) => { const l = pw?.[i]; return !!l && (l.visibility ?? 1) >= MIN_VIS; };
      const legsTracked = visOk(HIP_L) && visOk(HIP_R) && visOk(KN_L) && visOk(KN_R);

      const getLm = (i: number): NormalizedLandmark | null => {
        const lm = pw?.[i];
        if (lm && (lm.visibility ?? 1) >= MIN_VIS) return lm;
        return o.persistPose ? (lm ?? null) : null;
      };
      const RV = (i: number): THREE.Vector3 | null => {
        const lm = getLm(i);
        return lm ? new THREE.Vector3(mx * lm.x, -lm.y, -lm.z) : null;
      };
      const RVm = (i: number, j: number): THREE.Vector3 | null => {
        const a = getLm(i), b = getLm(j);
        if (!a || !b) return null;
        return new THREE.Vector3(mx * (a.x + b.x) / 2, -(a.y + b.y) / 2, -(a.z + b.z) / 2);
      };
      // Legs only: null out when the lower body isn't tracked → rest pose. The
      // legsRestOnLoss rule can disable this (legs then follow held landmarks,
      // which may curl/fetal — useful to see the rule's effect).
      const RVleg = (i: number): THREE.Vector3 | null =>
        (rls.legsRestOnLoss && !legsTracked ? null : RV(i));
      // Live direction a→b (unit), or the rest-pose fallback direction when missing.
      const dir = (a: THREE.Vector3 | null, b: THREE.Vector3 | null, fallback: THREE.Vector3): THREE.Vector3 =>
        a && b ? b.clone().sub(a).normalize() : fallback;
      const ext = (from: THREE.Vector3, d: THREE.Vector3, cm: number): THREE.Vector3 =>
        from.clone().addScaledVector(d, len(cm));

      // ── forward-kinematics skeleton: fixed lengths/radii, live directions ──
      const hipMid = new THREE.Vector3(0, 0, 0);
      const shMid = ext(hipMid, dir(RVm(HIP_L, HIP_R), RVm(SH_L, SH_R), D_UP), rig.torsoCm);
      const headDir = RVm(EAR_L, EAR_R) ? dir(RVm(SH_L, SH_R), RVm(EAR_L, EAR_R), D_UP)
        : dir(RVm(SH_L, SH_R), RV(NOSE), D_UP);
      const headC = ext(shMid, headDir, rig.neckCm);

      const shAxis = dir(RV(SH_L), RV(SH_R), D_X);
      const hipAxis = dir(RV(HIP_L), RV(HIP_R), D_X);
      const shL = shMid.clone().addScaledVector(shAxis, -len(rig.shoulderWidthCm) / 2);
      const shR = shMid.clone().addScaledVector(shAxis,  len(rig.shoulderWidthCm) / 2);
      const hipL = hipMid.clone().addScaledVector(hipAxis, -len(rig.hipWidthCm) / 2);
      const hipR = hipMid.clone().addScaledVector(hipAxis,  len(rig.hipWidthCm) / 2);

      const elL = ext(shL, dir(RV(SH_L), RV(EL_L), D_UARM_REST_L), rig.upperArmCm);
      const elR = ext(shR, dir(RV(SH_R), RV(EL_R), D_UARM_REST_R), rig.upperArmCm);
      const wrL = ext(elL, dir(RV(EL_L), RV(WR_L), D_LARM_REST_L), rig.lowerArmCm);
      const wrR = ext(elR, dir(RV(EL_R), RV(WR_R), D_LARM_REST_R), rig.lowerArmCm);
      const knL = ext(hipL, dir(RVleg(HIP_L), RVleg(KN_L), D_DOWN), rig.upperLegCm);
      const knR = ext(hipR, dir(RVleg(HIP_R), RVleg(KN_R), D_DOWN), rig.upperLegCm);
      const anL = ext(knL, dir(RVleg(KN_L), RVleg(AN_L), D_DOWN), rig.lowerLegCm);
      const anR = ext(knR, dir(RVleg(KN_R), RVleg(AN_R), D_DOWN), rig.lowerLegCm);
      const toeL = ext(anL, dir(RVleg(AN_L), RVleg(TOE_L), D_FOOT), rig.footCm);
      const toeR = ext(anR, dir(RVleg(AN_R), RVleg(TOE_R), D_FOOT), rig.footCm);

      const headR = Math.max(len(rig.headDiameterCm) * 0.65, 0.04);
      const jR = len(rig.jointRcm);
      const spine  = hipMid.clone().lerp(shMid, 1 / 3);
      const spine1 = hipMid.clone().lerp(shMid, 2 / 3);
      placeSph(mHead, headC, headR * HEAD_SPHERE_FIT);
      placeCyl(mNeck,   headC, shMid,  len(rig.neckRcm));
      placeCyl(mSpine,  hipMid, spine,  len(rig.torsoRcm));
      placeCyl(mSpine1, spine,  spine1, len(rig.torsoRcm));
      placeCyl(mSpine2, spine1, shMid,  len(rig.torsoRcm));

      placeCyl(mUArmL, shL, elL, len(rig.upperArmRcm));  placeCyl(mUArmR, shR, elR, len(rig.upperArmRcm));
      placeCyl(mLArmL, elL, wrL, len(rig.lowerArmRcm));  placeCyl(mLArmR, elR, wrR, len(rig.lowerArmRcm));
      placeCyl(mULegL, hipL, knL, len(rig.upperLegRcm)); placeCyl(mULegR, hipR, knR, len(rig.upperLegRcm));
      placeCyl(mLLegL, knL, anL, len(rig.lowerLegRcm));  placeCyl(mLLegR, knR, anR, len(rig.lowerLegRcm));
      placeCyl(mFootL, anL, toeL, len(rig.footRcm));     placeCyl(mFootR, anR, toeR, len(rig.footRcm));

      placeSph(mJShL, shL, jR);   placeSph(mJShR, shR, jR);
      placeSph(mJElL, elL, jR);   placeSph(mJElR, elR, jR);
      placeSph(mJWrL, wrL, jR);   placeSph(mJWrR, wrR, jR);
      placeSph(mJHpL, hipL, jR);  placeSph(mJHpR, hipR, jR);
      placeSph(mJKnL, knL, jR);   placeSph(mJKnR, knR, jR);
      placeSph(mJAnL, anL, jR);   placeSph(mJAnR, anR, jR);

      // ── filled face surface (+ contour overlay) ──────────────────────────
      // FIXED SIZE — every term comes from RigConfig. The rendered face width is
      // EXACTLY headDiameterCm × FACE_W_FIT × faceScale (meters), independent of
      // camera distance and head pose. We get there by normalizing the face by
      // its OWN cheek-hinge width (landmarks 234↔454): a 3D span (yaw-stable)
      // that is horizontal (pitch-stable) and ALWAYS present whenever the face is
      // visible. (The previous pose-ear normalizer froze when the subject stepped
      // close and the body left frame, which is what blew the face up.) faceScale
      // is the ONLY size knob; the landmarks supply shape only.
      const face = procLm(faceProc, debugLandmarksRef.current.face, o.persistFace, o.smoothing, alpha);
      // Face-local frame (room space) — set when the face is tracked, reused to
      // anchor the eyes so they turn WITH the face (not the head sphere).
      let faceValid = false;
      const faceR = new THREE.Vector3();
      const faceU = new THREE.Vector3();
      const faceF = new THREE.Vector3();
      const faceO = new THREE.Vector3();
      if (face && face.length >= 468) {
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < 468; i++) { const p = face[i]; cx += p.x; cy += p.y; cz += p.z; }
        cx /= 468; cy /= 468; cz /= 468;

        const faceTarget = len(rig.headDiameterCm) * FACE_W_FIT * rig.faceScale;
        const faceW = Math.hypot(
          face[234].x - face[454].x, face[234].y - face[454].y, face[234].z - face[454].z,
        );
        // cheekHingeNorm on → fixed size (normalize by the live cheek-hinge width).
        // off → a constant guess width, so the face scales with camera distance
        // (demonstrates why the normalization matters).
        const fScale = rls.cheekHingeNorm
          ? (faceW > 1e-4 ? faceTarget / faceW : rig.faceScale)
          : faceTarget / FALLBACK_FACE_W;

        for (let i = 0; i < 468; i++) {
          const p = face[i];
          faceVerts[i * 3]     = mx * (p.x - cx) * fScale;
          faceVerts[i * 3 + 1] = -(p.y - cy) * fScale;
          faceVerts[i * 3 + 2] = -(p.z - cz) * fScale;
        }

        const fx = headC.x + len(rig.faceOffXcm);
        const fy = headC.y + len(rig.faceOffYcm);
        const fz = headC.z + len(rig.faceOffZcm);
        faceFill.position.set(fx, fy, fz);
        faceLine.position.set(fx, fy, fz);

        // Orthonormal face frame from forehead(10)/chin(152) + sides(234/454):
        // F forward (toward viewer), U up, R right.
        const fv = (i: number, c: number) => faceVerts[i * 3 + c];
        _fUp.set(fv(10, 0) - fv(152, 0), fv(10, 1) - fv(152, 1), fv(10, 2) - fv(152, 2));
        _fSide.set(fv(454, 0) - fv(234, 0), fv(454, 1) - fv(234, 1), fv(454, 2) - fv(234, 2));
        _fN.crossVectors(_fSide, _fUp);
        if (_fN.lengthSq() > 1e-9 && _fUp.lengthSq() > 1e-9) {
          faceF.copy(_fN).normalize();
          if (faceF.z < 0) faceF.multiplyScalar(-1); // toward the viewer
          faceU.copy(_fUp).addScaledVector(faceF, -_fUp.dot(faceF)).normalize();
          faceR.crossVectors(faceU, faceF).normalize();
          if (faceR.dot(_fSide) < 0) faceR.multiplyScalar(-1);
          // Fulcrum: shift every vertex by +F·headR so the rotation pivot (the
          // head-sphere centre) lands on the mesh anchor, instead of the flat
          // face swinging on its own mid-plane hinge when the head turns. The
          // faceFulcrum rule can disable the shift.
          const shift = rls.faceFulcrum ? headR : 0;
          const sx = faceF.x * shift, sy = faceF.y * shift, sz = faceF.z * shift;
          for (let i = 0; i < 468; i++) {
            faceVerts[i * 3] += sx; faceVerts[i * 3 + 1] += sy; faceVerts[i * 3 + 2] += sz;
          }
          // Eye anchor = world position of the re-centred face centroid.
          faceO.set(fx + sx, fy + sy, fz + sz);
          faceValid = true;

          // Pick the FrontSide winding for THIS frame: a sample front triangle's
          // index-order normal should point toward the viewer (≈ faceF). Mirror
          // flips the winding, so this is recomputed each frame.
          _v3a.set(fv(34, 0) - fv(127, 0), fv(34, 1) - fv(127, 1), fv(34, 2) - fv(127, 2));
          _v3b.set(fv(139, 0) - fv(127, 0), fv(139, 1) - fv(127, 1), fv(139, 2) - fv(127, 2));
          _v3c.crossVectors(_v3a, _v3b);
          matFaceFill.side = _v3c.dot(faceF) >= 0 ? THREE.FrontSide : THREE.BackSide;

          // Eye sockets — fan over the (already shifted) eyelid-ring vertices.
          const fillSocket = (sk: { geom: THREE.BufferGeometry; pos: Float32Array }, ring: number[]) => {
            let scx = 0, scy = 0, scz = 0;
            for (let k = 0; k < 16; k++) {
              const r = ring[k];
              const x = faceVerts[r * 3], y = faceVerts[r * 3 + 1], z = faceVerts[r * 3 + 2];
              sk.pos[(k + 1) * 3] = x; sk.pos[(k + 1) * 3 + 1] = y; sk.pos[(k + 1) * 3 + 2] = z;
              scx += x; scy += y; scz += z;
            }
            sk.pos[0] = scx / 16; sk.pos[1] = scy / 16; sk.pos[2] = scz / 16;
            sk.geom.attributes.position.needsUpdate = true;
          };
          fillSocket(socketL, LEFT_EYE_RING);
          fillSocket(socketR, RIGHT_EYE_RING);
          socketL.mesh.position.set(fx, fy, fz);
          socketR.mesh.position.set(fx, fy, fz);
        }
        facePosAttr.needsUpdate = true;
        faceFillGeom.computeVertexNormals();
        faceFill.visible = rls.showFaceMesh;
        faceLine.visible = rls.showFaceMesh;
        const socketsOn = faceValid && rls.showFaceMesh && rls.showEyes;
        socketL.mesh.visible = socketsOn;
        socketR.mesh.visible = socketsOn;
      } else {
        faceFill.visible = false;
        faceLine.visible = false;
        socketL.mesh.visible = false;
        socketR.mesh.visible = false;
      }

      // ── hands: fingers at the FK wrist, sized from the FIXED captured forearm.
      // Closed-hand fallback ball sits just past the wrist along the forearm.
      const fist = (wr: THREE.Vector3, el: THREE.Vector3): THREE.Vector3 =>
        wr.clone().addScaledVector(_v2.subVectors(wr, el).normalize(), 0.03);
      const handLenM = len(rig.handLengthCm);
      const handR = len(rig.handRcm);
      // Map each hand stream to the correct anatomical FK wrist using the
      // chirality the adapter already resolved (handedness + geometric anchoring),
      // accounting for the webcam mirror — NOT the live pose wrists, so a held or
      // raised hand stays visible when the body leaves frame (hand persistence).
      //
      // solveMocapFrame keys debug.leftHand/rightHand by AVATAR side: in mirror
      // mode debug.leftHand = the subject's RIGHT hand (and it swaps both streams
      // when mirror is off). wrL/wrR here are the anatomical left/right wrists
      // (pose landmarks 15/16). So the stream→wrist pairing flips with mirror:
      //   mirror on  → rightHand stream feeds wrL, leftHand feeds wrR
      //   mirror off → leftHand  stream feeds wrL, rightHand feeds wrR
      const lStream = procLm(handLProc, debugLandmarksRef.current.leftHand, o.persistHands, o.smoothing, alpha);
      const rStream = procLm(handRProc, debugLandmarksRef.current.rightHand, o.persistHands, o.smoothing, alpha);
      const dataForL = mirrorRef.current ? rStream : lStream;
      const dataForR = mirrorRef.current ? lStream : rStream;
      const updateHand = (
        hr: HandRig,
        lm: NormalizedLandmark[] | null,
        wrist: THREE.Vector3,
        elbow: THREE.Vector3,
      ): boolean => {
        if (!lm || lm.length < 21) {
          for (const j of hr.joints) j.visible = false;
          for (const b of hr.bones) b.visible = false;
          hr.palm.visible = false;
          return false;
        }
        // FK: fixed bone lengths (canonical fraction × per-finger multiplier ×
        // captured hand length), live bone directions from the image landmarks.
        const fingerMul = [
          rig.fingerThumb, rig.fingerIndex, rig.fingerMiddle, rig.fingerRing, rig.fingerLittle,
        ];
        const jp: THREE.Vector3[] = new Array(21);
        jp[0] = wrist.clone();
        for (let k = 0; k < 20; k++) {
          const [a, b] = HAND_BONES[k];
          const d = new THREE.Vector3(
            mx * (lm[b].x - lm[a].x),
            -(lm[b].y - lm[a].y),
            -(lm[b].z - lm[a].z),
          ).normalize();
          const fi = HAND_BONE_FINGER[k];
          const mul = fi >= 0 ? fingerMul[fi] : 1;
          jp[b] = jp[a].clone().addScaledVector(d, HAND_BONE_FRAC[k] * mul * handLenM);
        }
        // Point the hand OUTWARD along the forearm: rotate the whole hand about
        // the wrist so its wrist→middle-knuckle axis aligns with the forearm
        // direction (elbow→wrist). Finger articulation (curl/spread) is preserved
        // since we rotate rigidly. This stops the hand from hanging at an odd
        // angle off a floating wrist ball — it now continues the arm.
        _v3a.subVectors(jp[9], jp[0]);          // hand forward (wrist→middle base)
        _v3b.subVectors(wrist, elbow);          // forearm forward (outward)
        if (_v3a.lengthSq() > 1e-9 && _v3b.lengthSq() > 1e-9) {
          _hq.setFromUnitVectors(_v3a.normalize(), _v3b.normalize());
          for (let i = 1; i < 21; i++) jp[i].sub(jp[0]).applyQuaternion(_hq).add(jp[0]);
        }
        // Finger bones: tapered cylinder per bone (radius from rig.fingerRcm) +
        // a sphere cap at each joint. The palm-fan metacarpals are skipped — the
        // palm is the flattened box below, so the hand looks substantial.
        const baseFingerR = Math.max(len(rig.fingerRcm), 0.004);
        for (let k = 0; k < 20; k++) {
          if (PALM_FAN_BONES.has(k)) { hr.bones[k].visible = false; continue; }
          const [a, b] = HAND_BONES[k];
          placeCyl(hr.bones[k], jp[a], jp[b], baseFingerR * HAND_BONE_R[k]);
        }
        hr.bones[20].visible = false; // outer palm edge — part of the palm box
        for (let i = 0; i < 21; i++) placeSph(hr.joints[i], jp[i], baseFingerR * 0.78);

        // Palm: one flattened box spanning wrist → knuckle row, across the
        // index↔pinky width. The widest, thickest part of the hand.
        const knuckleMid = jp[5].clone().add(jp[9]).add(jp[13]).add(jp[17]).multiplyScalar(0.25);
        _pU.subVectors(knuckleMid, jp[0]);
        _pW.subVectors(jp[5], jp[17]);
        const palmLen = _pU.length(), palmW = _pW.length();
        if (palmLen > 1e-4 && palmW > 1e-4) {
          _pU.normalize();
          _pR.copy(_pW).addScaledVector(_pU, -_pW.dot(_pU)).normalize();
          _pF.crossVectors(_pR, _pU).normalize();
          _pC.addVectors(jp[0], knuckleMid).multiplyScalar(0.5);
          placeBox(hr.palm, _pC, _pR, _pU, _pF, palmW * 1.08, palmLen * 1.05, len(rig.palmRcm) * 2);
        } else {
          hr.palm.visible = false;
        }
        return true;
      };
      // fingerFK off → pass null so the FK fingers are hidden and a fist sphere
      // is drawn at the wrist instead.
      const lFingers = updateHand(handLeft, rls.fingerFK ? dataForL : null, wrL, elL);
      const rFingers = updateHand(handRight, rls.fingerFK ? dataForR : null, wrR, elR);
      placeSph(mHandL, lFingers ? null : fist(wrL, elL), handR);
      placeSph(mHandR, rFingers ? null : fist(wrR, elR), handR);

      // ── eyeballs + gaze (pupil x/y from the smoothed mocap frame, -1..1).
      //    Eyes live in FACE-LOCAL space (faceO + R/U/F basis from the face
      //    landmarks) so they sit in the face mesh and turn with it. eyeX/Y/Z
      //    are face-local offsets. When no face is tracked, fall back to a
      //    head-local frame so the eyes still rest on the head sphere.
      const pupil = frameRef.current?.pupil;
      const eyeRm = len(rig.eyeRcm);
      const eyeXm = len(rig.eyeXcm), eyeYm = len(rig.eyeYcm), eyeZm = len(rig.eyeZcm);
      const gx = (pupil ? pupil.x : 0) * eyeRm * 0.55;
      const gy = (pupil ? pupil.y : 0) * eyeRm * 0.55;
      // faceLocalEyes off (or no face) → head-local frame whose anchor sits on
      // the FRONT SURFACE of the head sphere (not its centre), so the small
      // face-local eyeZ keeps the eyes on the head instead of buried inside it.
      if (!faceValid || !rls.faceLocalEyes) {
        faceR.set(mx, 0, 0); faceU.set(0, 1, 0); faceF.set(0, 0, 1);
        faceO.copy(headC).addScaledVector(faceF, headR);
      }
      const placeEye = (eye: THREE.Mesh, iris: THREE.Mesh, sign: number) => {
        if (!rls.showEyes) { eye.visible = false; iris.visible = false; return; }
        const ep = faceO.clone()
          .addScaledVector(faceR, sign * eyeXm)
          .addScaledVector(faceU, eyeYm)
          .addScaledVector(faceF, eyeZm);
        eye.position.copy(ep); eye.scale.setScalar(eyeRm); eye.visible = true;
        iris.position.copy(ep)
          .addScaledVector(faceR, gx)
          .addScaledVector(faceU, gy)
          .addScaledVector(faceF, eyeRm * 0.82);
        iris.scale.setScalar(eyeRm * 0.45); iris.visible = true;
      };
      placeEye(mEyeL, mIrisL, -1);
      placeEye(mEyeR, mIrisR, 1);

      // ── GLB model: lives as a direct scene child (not in figure) so that
      //    setting figure.visible = false hides the procedural skeleton cleanly.
      //    FK direction vectors are the same in world space as in figure-local
      //    space because figure only translates (identity rotation).
      const model = loadedModelRef.current;
      const useModel = rls.useCustomModel && model !== null;

      // Show procedural skeleton XOR GLB model.
      figure.visible = !useModel;
      if (model) {
        model.group.visible = useModel;
        if (useModel) {
          // Keep model hips aligned with FK hip position (figure.position in world).
          model.group.position.set(
            figure.position.x,
            figure.position.y - model.hipsLocalY,
            figure.position.z,
          );
        }
      }

      if (useModel && model) {
        // Drive a bone so its local +Y = worldDir. Process root-first: after
        // setting each bone's quaternion, update matrix + matrixWorld so children
        // see a fresh parent matrixWorld when they compute their own local quat.
        const driveBoneByDir = (joint: string, worldDir: THREE.Vector3) => {
          const bName = model.boneMap[joint];
          const bone = bName ? model.bones.get(bName) : undefined;
          if (!bone) return;
          _bTQ.setFromUnitVectors(_bYup, worldDir);
          if (bone.parent) {
            bone.parent.getWorldQuaternion(_bPQ);
            bone.quaternion.copy(_bPQ.invert()).premultiply(_bTQ);
          } else {
            bone.quaternion.copy(_bTQ);
          }
          bone.updateMatrix();
          if (bone.parent) {
            bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
          }
        };
        const driveBone = (
          joint: string,
          a: THREE.Vector3 | null,
          b: THREE.Vector3 | null,
          fallback: THREE.Vector3,
        ) => {
          const d = (a && b && _bDir.subVectors(b, a).lengthSq() > 1e-8)
            ? _bDir.subVectors(b, a).normalize()
            : fallback;
          driveBoneByDir(joint, d);
        };

        // ── spine (3 bones, weighted slerp: 20% / 55% / 100%) ────────────
        const torsoD = dir(hipMid, shMid, D_UP);
        _qTorsoFull.setFromUnitVectors(_bYup, torsoD);
        _qSpinePart.slerpQuaternions(_qIdent, _qTorsoFull, 0.20);
        driveBoneByDir("mixamorigSpine",  _spineD.copy(_bYup).applyQuaternion(_qSpinePart));
        _qSpinePart.slerpQuaternions(_qIdent, _qTorsoFull, 0.55);
        driveBoneByDir("mixamorigSpine1", _spineD.copy(_bYup).applyQuaternion(_qSpinePart));
        driveBoneByDir("mixamorigSpine2", torsoD);

        // ── neck / head ───────────────────────────────────────────────────
        driveBone("mixamorigNeck", shMid, headC, D_UP);
        driveBone("mixamorigHead", headC, ext(headC, headDir, rig.headDiameterCm * 0.5), headDir);

        // ── shoulders (clavicles) ─────────────────────────────────────────
        driveBone("mixamorigLeftShoulder",  shMid, shL, D_UARM_REST_L);
        driveBone("mixamorigRightShoulder", shMid, shR, D_UARM_REST_R);

        // ── arms ─────────────────────────────────────────────────────────
        driveBone("mixamorigLeftArm",      shL, elL, D_UARM_REST_L);
        driveBone("mixamorigRightArm",     shR, elR, D_UARM_REST_R);
        driveBone("mixamorigLeftForeArm",  elL, wrL, D_LARM_REST_L);
        driveBone("mixamorigRightForeArm", elR, wrR, D_LARM_REST_R);
        driveBone("mixamorigLeftHand",     elL, wrL, D_LARM_REST_L);
        driveBone("mixamorigRightHand",    elR, wrR, D_LARM_REST_R);

        // ── legs ─────────────────────────────────────────────────────────
        driveBone("mixamorigLeftUpLeg",  hipL, knL,  D_DOWN);
        driveBone("mixamorigRightUpLeg", hipR, knR,  D_DOWN);
        driveBone("mixamorigLeftLeg",    knL,  anL,  D_DOWN);
        driveBone("mixamorigRightLeg",   knR,  anR,  D_DOWN);
        driveBone("mixamorigLeftFoot",   anL,  toeL, D_FOOT);
        driveBone("mixamorigRightFoot",  anR,  toeR, D_FOOT);

        // ── fingers (15 bones per hand from MediaPipe hand landmarks) ─────
        const driveFingers = (lm: NormalizedLandmark[] | null, names: readonly string[]) => {
          if (!lm || lm.length < 21) return;
          for (let f = 0; f < 15; f++) {
            const [ia, ib] = FINGER_LM_PAIRS[f];
            _fingerD.set(
              mx * (lm[ib].x - lm[ia].x),
              -(lm[ib].y - lm[ia].y),
              -(lm[ib].z - lm[ia].z),
            );
            if (_fingerD.lengthSq() < 1e-9) continue;
            driveBoneByDir(names[f], _fingerD.normalize());
          }
        };
        driveFingers(dataForL, FINGER_BONES_L);
        driveFingers(dataForR, FINGER_BONES_R);

        // ── blendshapes (52 ARKit values → GLB morph targets) ────────────
        if (rls.useModelFace) {
          const expr = frameRef.current?.expressions;
          if (expr) {
            model.group.traverse((obj) => {
              if (!(obj instanceof THREE.SkinnedMesh)) return;
              const dict = obj.morphTargetDictionary;
              const infl = obj.morphTargetInfluences;
              if (!dict || !infl) return;
              for (const [name, value] of Object.entries(expr)) {
                const idx = dict[name];
                if (idx !== undefined) infl[idx] = value as number;
              }
            });
          }
        }
      }

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
      controls.dispose();
      ro.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.domElement.remove();
      matL.dispose(); matR.dispose(); matC.dispose();
      matFaceFill.dispose(); matFaceLine.dispose();
      matEye.dispose(); matIris.dispose();
      mEyeL.geometry.dispose(); mEyeR.geometry.dispose();
      mIrisL.geometry.dispose(); mIrisR.geometry.dispose();
      grid.dispose();
      (cube.geometry as THREE.BufferGeometry).dispose();
      (cube.material as THREE.Material).dispose();
      faceFillGeom.dispose(); faceLineGeom.dispose();
      for (const s of [socketL, socketR]) { s.geom.dispose(); (s.mesh.material as THREE.Material).dispose(); }
      for (const m of meshes) m.geometry.dispose();
      for (const h of [handLeft, handRight]) {
        for (const j of h.joints) j.geometry.dispose();
        for (const b of h.bones) b.geometry.dispose();
        h.palm.geometry.dispose();
      }
      sceneRef.current = null;
      figureRef.current = null;
      const lm = loadedModelRef.current;
      if (lm) {
        lm.group.parent?.remove(lm.group);
        lm.group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            (Array.isArray(obj.material) ? obj.material : [obj.material])
              .forEach((mat) => (mat as THREE.Material).dispose());
          }
        });
        loadedModelRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugLandmarksRef]);

  // ── GLB model loader ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!modelUrl) {
      // No URL: remove any existing model from the scene.
      const old = loadedModelRef.current;
      if (old) {
        old.group.parent?.remove(old.group);
        old.group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            (Array.isArray(obj.material) ? obj.material : [obj.material])
              .forEach((mat) => (mat as THREE.Material).dispose());
          }
        });
        loadedModelRef.current = null;
      }
      return;
    }

    const scene = sceneRef.current;
    console.log("[GLB] loader effect fired — url:", modelUrl.slice(0, 60), "sceneReady:", !!scene);
    if (!scene) {
      console.warn("[GLB] scene not ready yet — model will not load. This is a bug.");
      return;
    }

    let cancelled = false;
    const loader = new GLTFLoader();

    loader.load(modelUrl, (gltf) => {
      if (cancelled) return;

      // Remove + dispose previous model.
      const old = loadedModelRef.current;
      if (old) {
        old.group.parent?.remove(old.group);
        old.group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            (Array.isArray(obj.material) ? obj.material : [obj.material])
              .forEach((mat) => (mat as THREE.Material).dispose());
          }
        });
      }

      const group = gltf.scene;

      // Bounding box before scaling (raw model units).
      const boxRaw = new THREE.Box3().setFromObject(group);
      const modelHeight = boxRaw.max.y - boxRaw.min.y;
      const targetHeight = rigRef.current.heightCm / 100;
      const scl = modelHeight > 0.01 ? targetHeight / modelHeight : 1;
      group.scale.setScalar(scl);
      console.log(
        `[GLB] onLoad — raw bbox Y: [${boxRaw.min.y.toFixed(3)}, ${boxRaw.max.y.toFixed(3)}]`,
        `height=${modelHeight.toFixed(3)} units → scale=${scl.toFixed(5)} (target ${targetHeight.toFixed(2)}m)`,
      );

      // Collect all bones by name.
      const bones = new Map<string, THREE.Bone>();
      let meshCount = 0;
      group.traverse((obj) => {
        if (obj instanceof THREE.Bone) bones.set(obj.name, obj);
        if (obj instanceof THREE.SkinnedMesh) meshCount++;
      });
      console.log(
        `[GLB] ${bones.size} bones, ${meshCount} skinned meshes`,
        "— first 10:", [...bones.keys()].slice(0, 10).join(", "),
      );

      // Disable frustum culling on all skinned meshes — the rest-pose bbox
      // is wrong after FK drives bones outside the bind pose.
      group.traverse((obj) => {
        if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false;
      });

      // Merge default Mixamo map with any sidecar overrides.
      let boneMap = { ...DEFAULT_BONE_MAP, ...(modelBoneMapRef.current ?? {}) };

      // Auto-detect Mixamo colon naming convention (mixamorig:Hips vs mixamorigHips).
      // Newer Mixamo exports prefix every bone name with "mixamorig:" (colon).
      if (!bones.has("mixamorigHips") && bones.has("mixamorig:Hips")) {
        console.log("[GLB] detected colon bone naming — rewriting map to mixamorig: prefix");
        const rewritten: Record<string, string> = {};
        for (const [joint, boneName] of Object.entries(boneMap)) {
          rewritten[joint] = boneName.replace(/^mixamorig(?!:)/, "mixamorig:");
        }
        boneMap = rewritten;
      } else if (bones.has("mixamorigHips")) {
        console.log("[GLB] bone naming: mixamorigHips (no colon)");
      } else {
        console.warn(
          "[GLB] neither mixamorigHips nor mixamorig:Hips found.",
          "Bone names in model:", [...bones.keys()].slice(0, 20).join(", "),
        );
      }

      // Add to scene first so getWorldPosition reflects final scale + hierarchy.
      scene.add(group);
      group.updateMatrixWorld(true);

      // Y offset: position model so hips bone sits at figure's hip origin.
      // Use getWorldPosition after scene.add() to account for intermediate parents.
      const hipsKey = boneMap["mixamorigHips"] ?? "";
      const hipsBone = bones.get(hipsKey);
      const _tmpVec = new THREE.Vector3();
      const hipsLocalY = hipsBone ? hipsBone.getWorldPosition(_tmpVec).y : 0;
      console.log(
        `[GLB] hips bone "${hipsKey}" found:`, !!hipsBone,
        "— hipsLocalY:", hipsLocalY.toFixed(3),
        "— hipHeightCm target:", rigRef.current.hipHeightCm.toFixed(1),
      );
      if (!hipsBone) {
        console.warn("[GLB] hips bone missing — model will sit at Y=0. Check bone names above.");
      }

      // Final bounding box after scaling (should be ~targetHeight m tall).
      const boxFinal = new THREE.Box3().setFromObject(group);
      console.log(
        `[GLB] final bbox after scale: Y=[${boxFinal.min.y.toFixed(3)}, ${boxFinal.max.y.toFixed(3)}]`,
        `height=${(boxFinal.max.y - boxFinal.min.y).toFixed(3)}m`,
        `— group.position will be set to Y=${(rigRef.current.hipHeightCm / 100 - hipsLocalY).toFixed(3)}m`,
      );

      loadedModelRef.current = { group, bones, boneMap, hipsLocalY };
      console.log("[GLB] loadedModelRef set — model ready for rendering");
    }, undefined, (err) => {
      console.error("[GLB loader] load error:", err);
    });

    return () => {
      cancelled = true;
    };
  }, [modelUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={containerRef} className="avatar-viewport">
      <div className="viewport-badge">
        3D room view · fixed-proportion rig ({roomM}m room · drag to orbit) ·{" "}
        <span style={{ color: "#4477cc" }}>blue=left</span> ·{" "}
        <span style={{ color: "#cc3344" }}>red=right</span> ·{" "}
        <span style={{ color: "#66ddff" }}>face</span>
      </div>
    </div>
  );
}
