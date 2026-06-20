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
current design choices.

**Before** starting any non-trivial task here (bone driving, coordinate
conversion, GLB loading, anything touching `GlbBoneDriver.ts`/`worldFrame.ts`):
check `vault/vtube/` and `vault/shared/` for relevant existing notes first.

**After** resolving a non-trivial bug or architecture decision: add or update a
note in `vault/vtube/`, `vault/shared/`, or `vault/issues/` as appropriate, and
keep `index.html`'s embedded data block in sync (run `node generate-graph.mjs`
in the Wiki folder, or hand-edit the block between the `WIKI-DATA-START`/`END`
markers if you can't run it). Don't let architecture knowledge live only in a
chat transcript or commit message — the wiki is what the next session (human
or AI) actually reads first.
