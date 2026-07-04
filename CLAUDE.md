# vtube

Browser-based VTuber mocap app using MediaPipe (FaceLandmarker, PoseLandmarker,
HandLandmarker) + react-three-fiber/Three.js. Drives GLB characters prepared by
the AI-CAD project (`G:\My Drive\AI Platforms\AI CAD`) via a `vtubeRig` recipe
embedded in each exported GLB's `userData`.

## CRITICAL: never run npm in this folder

This project lives on Google Drive; `npm install` here corrupts `node_modules`.
Always build through `.\build.ps1` (mirrors to a local build folder, copies
dist back), same as the AI-CAD project.

## Wiki — check before, update after

A knowledge wiki lives at `G:\My Drive\AI Platforms\Wiki` (markdown notes in
`vault/`, cross-linked with `[[note-id]]` syntax, visualized in `index.html`).
It documents *why* things are built the way they are and the bug history behind
current design choices — this file documents *what's true right now*.

**Before** starting any non-trivial task here (bone driving, coordinate
conversion, GLB loading, anything touching `GlbBoneDriver.ts`/`worldFrame.ts`):
check `vault/vtube/` and `vault/shared/` for relevant existing notes first.

**After** resolving a non-trivial bug or architecture decision: add or update a
note in `vault/vtube/`, `vault/shared/`, or `vault/issues/` as appropriate, AND
update the `status`/`updated`/`links` fields in the `wiki-chain` block at the
bottom of this file — that block is what keeps the wiki's chain view current
without anyone needing to remember to run a sync separately. See
[[claude-md-chain-architecture]] for why the block is structured this way.

<!-- wiki-chain
id: vtube-claude
status: GLB bone-driving pipeline stable — full scene-graph traversal refreshes matrixWorld every frame, fixing prior bone drift. SpringBoneSimulator added for secondary motion. Finger driving now works via inferFingerLmPair() fallback in parseVtubeRig() — Mixamo bone names are pattern-matched to MediaPipe hand landmark pairs when lmPair is absent from the GLB recipe (AI-CAD exports fingers with empty fields). Mirror-mode arm-crossing bug fixed in buildCanonicalPose() — bilateral landmark index pairs (shoulders, elbows, wrists, hips, knees, ankles, feet, ears) are swapped when mx=-1 so named joints (shL/R etc.) land on the correct model side. New: rig diagnostics + T-pose calibration loop (src/diag/rigDiagnostics.ts + DiagnosticsPanel) — flags stale restDir/L-R mismatches/empty joints at load, and suggests per-bone-pair swap / whole-rig facing-flip / restDir-refresh fixes from a live T-pose capture, with a corrected-recipe JSON download to close the loop back into AI-CAD. VRM-vs-GLB pipeline question resolved: VRM models (.vrm) now load and drive directly via vrmRigAdapter.ts's buildVrmRig(), no AI-CAD prep needed — VRMLoaderPlugin registered with autoUpdateHumanBones:false, vrm.update(dt) drives spring bones (hair/clothing) each frame; VRM expression driving still TODO. Verified against public/models/avatar.vrm (49 rig entries, zero diagnostic issues).
updated: 2026-07-05
links: [vtube-overview, ai-cad-claude, vtuberig-contract, glb-bone-driver, spring-bones, world-frame, rig-diagnostics, vrm-support]
-->
