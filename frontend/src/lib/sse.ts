import type { Citation } from "./types";

export type StatusPayload = {
  message: string;
  tool: string;
  stage?: string;
  tool_display?: string;
  agent?: string;
};
export type DonePayload = {
  stop_reason: string;
  usage?: { total_tokens?: number };
  citations?: Citation[];
};
export type ErrorPayload = { message: string; code: number };

export type ParsedEvent =
  | { event: "status"; data: StatusPayload }
  | { event: "token"; data: string }
  | { event: "done"; data: DonePayload }
  | { event: "error"; data: ErrorPayload };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeStatus(value: unknown): StatusPayload | null {
  if (!isRecord(value) || typeof value.message !== "string") return null;
  const tool = value.tool;
  const stage = value.stage;
  const toolDisplay = value.tool_display;
  const agent = value.agent;
  return {
    message: value.message,
    tool: typeof tool === "string" ? tool : "",
    stage: typeof stage === "string" ? stage : undefined,
    tool_display: typeof toolDisplay === "string" ? toolDisplay : undefined,
    agent: typeof agent === "string" ? agent : undefined,
  };
}

function isDonePayload(value: unknown): value is DonePayload {
  if (!isRecord(value) || typeof value.stop_reason !== "string") {
    return false;
  }
  const citations = value.citations;
  if (citations === undefined) {
    return true;
  }
  if (!Array.isArray(citations)) {
    return false;
  }
  return citations.every(
    (citation) =>
      isRecord(citation) &&
      typeof citation.index === "number" &&
      typeof citation.title === "string" &&
      typeof citation.url === "string",
  );
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  if (!isRecord(value)) return false;
  return typeof value.message === "string" && typeof value.code === "number";
}

export function parseSSEFrame(frame: string): ParsedEvent | null {
  const lines = frame
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let eventName: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (!eventName || dataLines.length === 0) return null;
  const dataLine = dataLines.join("\n");

  try {
    const parsedJson: unknown = JSON.parse(dataLine);

    if (eventName === "status") {
      const st = normalizeStatus(parsedJson);
      if (st) return { event: "status", data: st };
    }
    if (eventName === "token" && typeof parsedJson === "string") {
      return { event: "token", data: parsedJson };
    }
    if (eventName === "done" && isDonePayload(parsedJson)) {
      return { event: "done", data: parsedJson };
    }
    if (eventName === "error" && isErrorPayload(parsedJson)) {
      return { event: "error", data: parsedJson };
    }
  } catch {
    return null;
  }

  return null;
}
