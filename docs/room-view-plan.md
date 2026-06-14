# 3D Room View — phased plan

Rework the right-pane viewport from the current 2D screen-space skeleton
approximation to a **real metric 3D "Room View"**: a mannequin sized to the
user's actual height, standing inside a room of real dimensions.

## Why

The current `SkeletonViewport` maps normalized landmark coords straight to world
space under an orthographic camera. Positions/limb-lengths therefore scale with
the subject's distance from the camera, while thicknesses and the head are fixed
constants — so proportions warp with distance and the face mesh never sat
consistently on the head. We want consistent real-world proportions, with an
*optional overall* distance/size scale (kid vs adult) preserved deliberately.

## Viewport names (canonical)

Tagged in each component header as `VIEWPORT: <name>`.

| Name | Location | Component |
|---|---|---|
| **Mocap Camera View** | left | `WebcamView` |
| **VRM Avatar View** (Face Portrait) | avatar pane, top | `AvatarViewport` |
| **Face Mesh Panel** | avatar pane, bottom | `FaceMeshDebugView` |
| **3D Room View** | right | `SkeletonViewport` → `RoomViewport` (Phase 5) |

## Data already available

- `poseResult.worldLandmarks[0]` — 33 metric 3D points (meters, hip-origin),
  computed in `kalidokitAdapter.ts`. As of Phase 1, exposed via
  `DebugLandmarks.poseWorld`.
- `outputFacialTransformationMatrixes` (FaceLandmarker) — currently `false`;
  enable in Phase 4 for metric head pose/scale.

## Phases (each independently shippable)

1. **Foundation: naming + metric data plumbing.** *(this phase)* Apply viewport
   names; add `DebugLandmarks.poseWorld` + populate it; HUD sanity row
   (shoulder width, nose→ankle span in meters) to confirm metric data flows.
   No visual change.
2. **Height calibration → real-world scale.** "Your height (cm)" input
   (persisted); calibration module mapping world-units → meters via a robust
   standing-height proxy (watch: no crown landmark — needs anthropometric
   correction). Derive head size + limb lengths. Surface in HUD.
3. **Room View core: perspective room + metric body.** New `RoomViewport`
   behind a new "room" view-selector option (ships alongside the old view).
   Perspective camera, floor + room cube (default 2.5 m), feet-on-floor,
   y-down→y-up. Body from `poseWorld × calibration`; head = placeholder sphere.
4. **Real-size head + face mesh on the head.** Head sized from calibration;
   face mesh anchored to the head via the facial-transformation matrix (watch:
   align face camera-frame vs pose hip-frame). Contours land on the head.
5. **Settings + retire old view.** Room-size setting (2.5 m default, adjustable
   for "giant robot"), camera presets; make Room View default; remove the old
   ortho viewport; finalize `SkeletonViewport → RoomViewport` rename.

**Start with Phase 1.** Use Opus for implementation, especially Phases 3–4
(coordinate-frame math + 3D rendering).
