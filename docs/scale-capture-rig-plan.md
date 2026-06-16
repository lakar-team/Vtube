# Scale-capture + Rig Tuner — phased plan

Replace continuous per-frame calibration/rescaling with a **one-time scale
capture** into a fixed `RigConfig`, add a **Rig Tuner** view to edit proportions,
and make the live 3D view a **performance view** that only retargets motion onto
the already-sized rig.

## Architectural shift

Today the mannequin (`RoomViewport`) is drawn directly from live landmarks every
frame — bone lengths = live landmark distances, scaled by a continuously-updated
`metersPerUnit`. The new model is a **fixed-proportion rig driven by live
motion**: capture proportions once, then each frame mocap supplies only the bone
*directions*, applied to *fixed* captured lengths (forward kinematics).

## Core data: `RigConfig` (src/mocap/rig.ts)

Persisted (localStorage `vtube.rigConfig`), all lengths in cm: per-bone lengths
(neck, torso, upper/lower arm, upper/lower leg, foot, shoulder/hip width), head
diameter, hip height, entered height, `capturedAt`. Later phases add per-part
radii and face offset/scale. Produced by capture, edited by the tuner, consumed
by the performance view.

## Phases (small, independently shippable)

1. **RigConfig model + scale-capture (countdown + one-shot snapshot).** ✅ DONE
   - `rig.ts`: type, defaults, persistence, `captureRigConfig()` (anchors scale
     to entered height via eye-height proxy; null if not fully in frame).
   - "capture scale" button → big full-screen 5s countdown → snapshot the frame's
     proportions into `RigConfig`. HUD shows captured values. No rendering change.

2. **Fixed-proportion rig via forward kinematics (the meaty one).**
   - Rework `RoomViewport` to render from `RigConfig`: fixed captured bone
     lengths + live bone directions (poseWorld deltas), chained by FK from the
     hip root at the captured hip height. Thickness/head from `RigConfig`;
     hands/face anchor to the FK wrist/head. Remove continuous `metersPerUnit`
     rescaling. Fall back to `DEFAULT_RIG` (or prompt) if not yet captured.

3. **Rig Tuner view (per-part sliders, live feedback).**
   - New "tuner" view: mannequin + sliders for each body-part length/thickness +
     head size, preloaded from `RigConfig`, live-editable, persisted.

4. **Filled face surface + face position/scale tuner.**
   - Convert the face from contour `LineSegments` to a filled triangle `Mesh`.
     Data dependency: the current `FACE_TESSELATION` is an EDGE list — a filled
     surface needs the canonical MediaPipe ~898-triangle index list (source it
     this phase). Add face offset {x,y,z} + scale sliders to the tuner.

5. **Performance view + workflow finalization.**
   - View modes: Performance (live motion on fixed rig — today's Room View, no
     calibration), Rig Tuner, Avatar, Both. Wire capture into the flow; polish
     countdown, persistence, naming, empty-state prompt.

## Naming
- Capture = a control/button + countdown overlay (not a view).
- New **Rig Tuner View**; the **3D Room View** becomes the **Performance View**.
- Unchanged: Mocap Camera View, VRM Avatar View, Face Mesh Panel.

## Risk
Phase 2 (FK: coordinate frames + chaining) is the highest-risk — use Opus.

## Future / not-yet-scheduled
- **Imported 3D model as the rig.** Evaluate loading an external mesh
  (OBJ / glTF / VRM) to act as the rigged skeleton, driven by the same mocap
  data that currently drives the primitive mannequin. The FK skeleton + RigConfig
  proportions we build here become the retarget target: map captured bone
  lengths/joint frames onto the imported model's humanoid bones (VRM already has
  a normalized humanoid bone map; glTF/OBJ would need a skinned skeleton or an
  auto-rig step). Goal: swap the cylinder/sphere mannequin for a real avatar mesh
  while keeping the distance-invariant, fixed-proportion driving model. Raised
  2026-06-16; no implementation yet.
