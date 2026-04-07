export type StatusPayload = { message: string; tool: string };
export type DonePayload = {
  stop_reason: string;
  usage?: { total_tokens?: number };
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
  return {
    message: value.message,
    tool: typeof tool === "string" ? tool : "",
  };
}

function isDonePayload(value: unknown): value is DonePayload {
  if (!isRecord(value)) return false;
  return typeof value.stop_reason === "string";
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
