# SETUP — vtube milestone 1

> **Project location (updated 2026-06-11):** This project was moved from
> `C:\Users\adamm\Documents\vtube` to
> `G:\My Drive\AI Platforms\vtube` (Google Drive). `node_modules` was removed
> before the move — run `npm install` here to regenerate it before running
> `npm run dev` / `npm run build`.

How to get these files into `lakar-team/vtube`, install, and run.

## 0. Prerequisites

- Node.js 18+ (20 LTS recommended) and npm
- Git
- A webcam, and Chrome/Edge (best WebGL + WASM-GPU support)
- Internet on first run (MediaPipe WASM + models load from CDN, and the
  fallback sample VRM is fetched from GitHub)

## 1. Copy these files into the repo and push

These files were generated locally (at `C:\Users\adamm\Documents\vtube`).
The repo currently only contains a `README.md`; this project includes its own
README which will replace it.

```powershell
# 1. Clone the repo somewhere OUTSIDE the generated folder
cd C:\Users\adamm\Documents
git clone https://github.com/lakar-team/vtube.git vtube-repo

# 2. Copy the generated project files in (includes .gitignore; excludes nothing)
robocopy C:\Users\adamm\Documents\vtube C:\Users\adamm\Documents\vtube-repo /E /XD node_modules dist .git /XF install.log build.log

# 3. Commit and push
cd C:\Users\adamm\Documents\vtube-repo
git add -A
git commit -m "Milestone 1: webcam mocap pipeline (MediaPipe + Kalidokit + One Euro) driving VRM"
git push origin main
```

(macOS/Linux equivalent of step 2: `rsync -av --exclude node_modules --exclude dist --exclude .git vtube/ vtube-repo/`.)

After pushing you can delete the generated folder and work from the clone.

## 2. Install dependencies

```bash
cd vtube-repo   # or wherever the project root is
npm install
```

That installs everything from `package.json`, notably:

- `@mediapipe/tasks-vision` — FaceLandmarker (478 landmarks + 52 ARKit
  blendshapes) and PoseLandmarker
- `kalidokit` — landmark → VRM rig solver
- `three` + `@pixiv/three-vrm` — rendering and VRM humanoid/expressions
- `vite`, `react`, `typescript` toolchain

Verified: `npm install` and `npm run build` (strict `tsc --noEmit` +
`vite build`) were run successfully against this exact tree on 2026-06-11
(npm reported 2 moderate audit advisories in transitive dev deps — typical
for the Vite 5 toolchain, not runtime code). The leftover `install.log` /
`build.log` in the generated folder are build artifacts; don't copy them.

## 3. Get a VRM model (optional but recommended)

Drop a model at:

```
public/models/avatar.vrm
```

If absent, the app falls back to the MIT-licensed sample
`VRM1_Constraint_Twist_Sample.vrm` from the three-vrm repo (fetched over the
network — it is a bare test model with no nice face, so a real avatar is much
more satisfying). Sources:

- VRoid Studio (free) → export VRM
- VRoid Hub — check per-model licenses
- https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm/examples/models

Both VRM 0.x and VRM 1.0 work; the loader normalizes orientation
(`VRMUtils.rotateVRM0`) and drives version-independent normalized bones.

## 4. Run

```bash
npm run dev
```

Open http://localhost:5173 and allow camera access.

Recommended first-run flow:

1. Wait for "status: running" in the debug HUD and confirm the green face
   mesh + orange pose skeleton appear on your video (landmark overlay toggle).
2. Sit relaxed, face the camera, mouth closed → click **Calibrate neutral
   pose** and hold still ~2 seconds. The avatar should settle centered and
   neutral. Recalibrate any time you move your camera or chair.
3. `mirror` toggle controls whether the avatar behaves like your reflection
   (default on — the natural feel for VTubing).

Production build / preview:

```bash
npm run build
npm run preview
```

## 5. Tuning

- **Smoothing** — `src/mocap/smoothing.ts` → `SMOOTHING_PARAMS`.
  Jitter at rest: lower `minCutoff`. Laggy: raise `minCutoff`/`beta`.
- **Responsiveness / damping** — `src/vrm/applyMocapToVRM.ts` → `RIG_LERP`,
  `HEAD_NECK_SPLIT`, `SPINE_DAMP`, `GAZE_SWING`.
- **Rotation direction** — if head pitch/roll moves the wrong way on your
  model, flip signs in `ROTATION_SIGNS` (`src/vrm/applyMocapToVRM.ts`).
  This is the single knob covering Kalidokit-vs-VRM coordinate conventions.
- **Pose model** — `src/mocap/landmarkers.ts` uses `pose_landmarker_lite`;
  swap the URL to `pose_landmarker_full` for more accuracy at lower FPS.

## Kalidokit quirks (documented adapter decisions)

Kalidokit was built for the old `@mediapipe/holistic` API; we feed it
`@mediapipe/tasks-vision` output instead (`src/mocap/kalidokitAdapter.ts`):

- `Face.solve` receives `faceLandmarks[0]` (478 points vs holistic's 468 —
  the extra iris points are harmless and enable pupil tracking).
- `Pose.solve` receives `worldLandmarks[0]` + `landmarks[0]`, equivalent to
  holistic's world/image landmark pair. `enableLegs: false` (desk camera).
- Kalidokit's parameter types are stricter than its runtime needs, hence two
  `as unknown as` casts in the adapter.
- Blinks come from MediaPipe's ARKit blendshapes (`eyeBlinkLeft/Right`),
  which are far more robust than Kalidokit's landmark-distance blink
  (glasses/lighting), with Kalidokit as fallback. Mouth vowels (aa/ih/ou/
  ee/oh) come from Kalidokit since they map 1:1 to VRM presets.
- Kalidokit's internal smoothing (`smoothBlink`, dampeners) is disabled in
  favor of the One Euro filter bank, which smooths every channel uniformly
  with explicit, tunable parameters.

## Offline models (optional)

For fully-offline dev, download and serve the MediaPipe assets yourself:
copy the `wasm/` folder from `node_modules/@mediapipe/tasks-vision/wasm` into
`public/mediapipe/wasm`, download `face_landmarker.task` and
`pose_landmarker_lite.task` from the URLs in `src/mocap/landmarkers.ts` into
`public/mediapipe/`, then point `WASM_BASE` / model URLs at `/mediapipe/...`.

## Known limitations / follow-ups (milestone 2+)

- **Pose is upper-body only and basic** — forward/backward arm motion
  (toward the camera) is weak because monocular depth is noisy; full-body
  and proper arm IK are future milestones.
- **No hand/finger tracking** — add MediaPipe HandLandmarker +
  `Kalidokit.Hand.solve`.
- **Calibration is offset-only** — it zeroes the neutral pose but does not
  yet learn per-user motion *ranges* (e.g. how far your "max yaw" is);
  range normalization is a natural milestone-2 refinement.
- **Rotation sign conventions** were chosen for normalized three-vrm bones
  and verified by reasoning, not on-device testing — if anything moves
  inverted, see `ROTATION_SIGNS` above (one-line fix).
- **Expression coverage** — only blink + vowels; brows/smile/anger emotes,
  and wink-vs-blink disambiguation, are follow-ups (the ARKit blendshape
  data for them is already being computed).
- **Single face/person assumed.**
- **No recording/streaming** — explicitly out of scope for milestone 1.
