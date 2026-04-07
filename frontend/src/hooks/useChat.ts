import { useCallback, useEffect, useRef, useState } from "react";
import { parseSSEFrame } from "../lib/sse";
import type { DonePayload } from "../lib/sse";
import type { ChatMessage, ChatPhase, StatusStep } from "../lib/types";

let msgCounter = 0;
function nextId(): string {
  msgCounter += 1;
  return `msg-${msgCounter}-${Date.now()}`;
}

interface UseChatReturn {
  sessionId: string | null;
  messages: ChatMessage[];
  statusSteps: StatusStep[];
  streamingContent: string;
  phase: ChatPhase;
  error: string | null;
  usage: DonePayload["usage"] | null;
  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
  initSession: () => Promise<void>;
}

export function useChat(): UseChatReturn {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusSteps, setStatusSteps] = useState<StatusStep[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<DonePayload["usage"] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const initSession = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Chat" }),
      });
      if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
      const data: { session_id: string } = await res.json();
      setSessionId(data.session_id);
      setMessages([]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    }
  }, []);

  useEffect(() => {
    void initSession();
  }, [initSession]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionId || phase === "streaming") return;

      const userMsg: ChatMessage = { id: nextId(), role: "user", content: text };
      setMessages((prev) => [...prev, userMsg]);
      setStatusSteps([]);
      setStreamingContent("");
      setError(null);
      setUsage(null);
      setPhase("streaming");

      const controller = new AbortController();
      abortRef.current = controller;

      let accumulated = "";

      try {
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, message: text }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Stream failed: ${res.status}`);
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
            const ev = parseSSEFrame(frame);
            if (!ev) continue;

            if (ev.event === "status") {
              setStatusSteps((prev) => [
                ...prev,
                { message: ev.data.message, tool: ev.data.tool },
              ]);
            } else if (ev.event === "token") {
              accumulated += ev.data;
              setStreamingContent(accumulated);
            } else if (ev.event === "done") {
              const finalContent = accumulated;
              setMessages((prev) => [
                ...prev,
                {
                  id: nextId(),
                  role: "assistant",
                  content: finalContent,
                  citations: ev.data.citations,
                },
              ]);
              setStreamingContent("");
              setUsage(ev.data.usage ?? null);
              setPhase("idle");
            } else if (ev.event === "error") {
              setError(`${ev.data.message} (${ev.data.code})`);
              if (accumulated) {
                setMessages((prev) => [
                  ...prev,
                  { id: nextId(), role: "assistant", content: accumulated },
                ]);
                setStreamingContent("");
              }
              setPhase("error");
            }
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          if (accumulated.length > 0) {
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: "assistant", content: accumulated },
            ]);
            setStreamingContent("");
          }
          setPhase("idle");
          return;
        }
        setError(err instanceof Error ? err.message : "Unknown error");
        setPhase("error");
      } finally {
        abortRef.current = null;
        setPhase((prev) => (prev === "streaming" ? "idle" : prev));
      }
    },
    [sessionId, phase],
  );

  return {
    sessionId,
    messages,
    statusSteps,
    streamingContent,
    phase,
    error,
    usage,
    sendMessage,
    stop,
    initSession,
  };
}
