import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { DebugLandmarks, MocapFrame } from "../mocap/types";
import type { RigConfig } from "../mocap/rig";
import { buildCanonicalPose } from "../mocap/worldFrame";
import { DEFAULT_BONE_MAP } from "../mocap/boneMap";
import { ProceduralSkeletonRenderer } from "../render/ProceduralSkeletonRenderer";
import { FaceMeshRenderer } from "../render/FaceMeshRenderer";
import { GlbBoneDriver, type FKPositions, type LoadedModel } from "../render/GlbBoneDriver";

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

const HIP_L = 23, HIP_R = 24, KN_L = 25, KN_R = 26;


// Default directions in room space, used when a live direction is missing.
const D_UP   = new THREE.Vector3(0, 1, 0);
const D_DOWN = new THREE.Vector3(0, -1, 0);
const D_X    = new THREE.Vector3(1, 0, 0);
const D_FOOT = new THREE.Vector3(0, -0.3, 1).normalize();
const D_UARM_REST_L = new THREE.Vector3(-0.45, -0.89, 0).normalize();
const D_UARM_REST_R = new THREE.Vector3( 0.45, -0.89, 0).normalize();
const D_LARM_REST_L = new THREE.Vector3(-0.28, -0.96, 0.02).normalize();
const D_LARM_REST_R = new THREE.Vector3( 0.28, -0.96, 0.02).normalize();

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
  /** Overlay a SkeletonHelper (bone lines) on the loaded GLB model. */
  showModelBones: boolean;
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
  showModelBones: false,
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

    const figure = new THREE.Group();
    figureRef.current = figure;
    scene.add(figure);

    const skelRenderer = new ProceduralSkeletonRenderer(figure);
    const faceRenderer = new FaceMeshRenderer(figure);
    const glbDriver    = new GlbBoneDriver();

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
    let lastSkin = "";

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
      if (rig.skinHex !== lastSkin) {
        lastSkin = rig.skinHex;
        skelRenderer.applySkin(rig.skinHex);
        faceRenderer.applySkin(rig.skinHex);
      }
      const mx = mirrorRef.current ? -1 : 1;
      const len = (cm: number) => cm / 100; // cm → meters

      figure.position.set(0, len(rig.hipHeightCm), 0);

      const visOk = (i: number) => { const l = pw?.[i]; return !!l && (l.visibility ?? 1) >= MIN_VIS; };
      const legsTracked = visOk(HIP_L) && visOk(HIP_R) && visOk(KN_L) && visOk(KN_R);

      const pose = pw ? buildCanonicalPose(pw, mx) : null;

      // ── forward-kinematics positions — fixed lengths, live directions ──
      // (consumed by the GLB driver below; skelRenderer re-derives them
      //  internally — temporary duplication resolved in Phase 3c)
      const hipMid   = new THREE.Vector3(0, 0, 0);
      const torsoDir = pose ? pose.shMid.clone().sub(pose.hipMid).normalize() : D_UP;
      const shMid    = hipMid.clone().addScaledVector(torsoDir, len(rig.torsoCm));
      const headDir  = pose ? pose.headC.clone().sub(pose.shMid).normalize() : D_UP;
      const headC    = shMid.clone().addScaledVector(headDir, len(rig.neckCm));

      const shAxis  = pose ? pose.shR.clone().sub(pose.shL).normalize()   : D_X;
      const hipAxis = pose ? pose.hipR.clone().sub(pose.hipL).normalize() : D_X;
      const shL  = shMid.clone().addScaledVector(shAxis,  -len(rig.shoulderWidthCm) / 2);
      const shR  = shMid.clone().addScaledVector(shAxis,   len(rig.shoulderWidthCm) / 2);
      const hipL = hipMid.clone().addScaledVector(hipAxis, -len(rig.hipWidthCm) / 2);
      const hipR = hipMid.clone().addScaledVector(hipAxis,  len(rig.hipWidthCm) / 2);

      const elL  = shL.clone().addScaledVector(pose ? pose.elL.clone().sub(pose.shL).normalize()   : D_UARM_REST_L, len(rig.upperArmCm));
      const elR  = shR.clone().addScaledVector(pose ? pose.elR.clone().sub(pose.shR).normalize()   : D_UARM_REST_R, len(rig.upperArmCm));
      const wrL  = elL.clone().addScaledVector(pose ? pose.wrL.clone().sub(pose.elL).normalize()   : D_LARM_REST_L, len(rig.lowerArmCm));
      const wrR  = elR.clone().addScaledVector(pose ? pose.wrR.clone().sub(pose.elR).normalize()   : D_LARM_REST_R, len(rig.lowerArmCm));
      const legPose = (rls.legsRestOnLoss && !legsTracked) ? null : pose;
      const knL  = hipL.clone().addScaledVector(legPose ? legPose.knL.clone().sub(legPose.hipL).normalize() : D_DOWN, len(rig.upperLegCm));
      const knR  = hipR.clone().addScaledVector(legPose ? legPose.knR.clone().sub(legPose.hipR).normalize() : D_DOWN, len(rig.upperLegCm));
      const anL  = knL.clone().addScaledVector(legPose ? legPose.anL.clone().sub(legPose.knL).normalize()  : D_DOWN, len(rig.lowerLegCm));
      const anR  = knR.clone().addScaledVector(legPose ? legPose.anR.clone().sub(legPose.knR).normalize()  : D_DOWN, len(rig.lowerLegCm));
      const toeL = anL.clone().addScaledVector(legPose ? legPose.toeL.clone().sub(legPose.anL).normalize() : D_FOOT, len(rig.footCm));
      const toeR = anR.clone().addScaledVector(legPose ? legPose.toeR.clone().sub(legPose.anR).normalize() : D_FOOT, len(rig.footCm));

      const fk: FKPositions = {
        hipMid, torsoDir, shMid, headDir, headC,
        shL, shR, hipL, hipR, elL, elR, wrL, wrR, knL, knR, anL, anR, toeL, toeR,
      };

      // ── face + eyes (delegated to FaceMeshRenderer) ──────────────────
      const face = procLm(faceProc, debugLandmarksRef.current.face, o.persistFace, o.smoothing, alpha);
      faceRenderer.update(face, headC, rig, rls, mx, frameRef.current?.pupil);

      // ── hands: resolve streams then delegate to skelRenderer ─────────
      const lStream = procLm(handLProc, debugLandmarksRef.current.leftHand, o.persistHands, o.smoothing, alpha);
      const rStream = procLm(handRProc, debugLandmarksRef.current.rightHand, o.persistHands, o.smoothing, alpha);
      const dataForL = mirrorRef.current ? rStream : lStream;
      const dataForR = mirrorRef.current ? lStream : rStream;

      skelRenderer.update(fk, rig, rls, mx, dataForL, dataForR);

      // ── GLB model: lives as a direct scene child (not in figure) so that
      //    setting figure.visible = false hides the procedural skeleton cleanly.
      const model = loadedModelRef.current;
      const useModel = rls.useCustomModel && model !== null;

      figure.visible = !useModel;
      if (model) {
        model.group.visible = useModel;
        model.skeletonHelper.visible = useModel && rls.showModelBones;
      }
      if (useModel && model) {
        glbDriver.update(model, figure.position, fk, rig, rls, mx, dataForL, dataForR, frameRef.current?.expressions);
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
      skelRenderer.dispose();
      faceRenderer.dispose();
      grid.dispose();
      (cube.geometry as THREE.BufferGeometry).dispose();
      (cube.material as THREE.Material).dispose();
      sceneRef.current = null;
      figureRef.current = null;
      const lm = loadedModelRef.current;
      if (lm) {
        lm.skeletonHelper.parent?.remove(lm.skeletonHelper);
        lm.skeletonHelper.geometry.dispose();
        (lm.skeletonHelper.material as THREE.Material).dispose();
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
      const old = loadedModelRef.current;
      if (old) {
        old.skeletonHelper.parent?.remove(old.skeletonHelper);
        old.skeletonHelper.geometry.dispose();
        (old.skeletonHelper.material as THREE.Material).dispose();
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

      const old = loadedModelRef.current;
      if (old) {
        old.skeletonHelper.parent?.remove(old.skeletonHelper);
        old.skeletonHelper.geometry.dispose();
        (old.skeletonHelper.material as THREE.Material).dispose();
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

      const boxRaw = new THREE.Box3().setFromObject(group);
      const modelHeight = boxRaw.max.y - boxRaw.min.y;
      const targetHeight = rigRef.current.heightCm / 100;
      const scl = modelHeight > 0.01 ? targetHeight / modelHeight : 1;
      group.scale.setScalar(scl);
      console.log(
        `[GLB] onLoad — raw bbox Y: [${boxRaw.min.y.toFixed(3)}, ${boxRaw.max.y.toFixed(3)}]`,
        `height=${modelHeight.toFixed(3)} units → scale=${scl.toFixed(5)} (target ${targetHeight.toFixed(2)}m)`,
      );

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

      group.traverse((obj) => {
        if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false;
      });

      const boneRestDirs = new Map<string, THREE.Vector3>();
      bones.forEach((bone, name) => {
        const firstBoneChild = bone.children.find(c => c instanceof THREE.Bone) as THREE.Bone | undefined;
        if (firstBoneChild && firstBoneChild.position.lengthSq() > 1e-10) {
          boneRestDirs.set(name, firstBoneChild.position.clone().normalize());
        } else {
          boneRestDirs.set(name, new THREE.Vector3(0, 1, 0));
        }
      });

      let boneMap = { ...DEFAULT_BONE_MAP, ...(modelBoneMapRef.current ?? {}) };

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

      scene.add(group);
      group.updateMatrixWorld(true);

      const skeletonHelper = new THREE.SkeletonHelper(group);
      skeletonHelper.visible = false;
      scene.add(skeletonHelper);

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

      const boxFinal = new THREE.Box3().setFromObject(group);
      console.log(
        `[GLB] final bbox after scale: Y=[${boxFinal.min.y.toFixed(3)}, ${boxFinal.max.y.toFixed(3)}]`,
        `height=${(boxFinal.max.y - boxFinal.min.y).toFixed(3)}m`,
        `— group.position will be set to Y=${(rigRef.current.hipHeightCm / 100 - hipsLocalY).toFixed(3)}m`,
      );

      loadedModelRef.current = { group, bones, boneMap, hipsLocalY, boneRestDirs, skeletonHelper };
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
