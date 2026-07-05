import { useEffect, useRef, useState } from "react";

/**
 * Live, reactive setup wizard — walks a first-time user through loading a
 * model, enabling the camera, and checking the model drives correctly.
 * Unlike a static help panel, each step reacts to what's actually happening
 * (model loaded, pose detected) and auto-advances instead of waiting to be
 * dismissed. See vault/vtube/setup-wizard.md.
 *
 * Step 0 (welcome) and the "?" reopen affordance persist their dismissed
 * state to sessionStorage so a mid-session refresh doesn't re-show the
 * welcome card, but a fresh tab/session does.
 */

const DISMISS_KEY = "vtube.wizard.dismissed";

function loadDismissed(): boolean {
  try { return sessionStorage.getItem(DISMISS_KEY) === "true"; } catch { return false; }
}
function saveDismissed(): void {
  try { sessionStorage.setItem(DISMISS_KEY, "true"); } catch { /* privacy mode */ }
}

type View = "hidden" | "welcome" | "active";
type Step = 1 | 2 | 3 | 4;
type Step3Sub = "choices" | "armsCrossing" | "facing" | "other";

const TOTAL_STEPS = 4;

export interface SetupWizardProps {
  /** A GLB/GLTF/VRM model is currently loaded into the viewport. */
  modelLoaded: boolean;
  /** The loaded model is a .vrm (no AI-CAD prep needed) vs. a plain GLB. */
  modelIsVrm: boolean;
  /** MediaPipe is returning pose landmarks (the stick figure is visible/tracking). */
  poseDetected: boolean;
  /** Re-opens the model file picker (used by Step 3's "reload model" fix flow). */
  onReloadModel: () => void;
}

/** Tracks a DOM element's bounding rect live (by CSS selector), for positioning
 *  the pulsing highlight ring over whatever UI element the current step calls
 *  out. Polled on an interval rather than requestAnimationFrame — this is a
 *  layout-tracking concern, not an animation, and rAF gets throttled/paused
 *  by browsers whenever the tab is backgrounded, which would silently drop
 *  the ring. */
function useTargetRect(selector: string | null): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!selector) { setRect(null); return; }
    const tick = () => {
      const el = document.querySelector(selector);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [selector]);
  return rect;
}

function HighlightRing({ selector }: { selector: string | null }) {
  const rect = useTargetRect(selector);
  if (!rect) return null;
  return (
    <div
      className="wizard-highlight-ring"
      style={{
        left: rect.left - 6,
        top: rect.top - 6,
        width: rect.width + 12,
        height: rect.height + 12,
      }}
      aria-hidden="true"
    />
  );
}

export function SetupWizard({ modelLoaded, modelIsVrm, poseDetected, onReloadModel }: SetupWizardProps) {
  const [view, setView] = useState<View>(() => (loadDismissed() ? "hidden" : "welcome"));
  const [step, setStep] = useState<Step>(1);
  const [step3Sub, setStep3Sub] = useState<Step3Sub>("choices");
  const [step1JustLoaded, setStep1JustLoaded] = useState(false);
  const [step2SlowHint, setStep2SlowHint] = useState(false);
  const wasModelLoadedRef = useRef(false);

  const dismiss = () => { saveDismissed(); setView("hidden"); };
  const startGuide = () => { setView("active"); setStep(1); setStep3Sub("choices"); };
  const reopen = () => setView("welcome");

  // Step 1 -> 2: auto-advance once a model finishes loading. Briefly shows a
  // "loaded" confirmation (longer for GLB, to surface the AI-CAD sub-note)
  // before moving on.
  useEffect(() => {
    if (view !== "active" || step !== 1 || !modelLoaded) { setStep1JustLoaded(false); return; }
    setStep1JustLoaded(true);
    const delay = modelIsVrm ? 900 : 2200;
    const t = window.setTimeout(() => setStep(2), delay);
    return () => window.clearTimeout(t);
  }, [view, step, modelLoaded, modelIsVrm]);

  // Step 2 -> 3: auto-advance 1.5s after pose landmarks first appear; otherwise
  // surface a troubleshooting tip if nothing's been detected after 10s.
  useEffect(() => {
    if (view !== "active" || step !== 2) { setStep2SlowHint(false); return; }
    setStep2SlowHint(false);
    if (poseDetected) {
      const t = window.setTimeout(() => setStep(3), 1500);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setStep2SlowHint(true), 10000);
    return () => window.clearTimeout(t);
  }, [view, step, poseDetected]);

  // If the model gets reloaded while sitting on Step 3 (via the "reload
  // model" fix flow bouncing back through Step 1), land back on the choices.
  useEffect(() => {
    if (modelLoaded && !wasModelLoadedRef.current && step === 1) setStep3Sub("choices");
    wasModelLoadedRef.current = modelLoaded;
  }, [modelLoaded, step]);

  useEffect(() => {
    if (view === "hidden") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  const goBack = () => {
    setStep3Sub("choices");
    setStep((s) => (s > 1 ? ((s - 1) as Step) : s));
  };

  const reloadAndRecheck = () => {
    onReloadModel();
    setStep(1);
    setStep3Sub("choices");
  };

  const highlightSelector =
    view !== "active" ? null :
    step === 1 ? '[data-wizard="load-model-btn"]' :
    step === 2 ? '[data-wizard="webcam-pane"]' :
    step === 3 && step3Sub === "other" ? '[data-wizard="calibrate-btn"]' :
    null;

  return (
    <>
      <HighlightRing selector={highlightSelector} />

      {view === "hidden" && (
        <button
          type="button"
          className="wizard-fab"
          onClick={reopen}
          title="Open the setup guide"
          aria-label="Open the setup guide"
        >
          ?
        </button>
      )}

      {view === "welcome" && (
        <div className="wizard-backdrop">
          <div className="wizard-welcome-card">
            <h2>Welcome to vtube</h2>
            <p>First time? The setup guide walks you through loading a model and getting your mocap working.</p>
            <div className="wizard-welcome-actions">
              <button type="button" className="btn primary" onClick={startGuide}>Start guide →</button>
              <button type="button" className="btn" onClick={dismiss}>Skip</button>
            </div>
          </div>
        </div>
      )}

      {view === "active" && (
        <div className="wizard-panel">
          <div className="wizard-panel-header">
            <span className="wizard-progress">Step {step} of {TOTAL_STEPS}</span>
            <button type="button" className="btn wizard-close-btn" onClick={dismiss} aria-label="Close guide">×</button>
          </div>

          {step === 1 && (
            <div className="wizard-step">
              <h3>Load your character</h3>
              <p>Pick a GLB (prepared in AI-CAD) or a VRM file. VRM files load directly — no prep needed.</p>
              <p className="wizard-subnote">
                Need to prep a GLB first? Open AI-CAD and follow its setup guide, then come back and load the exported file here.
              </p>
              {step1JustLoaded && (
                <p className="wizard-note-ok">
                  Model loaded ✓{!modelIsVrm ? " — moving on to the camera…" : ""}
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="wizard-step">
              <h3>Turn on your camera</h3>
              <p>Stand back so your full body is visible. The stick figure should appear and match your movements.</p>
              <p className="wizard-subnote">If your browser asks for camera permission, allow it.</p>
              {step2SlowHint && (
                <p className="wizard-note-warn">
                  Not seeing anything yet? Make sure you're well-lit and the camera isn't too close.
                </p>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="wizard-step">
              <h3>Check your model moves correctly</h3>
              <p>Raise your right arm. The model's right arm should follow.</p>

              {step3Sub === "choices" && (
                <div className="wizard-choices">
                  <button type="button" className="btn wizard-choice ok" onClick={() => setStep(4)}>
                    ✓ Looks good
                  </button>
                  <button type="button" className="btn wizard-choice bad" onClick={() => setStep3Sub("armsCrossing")}>
                    ✗ Arms are crossing
                  </button>
                  <button type="button" className="btn wizard-choice bad" onClick={() => setStep3Sub("facing")}>
                    ✗ Model faces the wrong way
                  </button>
                  <button type="button" className="btn wizard-choice" onClick={() => setStep3Sub("other")}>
                    ✗ Something else is wrong
                  </button>
                </div>
              )}

              {step3Sub === "armsCrossing" && (
                <div className="wizard-fix">
                  <p>In AI-CAD, click <strong>Swap L/R</strong> in the Bone Rig panel, then re-export your GLB and reload it here.</p>
                  <div className="wizard-fix-actions">
                    <button type="button" className="btn primary" onClick={reloadAndRecheck}>Reload model</button>
                    <button type="button" className="btn" onClick={() => setStep3Sub("choices")}>I've fixed it — re-check</button>
                  </div>
                </div>
              )}

              {step3Sub === "facing" && (
                <div className="wizard-fix">
                  <p>In AI-CAD, click <strong>Fix Facing</strong> until the model faces you, then re-export and reload.</p>
                  <div className="wizard-fix-actions">
                    <button type="button" className="btn primary" onClick={reloadAndRecheck}>Reload model</button>
                    <button type="button" className="btn" onClick={() => setStep3Sub("choices")}>I've fixed it — re-check</button>
                  </div>
                </div>
              )}

              {step3Sub === "other" && (
                <div className="wizard-fix">
                  <p>Use the Calibration tool — stand in T-pose and click <strong>Calibrate</strong> (top-right of the viewport) for auto-diagnosis.</p>
                  <div className="wizard-fix-actions">
                    <button type="button" className="btn" onClick={() => setStep3Sub("choices")}>I've fixed it — re-check</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="wizard-step">
              <h3>You're set up!</h3>
              <p>A few useful things to try:</p>
              <ul className="wizard-tips">
                <li><strong>Mirror mode</strong> toggle — flips the camera so your movement mirrors naturally</li>
                <li><strong>Pause Bone Driving</strong> — freezes the model for inspection</li>
                <li><strong>Record</strong> — capture a mocap session to replay later</li>
              </ul>
              <button type="button" className="btn primary wizard-done-btn" onClick={dismiss}>Got it</button>
            </div>
          )}

          {step > 1 && step !== 4 && (
            <button type="button" className="btn wizard-back-btn" onClick={goBack}>← Back</button>
          )}
        </div>
      )}
    </>
  );
}
