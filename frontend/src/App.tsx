import { useMemo, useRef, useState } from "react";

type HealthResponse = { postgres: boolean; redis: boolean };

type ChatRole = "user" | "assistant" | "system";
type ChatMessage = { role: ChatRole; content: string };
type ChatRequest = { messages: ChatMessage[] };

type StatusPayload = { message: string };
type TokenPayload = { text: string };

type StatusEvent = { event: "status"; data: StatusPayload };
type TokenEvent = { event: "token"; data: TokenPayload };
type ParsedEvent = StatusEvent | TokenEvent;

function isStatusPayload(value: unknown): value is StatusPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function isTokenPayload(value: unknown): value is TokenPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function parseSSEFrame(frame: string): ParsedEvent | null {
  const lines = frame
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let eventName: string | null = null;
  let dataLine: string | null = null;

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLine = line.slice("data:".length).trim();
    }
  }

  if (!eventName || !dataLine) return null;

  const parsedJson: unknown = JSON.parse(dataLine);

  if (eventName === "status" && isStatusPayload(parsedJson)) {
    return { event: "status", data: parsedJson };
  }

  if (eventName === "token" && isTokenPayload(parsedJson)) {
    return { event: "token", data: parsedJson };
  }

  return null;
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [isHealthLoading, setIsHealthLoading] = useState<boolean>(false);

  const [prompt, setPrompt] = useState<string>("Hello");
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [streamText, setStreamText] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const chatRequest: ChatRequest = useMemo(() => {
    const userMessage: ChatMessage = { role: "user", content: prompt };
    return { messages: [userMessage] };
  }, [prompt]);

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
    setStreamError(null);
    setStreamText("");
    setStatusMessages([]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chatRequest),
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

        // SSE frames are separated by a blank line.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const event = parseSSEFrame(frame);
          if (!event) continue;

          if (event.event === "status") {
            setStatusMessages((prev) => [...prev, event.data.message]);
          } else if (event.event === "token") {
            setStreamText((prev) => prev + event.data.text);
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Expected when the user clicks Stop Generating.
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
      <h1>Walking Skeleton</h1>

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
        <h2>Dummy SSE Stream</h2>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          style={{ width: "100%", maxWidth: 520 }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onStreamClick} disabled={isStreaming}>
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

        {statusMessages.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <h3>Thought Process</h3>
            <ul>
              {statusMessages.map((m, idx) => (
                <li key={`${m}-${idx}`}>{m}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div style={{ marginTop: 12 }}>
          <h3>Stream Output</h3>
          <div
            style={{
              whiteSpace: "pre-wrap",
              background: "#f5f5f5",
              padding: 12,
              minHeight: 48,
              maxWidth: 720,
            }}
          >
            {streamText || <span style={{ color: "#777" }}>No streamed text yet.</span>}
          </div>
        </div>
      </section>
    </main>
  );
}

