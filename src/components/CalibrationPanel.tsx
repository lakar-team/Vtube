import type { CalibrationMode } from "../mocap/calibration";

export interface CalibrationPanelProps {
  calibrating: CalibrationMode | null;
  calibrationCountdown: number;
  faceCalibrated: boolean;
  bodyCalibrated: boolean;
  faceTracked: boolean;
  poseTracked: boolean;
  onCalibrate: (mode: CalibrationMode) => void;
  onClear: () => void;
}

/**
 * Calibration controls.
 * - Face: ~2 s capture of your relaxed neutral expression/head angle.
 * - Body: 3 s countdown, then ~2 s capture while you hold a T-pose (stand
 *   facing the camera, arms straight out to the sides). This zeroes the body
 *   solver against the avatar's rest pose so your movements and the model's
 *   stay in sync, and enables hip translation (sway/crouch/depth).
 * See src/mocap/calibration.ts for the math.
 */
export function CalibrationPanel({
  calibrating,
  calibrationCountdown,
  faceCalibrated,
  bodyCalibrated,
  faceTracked,
  poseTracked,
  onCalibrate,
  onClear,
}: CalibrationPanelProps) {
  const faceLabel =
    calibrating === "face" ? "Hold still… capturing" : "Calibrate face";
  const bodyLabel =
    calibrating === "body"
      ? calibrationCountdown > 0
        ? `T-pose in ${calibrationCountdown}…`
        : "Hold the T-pose… capturing"
      : "Calibrate body (T-pose)";

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
            ? "Click, step back, and hold a T-pose (arms straight out) until capture finishes"
            : "Body not tracked yet — get in frame first"
        }
      >
        {bodyLabel}
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
          Calibrate face (seated, neutral) and body (standing T-pose) for the
          best sync.
        </span>
      )}
    </div>
  );
}
