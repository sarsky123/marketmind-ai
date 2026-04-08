import { useCallback, useEffect, useRef, useState } from "react";
import { parseSSEFrame } from "../lib/sse";
import { normalizeStatusStep } from "../lib/statusFormat";
import type { DonePayload } from "../lib/sse";
import type {
  ChatMessage,
  ChatPhase,
  ChatSessionSummary,
  ServerChatMessage,
  StatusStep,
} from "../lib/types";

let msgCounter = 0;
function nextId(): string {
  msgCounter += 1;
  return `msg-${msgCounter}-${Date.now()}`;
}

interface UseChatReturn {
  activeSessionId: string | null;
  userId: string | null;
  sessions: ChatSessionSummary[];
  messages: ChatMessage[];
  statusSteps: StatusStep[];
  streamingContent: string;
  phase: ChatPhase;
  error: string | null;
  usage: DonePayload["usage"] | null;
  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
  createSession: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
}

export function useChat(): UseChatReturn {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusSteps, setStatusSteps] = useState<StatusStep[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<DonePayload["usage"] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const mapServerMessage = useCallback((message: ServerChatMessage): ChatMessage | null => {
    if (message.role !== "user" && message.role !== "assistant") {
      return null;
    }
    const content = (message.content ?? "").trim();
    if (!content) {
      return null;
    }
    return {
      id: message.id,
      role: message.role,
      content,
      citations: message.citations,
      animateOnMount: false,
    };
  }, []);

  const loadSessions = useCallback(async (uid: string) => {
    const res = await fetch(`/api/sessions?user_id=${encodeURIComponent(uid)}`);
    if (!res.ok) {
      throw new Error(`Load sessions failed: ${res.status}`);
    }
    const list: ChatSessionSummary[] = await res.json();
    setSessions(list);
    return list;
  }, []);

  const switchSession = useCallback(async (sessionId: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (!res.ok) {
      throw new Error(`Load messages failed: ${res.status}`);
    }
    const data: ServerChatMessage[] = await res.json();
    const hydrated = data
      .map((message) => mapServerMessage(message))
      .filter((message): message is ChatMessage => message !== null);
    setActiveSessionId(sessionId);
    setMessages(hydrated);
    setStreamingContent("");
    setStatusSteps([]);
    setUsage(null);
    setError(null);
  }, [mapServerMessage]);

  const createSession = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New chat", user_id: userId }),
      });
      if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
      const data: { session_id: string } = await res.json();
      const nextUserId = (data as { user_id?: string }).user_id ?? userId;
      if (nextUserId) {
        setUserId(nextUserId);
        localStorage.setItem("aift_user_id", nextUserId);
      }
      setActiveSessionId(data.session_id);
      setMessages([]);
      setStreamingContent("");
      setStatusSteps([]);
      setUsage(null);
      setError(null);
      if (nextUserId) {
        await loadSessions(nextUserId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    }
  }, [userId, loadSessions]);

  useEffect(() => {
    const init = async () => {
      try {
        const persistedUserId = localStorage.getItem("aift_user_id");
        if (persistedUserId) {
          setUserId(persistedUserId);
          const list = await loadSessions(persistedUserId);
          if (list.length > 0) {
            await switchSession(list[0].session_id);
            return;
          }
        }
        await createSession();
      } catch {
        await createSession();
      }
    };
    void init();
  }, [createSession, loadSessions, switchSession]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!activeSessionId || phase === "streaming") return;

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
          body: JSON.stringify({ session_id: activeSessionId, message: text }),
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
                normalizeStatusStep(ev.data),
              ]);
            } else if (ev.event === "session_title") {
              const sid = activeSessionId;
              const t = ev.data.title.trim();
              if (sid && t) {
                setSessions((prev) =>
                  prev.map((s) => (s.session_id === sid ? { ...s, title: t } : s)),
                );
              }
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
                  animateOnMount: true,
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
                  {
                    id: nextId(),
                    role: "assistant",
                    content: accumulated,
                    animateOnMount: true,
                  },
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
              {
                id: nextId(),
                role: "assistant",
                content: accumulated,
                animateOnMount: true,
              },
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
    [activeSessionId, phase],
  );

  return {
    activeSessionId,
    userId,
    sessions,
    messages,
    statusSteps,
    streamingContent,
    phase,
    error,
    usage,
    sendMessage,
    stop,
    createSession,
    switchSession,
  };
}
