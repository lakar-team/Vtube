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
more satisfying, and it has **no Perfect Sync blendshapes**, so it's only
useful for testing graceful-degradation of the blendshape mapper). Sources:

- VRoid Studio (free) → export VRM. Every VRoid Studio export includes a
  full finger-bone rig; check "Perfect Sync" in the export options to also
  include all 52 ARKit blendshapes.
- VRoid Hub — check per-model licenses. Two good full-featured test models:
  - **AvatarSample_A (Perfect Sync compatible)** —
    https://hub.vroid.com/en/characters/2843975675147313744/models/5644550979324015604
    — pixiv's official sample, free for commercial/non-commercial use, no
    credit required. Has full fingers + all 52 ARKit blendshapes.
  - **PerfectSyncSample (Male)** —
    https://hub.vroid.com/en/characters/2509120546947008623/models/5163931001903716096
    — purpose-built for Perfect Sync testing.
  - Download requires a (free) VRoid Hub login, then "Download" → `.vrm`.
    Save the file as `public/models/avatar.vrm` in this project (this is
    **not** automated here — the dev sandbox used to build this feature has
    no network/file-download access, so grab one of these manually to get
    full hand+face fidelity locally).
- https://github.com/pixiv/three-vrm/tree/dev/packages/three-vrm/examples/models —
  more three-vrm sample VRMs (mixed bone/blendshape completeness).

Both VRM 0.x and VRM 1.0 work; the loader normalizes orientation
(`VRMUtils.rotateVRM0`) and drives version-independent normalized bones,
including fingers.

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

## Hand / finger tracking

`src/mocap/landmarkers.ts` adds a MediaPipe `HandLandmarker` (21 landmarks ×
up to 2 hands, GPU delegate, `numHands: 2`). Each frame,
`src/mocap/kalidokitAdapter.ts` runs `Kalidokit.Hand.solve(landmarks, "Left"|
"Right", { runtime: "mediapipe" })` per detected hand and stores the result
in `frame.hands.{left,right}` as per-segment Euler rotations
(`FINGER_SEGMENTS` in `src/mocap/types.ts`: thumb metacarpal/proximal/distal,
index/middle/ring/little proximal/intermediate/distal — 15 segments per
hand).

`src/vrm/applyMocapToVRM.ts` → `applyHand()` drives the corresponding
normalized VRM humanoid bones (`leftThumbProximal`, `rightIndexIntermediate`,
etc. — works on any VRM with a standard finger rig). Untracked/missing
fingers ease back toward an identity rotation (`RIG_LERP.fingerRelaxReturn`)
rather than freezing in place. Hand landmarks are smoothed through the same
One Euro filter bank (`SMOOTHING_PARAMS.finger`) and drawn on the webcam
overlay in cyan (`WebcamView.tsx`).

**Testing hand tracking:**

1. `npm run dev`, allow camera access, make sure both hands are visible to
   the camera.
2. In the landmark overlay you should see a cyan 21-point skeleton on each
   detected hand.
3. The debug HUD shows **left hand** / **right hand** as `tracked` or `lost`.
4. On the avatar, open/close your hands and curl individual fingers — the
   avatar's fingers should follow. This requires a model with a finger bone
   rig (VRoid Studio exports always include one; the fallback
   `VRM1_Constraint_Twist_Sample.vrm` does **not** have a full finger rig, so
   use a VRoid-exported model — see "Get a VRM model" above — to verify
   finger motion).
5. Mirror mode swaps left/right consistently for hands too (a raised right
   hand moves the avatar's hand on the mirrored side, matching the head/body
   mirroring).

## Blendshape mapping (Perfect Sync / ARKit, 52 channels)

`src/mocap/types.ts` defines `ARKIT_BLENDSHAPE_NAMES` — all 52 ARKit
blendshape names MediaPipe's `FaceLandmarker` outputs (browDownLeft,
browInnerUp, cheekPuff, tongueOut, jawOpen, mouthSmileLeft, etc.), combined
with the existing VRM preset channels into `ALL_EXPRESSION_KEYS`. Every raw
MediaPipe blendshape score is now solved, calibrated, and smoothed for all
52+ channels (previously only blink + vowels).

**Mapping layer — `src/vrm/expressionMap.ts`:** when a VRM loads
(`src/vrm/loadVRM.ts`), `buildExpressionMap(vrm)` walks `ALL_EXPRESSION_KEYS`
and looks each one up against `vrm.expressionManager.getExpression(name)`
(trying both the raw ARKit name and a capitalized alias, so it works whether
the model exposes VRM 1.0 expression presets, VRM 0.x BlendShapeClips, or
custom "Perfect Sync"/ARKit-named expressions — three-vrm's loader normalizes
all of these into the same `expressionManager` API). The result is an
`ExpressionMapping`: a `Map` of mocap-channel → VRM expression name for
everything the model supports, plus a list of `unsupported` channels.

**Applying it — `src/vrm/applyMocapToVRM.ts`:** each frame, only the channels
present in `expressionMap.map` are written via
`vrm.expressionManager.setValue(vrmName, value)`. Unsupported channels are
silently skipped — no errors, no console spam, no crashes — so this works
identically on a minimal model (e.g. the fallback sample, which only exposes
blink/vowel presets) and a full Perfect Sync model.

**Debug HUD:** shows `blendshapes N/total supported` once a model has
loaded, and (if any channels are unsupported) a one-time warning panel
listing every unsupported channel name — e.g. on the fallback sample model
this will list most of the 52 ARKit names; on a full Perfect Sync model it
should be empty or near-empty.

**Testing blendshape mapping:**

1. **Graceful degradation** — run with no `public/models/avatar.vrm` (uses
   the fallback sample). Confirm: app loads with no console errors, HUD
   shows a low `N/total supported` count and lists unsupported channels, and
   blink/mouth-vowel animation still works normally.
2. **Full Perfect Sync** — drop a Perfect Sync VRM (see "Get a VRM model")
   at `public/models/avatar.vrm`. Confirm: `N/total supported` is much
   higher (ideally 52+/total), the unsupported-channel warning shrinks or
   disappears, and raising your eyebrows / puffing your cheeks / sticking
   out your tongue visibly animates the avatar in addition to blinks and
   mouth shapes.

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
- **Calibration is offset-only** — it zeroes the neutral pose but does not
  yet learn per-user motion *ranges* (e.g. how far your "max yaw" is);
  range normalization is a natural milestone-2 refinement.
- **Rotation sign conventions** were chosen for normalized three-vrm bones
  and verified by reasoning, not on-device testing — if anything moves
  inverted, see `ROTATION_SIGNS` above (one-line fix).
- **Finger rotation signs/ranges** are likewise based on Kalidokit's
  documented hand-solve output and three-vrm's normalized bone conventions,
  not on-device testing against a Perfect Sync model — verify against a
  VRoid-exported model and adjust `RIG_LERP.fingers` /
  `SMOOTHING_PARAMS.finger` if motion looks off.
- **Single face/person assumed.**
- **This change set (hand tracking + full blendshape mapping) was written
  without a working `npm install`/`tsc`/`npm run build` in the dev sandbox**
  — run `npm run build` after pulling to confirm it type-checks before
  relying on it.
- **No recording/streaming** — explicitly out of scope for milestone 1.
