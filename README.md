# vtube

Webcam-driven VTuber avatar. Milestone 1: an accurate, calibrated, smoothed
webcam mocap pipeline driving a VRM model — real landmark tracking, not
pixel-differencing heuristics.

**Pipeline:** webcam → MediaPipe `FaceLandmarker` (478 landmarks + 52 ARKit
blendshapes) + `PoseLandmarker` (33 landmarks) + `HandLandmarker` (21
landmarks × 2 hands) → Kalidokit face/pose/hand solve → neutral-pose
calibration offsets → One Euro filtering → three-vrm normalized humanoid
bones (incl. fingers) + expression manager (auto-mapped per-model
blendshapes).

**Stack:** Vite + React + TypeScript, Three.js, @pixiv/three-vrm,
@mediapipe/tasks-vision, Kalidokit.

## Quick start

```bash
npm install
npm run dev      # open http://localhost:5173, allow camera access
```

Optionally drop a VRM avatar at `public/models/avatar.vrm` (see
`public/models/README.md`); otherwise a hosted sample model is used.

See [SETUP.md](./SETUP.md) for full setup, repo-push instructions, tuning
notes, and known limitations.

## What's in scope

- Live face + upper-body + two-hand tracking with a landmark debug overlay
- VRM 0.x / 1.0 loading and rigging (head/neck/spine/arms, fingers, blink
  L/R, gaze, mouth vowels, and full ARKit/"Perfect Sync" facial blendshapes
  where the model supports them)
- Automatic per-model blendshape mapping with graceful degradation — see
  "Blendshape mapping" in [SETUP.md](./SETUP.md)
- Neutral-pose calibration ("Calibrate" button)
- One Euro smoothing on every channel, tunable in `src/mocap/smoothing.ts`
- Mirror toggle, FPS / confidence / hand-tracked / blendshape-support
  raw-vs-smoothed debug HUD

Explicitly **not** in this milestone: screen recording, video export,
streaming output, full-body/leg IK.
