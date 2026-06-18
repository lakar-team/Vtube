import { useState } from "react";

/**
 * Rules Inspector — a live on/off switch for every meaningful behavioural rule /
 * modifier / flag in the processing pipeline. Toggling a switch updates the
 * shared state that drives the mannequin in real time, so the effect of each
 * rule is immediately visible. "Copy rules state" exports the full set as JSON.
 */
export interface RuleToggleItem {
  key: string;
  label: string;
  value: boolean;
  onToggle: (v: boolean) => void;
}

export interface RuleNumberItem {
  key: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onSet: (v: number) => void;
}

export interface RulesInspectorProps {
  toggles: RuleToggleItem[];
  numbers?: RuleNumberItem[];
}

export function RulesInspector({ toggles, numbers }: RulesInspectorProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const obj: Record<string, boolean> = {};
    for (const t of toggles) obj[t.key] = t.value;
    const text = JSON.stringify(obj, null, 2);
    const done = () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => { /* ignore */ });
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch { /* ignore */ }
      ta.remove();
    }
  };

  return (
    <div className="tuner-controls">
      <div className="tuner-title">Rules Inspector</div>
      <button type="button" className="btn tuner-copy" onClick={copy}>
        {copied ? "copied ✓" : "copy rules state (JSON)"}
      </button>
      <div className="tuner-group">active processing rules</div>
      {toggles.map((t) => (
        <label className="rule-row" key={t.key}>
          <span>{t.label}</span>
          <input
            type="checkbox"
            className="rule-switch"
            checked={t.value}
            onChange={(e) => t.onToggle(e.target.checked)}
          />
          <span className={`rule-state ${t.value ? "on" : "off"}`}>{t.value ? "on" : "off"}</span>
        </label>
      ))}
      {numbers && numbers.length > 0 && (
        <div className="tuner-group">debug controls</div>
      )}
      {numbers?.map((n) => (
        <label className="rule-row" key={n.key}>
          <span>{n.label}</span>
          <input
            type="number"
            min={n.min ?? 0}
            max={n.max ?? 9999}
            step={n.step ?? 1}
            value={n.value}
            onChange={(e) => n.onSet(Number(e.target.value))}
            style={{ width: "4.5em" }}
          />
        </label>
      ))}
    </div>
  );
}
