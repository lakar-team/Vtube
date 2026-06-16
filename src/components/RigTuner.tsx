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
  /** Snap eye position to the detected face sockets (writes eyeX/Y/Z). */
  onSnapEyes?: () => void;
  /** Change mannequin skin tone (hex). */
  onSkinChange?: (hex: string) => void;
}

const SKIN_PRESETS: ReadonlyArray<[label: string, hex: string]> = [
  ["light", "#f0d0b8"],
  ["medium", "#d4a373"],
  ["tan", "#d4b080"],
  ["dark", "#8d5524"],
];

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
  ["hand length", "handLengthCm", 8, 30, 0.5],
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

const EYES: Row[] = [
  ["eye size", "eyeRcm", 0.4, 4, 0.1],
  ["eye sep", "eyeXcm", 0, 8, 0.1],
  ["eye Y", "eyeYcm", -6, 8, 0.1],
  ["eye Z", "eyeZcm", 0, 16, 0.1],
];

const FINGERS: Row[] = [
  ["thumb", "fingerThumb", 0.3, 2.5, 0.05],
  ["index", "fingerIndex", 0.3, 2.5, 0.05],
  ["middle", "fingerMiddle", 0.3, 2.5, 0.05],
  ["ring", "fingerRing", 0.3, 2.5, 0.05],
  ["little", "fingerLittle", 0.3, 2.5, 0.05],
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

export function RigTuner({ rig, onChange, onReset, onSnapEyes, onSkinChange }: RigTunerProps) {
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
      <div className="tuner-group">eyes (cm)</div>
      {EYES.map(slider)}
      {onSnapEyes && (
        <button type="button" className="btn" onClick={onSnapEyes} style={{ marginTop: 4 }}>
          snap eyes to face
        </button>
      )}
      <div className="tuner-group">fingers (× length)</div>
      {FINGERS.map(slider)}
      <div className="tuner-group">skin tone</div>
      <div className="tuner-skin">
        {SKIN_PRESETS.map(([label, hex]) => (
          <button
            key={hex}
            type="button"
            className={`tuner-swatch${rig.skinHex.toLowerCase() === hex.toLowerCase() ? " active" : ""}`}
            style={{ background: hex }}
            title={label}
            onClick={() => onSkinChange?.(hex)}
          />
        ))}
        <input
          type="color"
          className="tuner-color"
          value={rig.skinHex}
          title="custom skin tone"
          onChange={(e) => onSkinChange?.(e.target.value)}
        />
      </div>
      <div className="tuner-group">thickness (cm radius)</div>
      {RADII.map(slider)}
      <button type="button" className="btn" onClick={onReset} style={{ marginTop: 10 }}>
        reset to default
      </button>
    </div>
  );
}
