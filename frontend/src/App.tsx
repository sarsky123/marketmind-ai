import { useCallback, useRef, useState } from "react";

type HealthResponse = { postgres: boolean; redis: boolean };

type StatusPayload = { message: string; tool: string };
type DonePayload = {
  stop_reason: string;
  usage?: { total_tokens?: number };
};
type ErrorPayload = { message: string; code: number };

type ParsedEvent =
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
  return (
    typeof value.message === "string" &&
    typeof value.code === "number"
  );
}

function parseSSEFrame(frame: string): ParsedEvent | null {
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

type StatusRow = { message: string; tool: string };

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [isHealthLoading, setIsHealthLoading] = useState<boolean>(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState<boolean>(false);

  const [prompt, setPrompt] = useState<string>(
    "What is the latest US CPI story in the news?"
  );
  const [statusRows, setStatusRows] = useState<StatusRow[]>([]);
  const [streamText, setStreamText] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const [doneInfo, setDoneInfo] = useState<DonePayload | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const onCreateSession = useCallback(async (): Promise<void> => {
    setIsSessionLoading(true);
    setSessionError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Chat" }),
      });
      if (!res.ok) {
        throw new Error(`Create session failed: ${res.status}`);
      }
      const data: { session_id: string; user_id: string } = await res.json();
      setSessionId(data.session_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setSessionError(message);
      setSessionId(null);
    } finally {
      setIsSessionLoading(false);
    }
  }, []);

  async function onHealthClick(): Promise<void> {
    setIsHealthLoading(true);
    setHealthError(null);
    try {
      const res = await fetch("/health", { method: "GET" });
      if (!res.ok) {
        throw new Error(`Health request failed: ${res.status}`);
      }
      const data: HealthResponse = (await res.json()) as HealthResponse;
      setHealth(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setHealthError(message);
      setHealth(null);
    } finally {
      setIsHealthLoading(false);
    }
  }

  async function onStreamClick(): Promise<void> {
    if (!sessionId) {
      setStreamError("Create a session first.");
      return;
    }

    setStreamError(null);
    setStreamText("");
    setStatusRows([]);
    setDoneInfo(null);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          message: prompt,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Stream request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const event = parseSSEFrame(frame);
          if (!event) continue;

          if (event.event === "status") {
            setStatusRows((prev) => [
              ...prev,
              { message: event.data.message, tool: event.data.tool },
            ]);
          } else if (event.event === "token") {
            setStreamText((prev) => prev + event.data);
          } else if (event.event === "done") {
            setDoneInfo(event.data);
            setIsStreaming(false);
          } else if (event.event === "error") {
            setStreamError(`${event.data.message} (${event.data.code})`);
            setIsStreaming(false);
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      setStreamError(message);
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }

  function onStopClick(): void {
    abortControllerRef.current?.abort();
  }

  return (
    <main style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1>AI Financial Assistant</h1>

      <section style={{ marginTop: 16 }}>
        <h2>Health Check</h2>
        <button type="button" onClick={onHealthClick} disabled={isHealthLoading}>
          {isHealthLoading ? "Checking..." : "Check /health"}
        </button>

      {healthError ? <p style={{ color: "crimson" }}>{healthError}</p> : null}

        {health ? (
          <pre style={{ background: "#f5f5f5", padding: 12 }}>
            {JSON.stringify(health, null, 2)}
          </pre>
        ) : null}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Chat session</h2>
        <button
          type="button"
          onClick={onCreateSession}
          disabled={isSessionLoading}
        >
          {isSessionLoading ? "Creating…" : "Create session"}
        </button>
        {sessionError ? (
          <p style={{ color: "crimson" }}>{sessionError}</p>
        ) : null}
        {sessionId ? (
          <p>
            <code>session_id</code>: {sessionId}
          </p>
        ) : (
          <p style={{ color: "#666" }}>No session yet.</p>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Stream chat</h2>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          style={{ width: "100%", maxWidth: 520 }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            onClick={onStreamClick}
            disabled={isStreaming || !sessionId}
          >
            {isStreaming ? "Streaming..." : "Send"}
          </button>
          <button
            type="button"
            onClick={onStopClick}
            disabled={!isStreaming}
            title="Abort the fetch stream"
          >
            Stop Generating
          </button>
        </div>
        {streamError ? <p style={{ color: "crimson" }}>{streamError}</p> : null}

        {statusRows.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <h3>Thought process</h3>
            <ul style={{ maxWidth: 720 }}>
              {statusRows.map((row, idx) => (
                <li key={`${row.message}-${idx}`}>
                  {row.message}
                  {row.tool ? (
                    <span style={{ color: "#555", marginLeft: 8 }}>
                      ({row.tool})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div style={{ marginTop: 12 }}>
          <h3>Assistant reply</h3>
          <div
            style={{
              whiteSpace: "pre-wrap",
              background: "#f5f5f5",
              padding: 12,
              minHeight: 48,
              maxWidth: 720,
            }}
          >
            {streamText || (
              <span style={{ color: "#777" }}>No streamed text yet.</span>
            )}
          </div>
        </div>

        {doneInfo ? (
          <p style={{ marginTop: 8, fontSize: 14, color: "#333" }}>
            Done: {doneInfo.stop_reason}
            {doneInfo.usage?.total_tokens != null
              ? ` — tokens: ${String(doneInfo.usage.total_tokens)}`
              : null}
          </p>
        ) : null}
      </section>
    </main>
  );
}
