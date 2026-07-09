# vtube

Browser-based VTuber mocap app using MediaPipe (FaceLandmarker, PoseLandmarker,
HandLandmarker) + react-three-fiber/Three.js. Drives GLB characters prepared by
the AI-CAD project (`G:\My Drive\AI Platforms\AI CAD`) via a `vtubeRig` recipe
embedded in each exported GLB's `userData`.

## CRITICAL: never run npm in this folder

This project lives on Google Drive; `npm install` here corrupts `node_modules`.
Always build through `.\build.ps1` (mirrors to a local build folder, copies
dist back), same as the AI-CAD project.

## Deployment

Cloudflare Pages is connected to the GitHub repo (github.com/lakar-team/Vtube)
via Git integration — no manual upload or wrangler CLI needed. Every push to
any branch triggers a build + deploy on Cloudflare's servers; whichever
branch is set as "production" in the Cloudflare Pages dashboard is what goes
live at **vtubemaker.pages.dev** (check the dashboard if you need to know
which branch that currently is — don't assume it matches whatever branch
you're on).

Workflow:
1. Make changes to source files
2. Build with `.\build.ps1` (local verification — catches TypeScript errors before push)
3. `git push` (pushes the current branch — no need to name it; use
   `git push -u origin HEAD` the first time a new branch has no upstream yet)
4. Cloudflare builds from source on their servers and deploys automatically

The build.ps1 comment "upload that to Cloudflare Pages" is outdated — the Git
integration handles deployment automatically.

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
status: GLB bone-driving pipeline stable — full scene-graph traversal refreshes matrixWorld every frame. SpringBoneSimulator for secondary motion. Finger driving via inferFingerLmPair() fallback. Mirror-mode arm-crossing fixed in buildCanonicalPose(). Rig diagnostics + T-pose calibration loop (src/diag/rigDiagnostics.ts + DiagnosticsPanel). VRM support via vrmRigAdapter.ts. Live Setup Wizard (SetupWizard.tsx). parseVtubeRig() auto-locks any bone recipe'd "driven" with no usable jointFrom+jointTo or lmHand/lmPair, flagged autoLockedFromDriven, surfaced by rigDiagnostics.ts as severity:'info'. (2026-07-10, development-branch, commit e59885d): fixed two VRM-driving bugs found via a new skeleton-overlay comparison feature — findHipsLocalY() was picking a ground-level "Root" bone instead of "Hips" on rigs with an extra Bone-typed wrapper above Hips (now picks the shallowest rig bone instead of requiring zero Bone ancestors), and computeRestDirLength()/bindWorldDirOf() were picking a bone's first child (often a VRoid secondary/spring bone — skirt or bust physics) instead of the real skeletal continuation for rest-direction reference (vrmRigAdapter.ts now declares the correct CHAIN_CHILD per joint, stored as VtubeRigEntry.childBone so rig-diagnostics reuses it). Also added: RoomViewport's showSkeletonOverlay rule (mannequin + model rendered simultaneously, same world-space hip anchor, mannequin ghosted translucent), a 3-way "avatar" selector in App.tsx (skeleton/3D model/both), and public/models/avatar.vrm now preloads on startup instead of requiring a manual load. New (2026-07-10, commits c9b4c36+22f92e4): head and eye-gaze bones were entirely unmapped/locked for VRM models (mocap already computes frame.head/.pupil every frame, just never reached the renderer) and VRM expression driving was a literal TODO — all three now wired up via a new VtubeRigEntry.eulerChannel mechanism ('head'/'gazeL'/'gazeR', bypasses restDir direction-matching) plus vrm.expressionManager.setValue() for EXPRESSION_KEYS. Wrist bones now fall back to elbow->wrist FK direction when hand landmarks drop out (previously froze the whole hand, not just fingers). New groundAnchorModel rule (off by default) plants the model's own feet on the floor instead of hip-height-matching, for models whose own proportions don't match the rig's (confirmed ~15cm sink on this project's avatar.vrm with the default rig). NOT verified against live mocap (no camera in the session's sandboxed preview) — rotation sign/axis convention needs confirming against a real camera. Newest (2026-07-10, commit c074fed): fixed wrist twist/roll being unconstrained — every driven bone used single-vector alignment (setFromUnitVectors), which for the wrist only encodes "which way the hand points," leaving palm-facing rotation to an arbitrary minimal-rotation artifact. Diagnosed against a real user-recorded session (mocap-replay.md) — wrist worldDir was ~always dominant +Y regardless of actual hand pose. Fixed via a second reference axis (restSideLocal/lmSidePair, toward the index finger) and a proper change-of-basis quaternion (basisQuaternion() in GlbBoneDriver.ts) instead of single-axis alignment, for wrist bones only. Recording/replay (useMocapRecorder/useMocapReplay) now also captures frame.head/.pupil so a recording exercises the new head/eye driving too. Verified: bug signature confirmed against real data, fix runs error-free through real replay data — NOT yet visually confirmed (preview harness's canvas/ResizeObserver became unreliable this session, environment issue not code). See [[glb-bone-driver]] and [[vrm-support]] for full bug writeups.
updated: 2026-07-10
links: [vtube-overview, ai-cad-claude, vtuberig-contract, glb-bone-driver, spring-bones, world-frame, rig-diagnostics, vrm-support, setup-wizard]
-->
