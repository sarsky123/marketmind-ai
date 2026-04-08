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

const fetchApi: typeof fetch = (input, init) =>
  fetch(input, { credentials: "include", ...init });

export type AuthBootstrapPhase = "checking" | "ready" | "blocked";

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
  authPhase: AuthBootstrapPhase;
  authError: string | null;
  authRole: string | null;
  quotaRemaining: number | null;
  quotaDaily: number | null;
  usage: DonePayload["usage"] | null;
  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
  /** Open a blank draft (no server session until first prompt). */
  createSession: () => void;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<boolean>;
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
  const [authPhase, setAuthPhase] = useState<AuthBootstrapPhase>("checking");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authRole, setAuthRole] = useState<string | null>(null);
  const [quotaRemaining, setQuotaRemaining] = useState<number | null>(null);
  const [quotaDaily, setQuotaDaily] = useState<number | null>(null);
  const [usage, setUsage] = useState<DonePayload["usage"] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const refreshAuthMe = useCallback(async () => {
    try {
      const res = await fetchApi("/api/auth/me");
      if (!res.ok) {
        setAuthRole(null);
        setQuotaRemaining(null);
        setQuotaDaily(null);
        return;
      }
      const data = (await res.json()) as {
        role?: unknown;
        quota_remaining?: unknown;
        quota?: unknown;
      };
      setAuthRole(typeof data.role === "string" ? data.role : null);
      setQuotaRemaining(typeof data.quota_remaining === "number" ? data.quota_remaining : null);
      setQuotaDaily(typeof data.quota === "number" ? data.quota : null);
    } catch {
      // Best-effort: leave existing values if /me is temporarily unavailable.
    }
  }, []);

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
    const res = await fetchApi(`/api/sessions?user_id=${encodeURIComponent(uid)}`);
    if (!res.ok) {
      throw new Error(`Load sessions failed: ${res.status}`);
    }
    const list: ChatSessionSummary[] = await res.json();
    setSessions(list);
    return list;
  }, []);

  const refreshSessionOrdering = useCallback(async () => {
    if (!userId) {
      return;
    }
    try {
      await loadSessions(userId);
    } catch {
      // Keep current list if refresh fails transiently.
    }
  }, [userId, loadSessions]);

  const switchSession = useCallback(async (sessionId: string) => {
    const cached = messagesCacheRef.current.get(sessionId);
    if (cached) {
      setActiveSessionId(sessionId);
      setMessages(cached);
      setStreamingContent("");
      setStatusSteps([]);
      setUsage(null);
      setError(null);
      return;
    }
    const res = await fetchApi(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (!res.ok) {
      throw new Error(`Load messages failed: ${res.status}`);
    }
    const data: ServerChatMessage[] = await res.json();
    const hydrated = data
      .map((message) => mapServerMessage(message))
      .filter((message): message is ChatMessage => message !== null);
    setActiveSessionId(sessionId);
    setMessages(hydrated);
    messagesCacheRef.current.set(sessionId, hydrated);
    setStreamingContent("");
    setStatusSteps([]);
    setUsage(null);
    setError(null);
  }, [mapServerMessage]);

  /** Open a blank draft: no `POST /api/sessions` until the user sends a message. */
  const createSession = useCallback(() => {
    stop();
    setActiveSessionId(null);
    setMessages([]);
    setStreamingContent("");
    setStatusSteps([]);
    setUsage(null);
    setError(null);
  }, [stop]);

  useEffect(() => {
    let cancelled = false;
    const bootstrapAuth = async () => {
      setAuthError(null);
      const me = await fetchApi("/api/auth/me");
      if (cancelled) {
        return;
      }
      if (me.ok) {
        setAuthPhase("ready");
        await refreshAuthMe();
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const inviteRaw = params.get("invite");
      const invite = inviteRaw && inviteRaw.trim() !== "" ? inviteRaw.trim() : null;
      const anon = await fetchApi("/api/auth/anonymous", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite }),
      });
      if (cancelled) {
        return;
      }
      if (!anon.ok) {
        if (anon.status === 403) {
          setAuthError(
            "Daily visitor limit reached. Try again tomorrow or open an invite link.",
          );
        } else if (anon.status === 400) {
          setAuthError("Invalid or expired invite code.");
        } else if (anon.status === 429) {
          setAuthError("Too many requests. Please slow down.");
        } else {
          setAuthError("Could not start a session. Please refresh the page.");
        }
        setAuthPhase("blocked");
        return;
      }
      params.delete("invite");
      const search = params.toString();
      const nextUrl = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
      window.history.replaceState({}, "", nextUrl);
      setAuthPhase("ready");
      await refreshAuthMe();
    };
    void bootstrapAuth();
    return () => {
      cancelled = true;
    };
  }, [refreshAuthMe]);

  useEffect(() => {
    if (authPhase !== "ready") {
      return;
    }
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
        setActiveSessionId(null);
        setMessages([]);
      } catch {
        setActiveSessionId(null);
        setMessages([]);
      }
    };
    void init();
  }, [authPhase, loadSessions, switchSession]);

  const deleteSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!userId) {
        setError("Cannot delete chat: missing user.");
        return false;
      }
      const wasActive = activeSessionId === sessionId;
      if (wasActive) {
        stop();
      }
      try {
        const res = await fetchApi(
          `/api/sessions/${encodeURIComponent(sessionId)}?user_id=${encodeURIComponent(userId)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          setError(`Delete chat failed: ${res.status}`);
          return false;
        }
        const remaining = sessions.filter((s) => s.session_id !== sessionId);
        setSessions(remaining);
        messagesCacheRef.current.delete(sessionId);
        if (wasActive) {
          setMessages([]);
          setStreamingContent("");
          setStatusSteps([]);
          setUsage(null);
          setError(null);
          if (remaining.length > 0) {
            await switchSession(remaining[0].session_id);
          } else {
            setActiveSessionId(null);
            setMessages([]);
          }
        }
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete chat");
        return false;
      }
    },
    [userId, activeSessionId, stop, sessions, switchSession],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (phase === "streaming") return;

      const userMsg: ChatMessage = { id: nextId(), role: "user", content: text };
      let streamSid = activeSessionId;

      setMessages((prev) => {
        const next = [...prev, userMsg];
        if (streamSid) {
          messagesCacheRef.current.set(streamSid, next);
        }
        return next;
      });

      if (!streamSid) {
        try {
          const res = await fetchApi("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "New chat", user_id: userId }),
          });
          if (!res.ok) {
            setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
            setError(`Session create failed: ${res.status}`);
            setPhase("idle");
            return;
          }
          const data = (await res.json()) as { session_id: string; user_id?: string };
          streamSid = data.session_id;
          const nextUserId = data.user_id ?? userId;
          if (nextUserId) {
            setUserId(nextUserId);
            localStorage.setItem("aift_user_id", nextUserId);
            await loadSessions(nextUserId);
          }
          setActiveSessionId(streamSid);
          setMessages((prev) => {
            messagesCacheRef.current.set(streamSid, prev);
            return prev;
          });
        } catch (err) {
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          setError(err instanceof Error ? err.message : "Failed to create session");
          setPhase("idle");
          return;
        }
      }

      setStatusSteps([]);
      setStreamingContent("");
      setError(null);
      setUsage(null);
      setPhase("streaming");

      const controller = new AbortController();
      abortRef.current = controller;

      let accumulated = "";

      try {
        const res = await fetchApi("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: streamSid, message: text }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          if (res.status === 403) {
            setError("Quota exceeded. Please request an invite code.");
          } else if (res.status === 429) {
            setError("Too many requests. Please slow down.");
          } else {
            setError(`Stream failed: ${res.status}`);
          }
          setPhase("error");
          return;
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
              const sid = streamSid;
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
              const assistantMsg: ChatMessage = {
                id: nextId(),
                role: "assistant",
                content: finalContent,
                citations: ev.data.citations,
                animateOnMount: true,
              };
              setMessages((prev) => [
                ...prev,
                assistantMsg,
              ]);
              messagesCacheRef.current.set(streamSid, [
                ...(messagesCacheRef.current.get(streamSid) ?? []),
                assistantMsg,
              ]);
              setStreamingContent("");
              setUsage(ev.data.usage ?? null);
              setPhase("idle");
              await refreshAuthMe();
              await refreshSessionOrdering();
            } else if (ev.event === "error") {
              setError(`${ev.data.message} (${ev.data.code})`);
              if (accumulated) {
                const partialMsg: ChatMessage = {
                  id: nextId(),
                  role: "assistant",
                  content: accumulated,
                  animateOnMount: true,
                };
                setMessages((prev) => [
                  ...prev,
                  partialMsg,
                ]);
                messagesCacheRef.current.set(streamSid, [
                  ...(messagesCacheRef.current.get(streamSid) ?? []),
                  partialMsg,
                ]);
                setStreamingContent("");
              }
              setPhase("error");
              await refreshAuthMe();
              await refreshSessionOrdering();
            }
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setStreamingContent("");
          setStatusSteps([]);
          const partialMsg: ChatMessage = {
            id: nextId(),
            role: "assistant",
            content: accumulated,
            generationStopped: true,
            animateOnMount: accumulated.length > 0,
          };
          setMessages((prev) => [...prev, partialMsg]);
          messagesCacheRef.current.set(streamSid, [
            ...(messagesCacheRef.current.get(streamSid) ?? []),
            partialMsg,
          ]);
          setPhase("idle");
          await refreshSessionOrdering();
          return;
        }
        setError(err instanceof Error ? err.message : "Unknown error");
        setPhase("error");
        await refreshAuthMe();
        await refreshSessionOrdering();
      } finally {
        abortRef.current = null;
        setPhase((prev) => (prev === "streaming" ? "idle" : prev));
      }
    },
    [activeSessionId, userId, phase, refreshAuthMe, loadSessions, refreshSessionOrdering],
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
    authPhase,
    authError,
    authRole,
    quotaRemaining,
    quotaDaily,
    usage,
    sendMessage,
    stop,
    createSession,
    switchSession,
    deleteSession,
  };
}
