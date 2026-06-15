import type { RigConfig, RigNumKey } from "../mocap/rig";

/**
 * Rig Tuner panel — sliders for each body-part length / thickness + head size,
 * preloaded from the RigConfig and edited live (changes flow straight to the
 * mannequin via the shared RigConfig). All values in centimeters.
 */
export interface RigTunerProps {
  rig: RigConfig;
  onChange: (key: RigNumKey, value: number) => void;
  onReset: () => void;
}

type Row = [label: string, key: RigNumKey, min: number, max: number, step: number];

const LENGTHS: Row[] = [
  ["neck", "neckCm", 1, 40, 0.5],
  ["torso", "torsoCm", 20, 90, 0.5],
  ["upper arm", "upperArmCm", 10, 60, 0.5],
  ["lower arm", "lowerArmCm", 10, 50, 0.5],
  ["upper leg", "upperLegCm", 20, 80, 0.5],
  ["lower leg", "lowerLegCm", 20, 70, 0.5],
  ["foot", "footCm", 5, 40, 0.5],
  ["shoulders", "shoulderWidthCm", 15, 70, 0.5],
  ["hips", "hipWidthCm", 10, 60, 0.5],
  ["hip height", "hipHeightCm", 40, 140, 0.5],
];

const HEAD: Row[] = [
  ["head ⌀", "headDiameterCm", 8, 40, 0.5],
];

const FACE: Row[] = [
  ["face scale", "faceScale", 0.3, 2.5, 0.05],
  ["face X", "faceOffXcm", -15, 15, 0.5],
  ["face Y", "faceOffYcm", -15, 15, 0.5],
  ["face Z", "faceOffZcm", -15, 15, 0.5],
];

const RADII: Row[] = [
  ["neck R", "neckRcm", 0.5, 15, 0.1],
  ["torso R", "torsoRcm", 1, 20, 0.1],
  ["upper arm R", "upperArmRcm", 0.5, 15, 0.1],
  ["lower arm R", "lowerArmRcm", 0.5, 12, 0.1],
  ["upper leg R", "upperLegRcm", 1, 18, 0.1],
  ["lower leg R", "lowerLegRcm", 1, 15, 0.1],
  ["foot R", "footRcm", 0.5, 10, 0.1],
  ["joints R", "jointRcm", 0.5, 12, 0.1],
  ["hands R", "handRcm", 1, 15, 0.1],
];

export function RigTuner({ rig, onChange, onReset }: RigTunerProps) {
  const slider = ([label, k, min, max, step]: Row) => (
    <label className="tuner-row" key={k}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={rig[k]}
        onChange={(e) => onChange(k, Number(e.target.value))}
      />
      <span className="tuner-val">{rig[k].toFixed(step < 1 ? 1 : 0)}</span>
    </label>
  );

  return (
    <div className="tuner-controls">
      <div className="tuner-title">
        Rig Tuner {rig.capturedAt ? "· captured" : "· default"}
      </div>
      <div className="tuner-group">lengths (cm)</div>
      {LENGTHS.map(slider)}
      <div className="tuner-group">head (cm)</div>
      {HEAD.map(slider)}
      <div className="tuner-group">face mesh</div>
      {FACE.map(slider)}
      <div className="tuner-group">thickness (cm radius)</div>
      {RADII.map(slider)}
      <button type="button" className="btn" onClick={onReset} style={{ marginTop: 10 }}>
        reset to default
      </button>
    </div>
  );
}
