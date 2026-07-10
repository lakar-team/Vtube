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
status: GLB bone-driving pipeline stable — full scene-graph traversal refreshes matrixWorld every frame. SpringBoneSimulator for secondary motion. Finger driving via inferFingerLmPair() fallback. Mirror-mode arm-crossing fixed in buildCanonicalPose(). Rig diagnostics + T-pose calibration loop (src/diag/rigDiagnostics.ts + DiagnosticsPanel). VRM support via vrmRigAdapter.ts, including head/eye-gaze/expression driving (VtubeRigEntry.eulerChannel + vrm.expressionManager) and a groundAnchorModel rule for models whose proportions don't match the rig's. Live Setup Wizard (SetupWizard.tsx). parseVtubeRig() auto-locks any bone recipe'd "driven" with no usable jointFrom+jointTo or lmHand/lmPair, flagged autoLockedFromDriven, surfaced by rigDiagnostics.ts as severity:'info'. New "avatar" selector (skeleton/3D model/both simultaneous, via showSkeletonOverlay) for comparing the model's driven pose against the mocap FK — see [[glb-bone-driver]] and [[vrm-support]] for the string of VRM-driving bugs this comparison view surfaced and fixed on 2026-07-10 (wrong skeleton-root detection, wrong rest-direction child picks on secondary/spring bones, torso bow concentrated on one spine bone, fingertip leaf bones using an arbitrary rest direction, wrist twist unconstrained then mis-conditioned, finger rotation going numerically unstable near setFromUnitVectors' antipodal singularity). Fixed as of commit 2d9a14d (development-branch). Testing methodology shift: when the in-browser preview pane became unusable mid-session (stuck document.hidden/0x0 viewport), built a headless Node harness (esbuild-bundles the real driving source, builds a bone hierarchy straight from the VRM's raw glTF JSON, replays a real recorded session through the actual driving code) — verifies against real recorded motion in under a second, no camera or browser render loop needed at all; see [[glb-bone-driver]]'s "Headless test harness" section. Wrist rotation still has occasional (~1-2% of frames) instability from a related-but-distinct cause that clamping isn't the right fix for (large wrist rotations can be legitimate) — needs a temporal-continuity-aware fix, scoped as follow-up. useMocapRecorder/useMocapReplay now also capture frame.head/.pupil so a recording exercises head/eye driving too.
updated: 2026-07-10
links: [vtube-overview, ai-cad-claude, vtuberig-contract, glb-bone-driver, spring-bones, world-frame, rig-diagnostics, vrm-support, setup-wizard]
-->
