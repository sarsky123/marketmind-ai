import type { StatusPayload } from "./sse";
import type { StatusStep } from "./types";

const TOOL_PRESENTATION: Record<string, string> = {
  search_web: "Web Search",
  get_asset_price: "Market Data",
  clarify_intent: "Clarification",
  consult_finance_agent: "Finance Analysis",
};

const AGENT_PRESENTATION: Record<string, string> = {
  finance_expert: "Financial Research",
};

function fallbackToolLabel(tool: string): string {
  const trimmed = tool.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveToolDisplayName(tool: string, toolDisplay: string): string {
  if (toolDisplay.trim()) {
    return toolDisplay.trim();
  }
  if (tool in TOOL_PRESENTATION) {
    return TOOL_PRESENTATION[tool];
  }
  return fallbackToolLabel(tool);
}

function humanizeMessage(payload: StatusPayload, toolDisplayName: string): string {
  const raw = payload.message.trim();
  if (payload.agent === "finance_expert" && payload.stage === "subagent_start") {
    return "Getting financial resources for you...";
  }
  if (!raw) {
    return toolDisplayName ? `Running ${toolDisplayName}...` : "Working...";
  }
  if (payload.stage === "tool_start" && toolDisplayName) {
    return `Running ${toolDisplayName}...`;
  }
  return raw;
}

export function normalizeStatusStep(payload: StatusPayload): StatusStep {
  const toolDisplayName = resolveToolDisplayName(payload.tool, payload.tool_display ?? "");
  const agentLabel = payload.agent ? AGENT_PRESENTATION[payload.agent] ?? fallbackToolLabel(payload.agent) : undefined;
  return {
    message: humanizeMessage(payload, toolDisplayName),
    tool: payload.tool,
    stage: payload.stage,
    toolDisplay: toolDisplayName || undefined,
    agent: agentLabel || undefined,
  };
}

