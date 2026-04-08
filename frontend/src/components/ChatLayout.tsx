import { useEffect, useMemo, useState } from "react";
import { useChat } from "../hooks/useChat";
import { Composer } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { MessageList } from "./MessageList";

type ThemeMode = "light" | "dark";

export function ChatLayout() {
  const {
    activeSessionId,
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
  } = useChat();
  const [theme, setTheme] = useState<ThemeMode>("light");

  const isStreaming = phase === "streaming";
  const activeTitle = useMemo(() => {
    const active = sessions.find((session) => session.session_id === activeSessionId);
    if (active?.title) {
      return active.title;
    }
    const firstUserMessage = messages.find((message) => message.role === "user");
    return firstUserMessage?.content.trim().slice(0, 48) || "New chat";
  }, [sessions, activeSessionId, messages]);

  useEffect(() => {
    const savedTheme = localStorage.getItem("aift_theme");
    if (savedTheme === "dark" || savedTheme === "light") {
      setTheme(savedTheme);
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("aift_theme", theme);
  }, [theme]);

  return (
    <div className="app-shell">
      <aside className="chat-sidebar">
        <div className="chat-sidebar__header">
          <h1 className="chat-sidebar__title">AI Financial Assistant</h1>
          <button type="button" className="chat-header__new" onClick={() => void createSession()}>
            New chat
          </button>
          <button
            type="button"
            className="chat-sidebar__theme-toggle"
            onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? "Switch to light" : "Switch to dark"}
          </button>
        </div>

        <div className="chat-sidebar__section">Recent chats</div>
        <ul className="chat-sidebar__list" aria-label="Recent chats">
          {sessions.map((session) => (
            <li key={session.session_id}>
              <button
                type="button"
                className={`chat-sidebar__item ${session.session_id === activeSessionId ? "chat-sidebar__item--active" : ""}`}
                onClick={() => void switchSession(session.session_id)}
              >
                <span className="chat-sidebar__item-title">{session.title ?? "New chat"}</span>
              </button>
            </li>
          ))}
          {sessions.length === 0 && (
            <li className="chat-sidebar__empty">Start a chat to see history</li>
          )}
        </ul>
      </aside>

      <section className="chat-layout">
        <header className="chat-header">
          <h2 className="chat-header__title">{activeTitle}</h2>
        </header>

        <ConnectionBanner error={error} onDismiss={() => {}} />

        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          statusSteps={statusSteps}
          isStreaming={isStreaming}
        />

        {usage && !isStreaming && (
          <div className="usage-bar">
            {usage.total_tokens != null && (
              <span className="usage-bar__tokens">{usage.total_tokens} tokens</span>
            )}
          </div>
        )}

        <Composer
          phase={phase}
          onSend={(text) => void sendMessage(text)}
          onStop={stop}
        />
      </section>
    </div>
  );
}
