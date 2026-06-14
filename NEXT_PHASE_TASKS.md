# VTube Next Phase: Strip to Mocap + Face, Prep for Skeleton-Only Future

## Context
The current app has accumulated features from iterative development: VRM body retargeting (Kalidokit IK, "direct"/"stabilized"/"positional" tracking modes), mesh/skin customization, a 7-pose human calibration system, and multiple bow/torso-pitch estimators. Adam (the user) has decided most of this is no longer needed.

## What's working and must be PRESERVED
1. **Mocap capture** - face, hand, and body landmark capture via Mediapipe is accurate and works well. Do not touch `src/mocap/landmarkers.ts`, `useMocap.ts`, `types.ts`.
2. **VRM face tracking/expression** - the VRM model's facial motion capture (blendshapes: blink, mouth, jaw, tongue, etc. via `src/vrm/expressionMap.ts`) works well and is still needed.
3. **Skeleton 3D mannequin** - the diagnostic skeleton viewport (`SkeletonViewport.tsx`) driven directly by raw mocap landmarks is working correctly and is the long-term direction.

## What should be REMOVED (Adam's instructions, verbatim intent)
1. **All VRM body-movement/retargeting functions** - everything that moves the VRM skeleton's body bones from mocap:
   - `src/vrm/jointMatchRetarget.ts` (positional mode retargeter)
   - `src/vrm/applyPositionalToVRM.ts` (already-dead draft, confirmed unused in prior audit)
   - Body-bone retargeting logic in `src/vrm/applyMocapToVRM.ts` and `src/mocap/kalidokitAdapter.ts` - but KEEP whatever in these files drives face/expression (expressionMap usage, blendshape application). If face logic is intertwined with body logic in these files, carefully extract the face-only path rather than deleting the whole file.
   - Tracking mode selector/UI (direct/stabilized/positional dropdown) - remove entirely; VRM body becomes static (rest pose / T-pose / loaded pose, whichever looks best).
2. **Mesh/skin customization** - `src/vrm/skin.ts`, any UV texture customization UI and state.
3. **Human calibration pose system** - `src/mocap/calibration.ts`, `src/components/CalibrationPanel.tsx`, the 7-pose calibration flow, calibration buttons/UI, calibration localStorage state.
4. **Bow/torso-pitch tracking** - all bow estimator modes (hybrid/size/z), `torsoPitchSource` state and UI dropdown, and related logic in kalidokitAdapter.ts.

## New focus for this phase
- Reconfigure the VRM viewport into a **portrait-size view focused on the face**, showing the VRM head/face with live facial tracking (expressions/blendshapes from mocap). The VRM body can remain static/untouched in the background or be cropped out of view - it is no longer being driven by mocap.
- Keep the **Skeleton 3D mannequin** view working exactly as it is now (full-body mocap-driven movement) - this remains the primary "body" representation.
- Suggested resulting UI: two panes - (1) skeleton mannequin (full body, mocap-driven), (2) VRM face portrait (face/head only, facial-tracking-driven). Remove view-mode dropdown complexity (avatar/skeleton/both, tracking mode, bow mode, calibration) since most of those options are being removed.

## Future phase (do not implement now, just be aware)
After face-on-skeleton is solved in a later phase, the VRM will be removed entirely in favor of fully custom models built via the skeleton method. Don't architect anything in a way that makes that harder, but don't build it now either.

## Suggested approach / order of operations
1. Read through `App.tsx`, `AvatarViewport.tsx`, `SkeletonViewport.tsx`, `applyMocapToVRM.ts`, `kalidokitAdapter.ts`, `jointMatchRetarget.ts`, `expressionMap.ts`, `calibration.ts`, `CalibrationPanel.tsx`, `skin.ts` to map exactly what's face-related vs body-related vs calibration/bow-related before deleting anything.
2. Extract/isolate the face-tracking application logic (mocap face landmarks/blendshapes -> VRM expressions) into a clean, minimal path that doesn't depend on body retargeting, calibration, or bow estimation.
3. Remove calibration system (panel, state, storage, UI).
4. Remove bow/torso-pitch estimators and UI.
5. Remove body retargeting (jointMatchRetarget, applyPositionalToVRM, body-bone code in applyMocapToVRM/kalidokitAdapter), tracking-mode dropdown.
6. Remove skin/mesh customization.
7. Rework UI/layout: skeleton mannequin (body) + VRM face portrait (face), drop now-unused dropdowns/buttons/panels.
8. Build per BUILD.md, verify locally that: mocap capture still works, skeleton mannequin still moves correctly with the body, VRM face still shows live expressions in portrait view.
9. Commit and push (Cloudflare auto-deploys to vtubemaker.pages.dev). Report commit hash(es).

## Notes
- This is a large change - consider doing it in a few focused commits (e.g. one for calibration/bow removal, one for body-retargeting removal, one for skin removal, one for the new UI layout) rather than one giant commit, so it's easier to review/bisect if something breaks.
- If removing a file breaks an import elsewhere, fix the import rather than leaving dead imports.
- Test the build (`npm run build` / per BUILD.md) after each major removal step to catch breakage early.
