import { useState } from "react";
import type { StatusStep } from "../lib/types";

interface Props {
  steps: StatusStep[];
}

export function ThoughtPanel({ steps }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (steps.length === 0) return null;

  const lastStep = steps[steps.length - 1];
  const lastToolLabel = lastStep.toolDisplay ?? "";
  const lastAgentLabel = lastStep.agent ?? "";

  return (
    <div className="thought-panel">
      <button
        type="button"
        className="thought-panel__toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="thought-panel__icon">{expanded ? "▾" : "▸"}</span>
        <span className="thought-panel__label">
          {lastStep.message}
          {lastAgentLabel && <span className="thought-panel__tool">{lastAgentLabel}</span>}
          {lastToolLabel && <span className="thought-panel__tool">{lastToolLabel}</span>}
        </span>
        <span className="thought-panel__count">{steps.length} step{steps.length > 1 ? "s" : ""}</span>
      </button>

      {expanded && (
        <ul className="thought-panel__list">
          {steps.map((step, idx) => (
            <li key={idx} className="thought-panel__item">
              <span className="thought-panel__step-num">{idx + 1}</span>
              <span className="thought-panel__item-message">{step.message}</span>
              <span className="thought-panel__item-pills">
                {step.agent && <span className="thought-panel__tool">{step.agent}</span>}
                {step.toolDisplay && <span className="thought-panel__tool">{step.toolDisplay}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
