# vtube

Webcam-driven VTuber avatar. Milestone 1: an accurate, calibrated, smoothed
webcam mocap pipeline driving a VRM model — real landmark tracking, not
pixel-differencing heuristics.

**Pipeline:** webcam → MediaPipe `FaceLandmarker` (478 landmarks + 52 ARKit
blendshapes) + `PoseLandmarker` (33 landmarks) → Kalidokit face/pose solve →
neutral-pose calibration offsets → One Euro filtering → three-vrm normalized
humanoid bones + expression manager.

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

## What's in scope (milestone 1)

- Live face + upper-body tracking with a landmark debug overlay
- VRM 0.x / 1.0 loading and rigging (head/neck/spine/arms, blink L/R, gaze,
  mouth vowels)
- Neutral-pose calibration ("Calibrate" button)
- One Euro smoothing on every channel, tunable in `src/mocap/smoothing.ts`
- Mirror toggle, FPS / confidence / raw-vs-smoothed debug HUD

Explicitly **not** in this milestone: screen recording, video export,
streaming output, hand tracking, full-body IK.
