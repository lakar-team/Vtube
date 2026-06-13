import type { BodyPoseStatus, CalibrationMode } from "../mocap/calibration";

export interface CalibrationPanelProps {
  calibrating: CalibrationMode | null;
  bodyPose: BodyPoseStatus | null;
  faceCalibrated: boolean;
  bodyCalibrated: boolean;
  faceTracked: boolean;
  poseTracked: boolean;
  onCalibrate: (mode: CalibrationMode) => void;
  onSkipPose: () => void;
  onCancel: () => void;
  onClear: () => void;
}

/**
 * Calibration controls.
 * - Face: ~2 s capture of your relaxed neutral expression/head angle.
 * - Body: a guided pose sequence. The AVATAR demonstrates each pose (relaxed
 *   neutral, half raise, ~30° bow) and you copy it — each pose has a 5 s
 *   countdown to get into position, then a ~2 s capture, and can be skipped.
 *   No T-pose: nothing in the sequence needs arm-span room.
 * See src/mocap/calibration.ts for the math.
 */
export function CalibrationPanel({
  calibrating,
  bodyPose,
  faceCalibrated,
  bodyCalibrated,
  faceTracked,
  poseTracked,
  onCalibrate,
  onSkipPose,
  onCancel,
  onClear,
}: CalibrationPanelProps) {
  // Body sequence in progress: replace the buttons with the pose guide.
  if (calibrating === "body" && bodyPose) {
    return (
      <div className="calibration-panel">
        <div className="calib-pose">
          <span className="calib-pose-step">
            pose {bodyPose.index + 1}/{bodyPose.total} — {bodyPose.pose.title}
          </span>
          <span className="calib-pose-instruction">
            Copy the avatar: {bodyPose.pose.instruction}
          </span>
          <span className="calib-pose-state">
            {bodyPose.phase === "countdown"
              ? `get into position… ${bodyPose.countdown}`
              : `hold it… capturing ${Math.round(bodyPose.progress * 100)}%`}
          </span>
        </div>
        <button className="btn" onClick={onSkipPose} title="Can't do this pose / no room? Skip it — the rest still calibrates.">
          Skip pose
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  const faceLabel =
    calibrating === "face" ? "Hold still… capturing" : "Calibrate face";

  return (
    <div className="calibration-panel">
      <button
        className="btn primary"
        onClick={() => onCalibrate("face")}
        disabled={calibrating !== null || !faceTracked}
        title={
          faceTracked
            ? "Sit relaxed, look at the camera with a neutral face, then click"
            : "Face not tracked yet — get in frame first"
        }
      >
        {faceLabel}
      </button>
      <button
        className="btn primary"
        onClick={() => onCalibrate("body")}
        disabled={calibrating !== null || !poseTracked}
        title={
          poseTracked
            ? "The avatar will demonstrate 7 poses (relax, half raise, bow, hands on hips, arms raised, salute, arms crossed) — copy each one. No T-pose, no extra room needed."
            : "Body not tracked yet — get in frame first"
        }
      >
        Calibrate body
      </button>
      {(faceCalibrated || bodyCalibrated) && !calibrating && (
        <>
          <span className="calib-status ok">
            {faceCalibrated && bodyCalibrated
              ? "face + body calibrated"
              : faceCalibrated
                ? "face calibrated"
                : "body calibrated"}
          </span>
          <button className="btn" onClick={onClear}>
            Reset
          </button>
        </>
      )}
      {!faceCalibrated && !bodyCalibrated && !calibrating && (
        <span className="calib-status hint">
          Calibrate face (seated, neutral) and body (copy 3 poses the avatar
          shows you) for the best sync.
        </span>
      )}
    </div>
  );
}
