export interface CalibrationPanelProps {
  calibrating: boolean;
  calibrated: boolean;
  faceTracked: boolean;
  onCalibrate: () => void;
  onClear: () => void;
}

/**
 * Neutral-pose calibration controls.
 * Capture ~2 s of "rest" pose; subsequent tracking is offset so the avatar
 * starts centered and neutral. See src/mocap/calibration.ts for the math.
 */
export function CalibrationPanel({
  calibrating,
  calibrated,
  faceTracked,
  onCalibrate,
  onClear,
}: CalibrationPanelProps) {
  return (
    <div className="calibration-panel">
      <button
        className="btn primary"
        onClick={onCalibrate}
        disabled={calibrating || !faceTracked}
        title={
          faceTracked
            ? "Hold a relaxed neutral pose facing the camera, then click"
            : "Face not tracked yet — get in frame first"
        }
      >
        {calibrating ? "Hold still… capturing" : "Calibrate neutral pose"}
      </button>
      {calibrated && !calibrating && (
        <>
          <span className="calib-status ok">calibrated</span>
          <button className="btn" onClick={onClear}>
            Reset
          </button>
        </>
      )}
      {!calibrated && !calibrating && (
        <span className="calib-status hint">
          Sit relaxed, look at the camera, close your mouth — then calibrate.
        </span>
      )}
    </div>
  );
}
