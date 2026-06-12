# vtube

Webcam-driven VTuber avatar. Milestone 2: full-body, calibrated, smoothed
webcam mocap driving a VRM model — real landmark tracking, not
pixel-differencing heuristics.

**Pipeline:** webcam → MediaPipe `FaceLandmarker` (478 landmarks + 52 ARKit
blendshapes) + `PoseLandmarker` (33 landmarks, "full" model for better depth)
+ `HandLandmarker` (21 landmarks × 2 hands) → Kalidokit face/pose/hand solve
→ face + T-pose body calibration offsets → One Euro filtering → three-vrm
normalized humanoid bones (head/spine/hips/arms/wrists/fingers/legs) +
expression manager (auto-mapped per-model blendshapes).

**Stack:** Vite + React + TypeScript, Three.js, @pixiv/three-vrm,
@mediapipe/tasks-vision, Kalidokit.

## Quick start

```bash
npm install
npm run dev      # open http://localhost:5173, allow camera access
```

Optionally drop a VRM avatar at `public/models/avatar.vrm` (see
`public/models/README.md`); otherwise a hosted sample model is used.

> **Note (Google Drive):** `npm install` silently corrupts `node_modules`
> on Google Drive synced folders. Don't run npm here — use `.\build.ps1`,
> which installs/builds in a local-disk mirror and copies `dist/` back.
> See [BUILD.md](./BUILD.md).

See [SETUP.md](./SETUP.md) for full setup, repo-push instructions, tuning
notes, and known limitations.

## Calibration (do this once per camera setup)

1. **Calibrate face** — sit relaxed, look at the camera with a neutral face.
   Removes resting head-tilt and bakes your resting expression in as zero.
2. **Calibrate body (T-pose)** — click, step back so your whole body is in
   frame, and hold a T-pose (arms straight out) through the 3-second
   countdown and ~2-second capture. A T-pose is the VRM rest pose, so this
   zeroes the body solver against the model — fixing any "avatar starts with
   arms up while mine are down" mismatch — and sets the reference point that
   enables hip translation (sway, crouch, stepping toward/away from camera).

Calibration persists in `localStorage` across reloads (Reset clears it).

## What's in scope

- Live face + full-body + two-hand tracking with a landmark debug overlay
- VRM 0.x / 1.0 loading and rigging with **per-model rotation conventions**
  (VRM 0.x and 1.0 models are authored facing opposite directions; rotations
  are sign-mapped per `meta.metaVersion` so both track correctly)
- Head/neck/spine/hips/arms/wrists/fingers/legs, blink L/R, gaze, mouth
  vowels, and full ARKit/"Perfect Sync" facial blendshapes where supported
- Legs gated on lower-body visibility (seated use stays clean), `legs`
  toggle, bust/full-body camera toggle
- Two-stage calibration (face neutral + body T-pose), persisted locally
- Depth: hip-depth proxy from apparent spine length + MediaPipe world-z used
  throughout the pose solve ("full" pose model for better z accuracy)
- One Euro smoothing on every channel, tunable in `src/mocap/smoothing.ts`
- Mirror toggle (correctly mirrors face, body, and hands together), FPS /
  confidence / per-limb tracked / blendshape-support debug HUD

### Known depth limitations

MediaPipe's z coordinates come from a single camera, so depth is inferred,
not measured. Hands crossing in front of the body track reasonably; two
hands overlapping/occluding each other (fast dance moves) will still glitch
— the hand detector loses the occluded hand entirely. That's a monocular
limitation; a second camera or a depth sensor would be needed to fully solve
it.

Explicitly **not** in this milestone: screen recording, video export,
streaming output, foot-roll/toe tracking, floor contact (foot IK).
