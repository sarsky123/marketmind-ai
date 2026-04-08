import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
  } = useChat();
  const authReady = authPhase === "ready";
  const bannerText = authError ?? error;
  const quotaLine = useMemo(() => {
    if (!authReady) return null;
    const roleLabel = authRole === "invited" ? "Invited" : "Visitor";
    if (quotaRemaining == null || quotaDaily == null) {
      return `${roleLabel}`;
    }
    return `${roleLabel} • ${quotaRemaining} / ${quotaDaily} left today`;
  }, [authReady, authRole, quotaRemaining, quotaDaily]);
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [menuOpenSessionId, setMenuOpenSessionId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const [recentChatsExpanded, setRecentChatsExpanded] = useState(false);

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

  useEffect(() => {
    if (!menuOpenSessionId) {
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || !(target instanceof Element)) {
        return;
      }
      const inside = target.closest(`[data-chat-session-menu="${menuOpenSessionId}"]`);
      if (!inside) {
        setMenuOpenSessionId(null);
        setMenuAnchor(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpenSessionId(null);
        setMenuAnchor(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpenSessionId]);

  const confirmDeleteSession = async (sessionId: string) => {
    if (!window.confirm("Delete this chat? This cannot be undone.")) {
      return;
    }
    const ok = await deleteSession(sessionId);
    if (ok) {
      setMenuOpenSessionId((ex) => (ex === sessionId ? null : ex));
    }
  };

  const menuPortal = useMemo(() => {
    if (!menuOpenSessionId || !menuAnchor) return null;
    const sessionId = menuOpenSessionId;
    const top = Math.round(menuAnchor.bottom + 6);
    const right = Math.round(window.innerWidth - menuAnchor.right);
    return createPortal(
      <ul
        className="chat-sidebar__dropdown chat-sidebar__dropdown--portal"
        role="menu"
        aria-label="Chat actions"
        style={{ top, right }}
      >
        <li className="chat-sidebar__dropdown-item-wrap" role="none">
          <button
            type="button"
            className="chat-sidebar__dropdown-item chat-sidebar__dropdown-item--danger"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpenSessionId(null);
              setMenuAnchor(null);
              void confirmDeleteSession(sessionId);
            }}
          >
            <svg
              className="chat-sidebar__dropdown-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              <line x1="10" x2="10" y1="11" y2="17" />
              <line x1="14" x2="14" y1="11" y2="17" />
            </svg>
            <span>Delete chat</span>
          </button>
        </li>
      </ul>,
      document.body,
    );
  }, [menuOpenSessionId, menuAnchor, confirmDeleteSession]);

  return (
    <div className="app-shell">
      <aside className="chat-sidebar">
        <div className="chat-sidebar__header">
          <h1 className="chat-sidebar__title">AI Financial Assistant</h1>
          <button
            type="button"
            className="chat-header__new"
            disabled={!authReady}
            onClick={() => void createSession()}
          >
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

        <div className="chat-sidebar__section-row">
          <div className="chat-sidebar__section">Recent chats</div>
          <button
            type="button"
            className="chat-sidebar__section-toggle"
            aria-expanded={recentChatsExpanded}
            aria-controls="recent-chats-list"
            onClick={() => setRecentChatsExpanded((prev) => !prev)}
          >
            {recentChatsExpanded ? "Hide" : "Show"}
          </button>
        </div>
        <ul
          id="recent-chats-list"
          className={`chat-sidebar__list ${recentChatsExpanded ? "chat-sidebar__list--expanded" : "chat-sidebar__list--collapsed"}`}
          aria-label="Recent chats"
        >
          {sessions.map((session) => {
            const isMenuOpen = menuOpenSessionId === session.session_id;
            return (
              <li
                key={session.session_id}
                className={`chat-sidebar__row ${isMenuOpen ? "chat-sidebar__row--menu-open" : ""}`}
              >
                <div
                  className={`chat-sidebar__item-row ${session.session_id === activeSessionId ? "chat-sidebar__item-row--active" : ""}`}
                >
                  <button
                    type="button"
                    className="chat-sidebar__item"
                    onClick={() => void switchSession(session.session_id)}
                  >
                    <span className="chat-sidebar__item-title">{session.title ?? "New chat"}</span>
                  </button>
                  <div
                    className="chat-sidebar__menu-wrap"
                    data-chat-session-menu={session.session_id}
                  >
                    <button
                      type="button"
                      className={`chat-sidebar__item-kebab ${isMenuOpen ? "chat-sidebar__item-kebab--open" : ""}`}
                      aria-haspopup="menu"
                      aria-expanded={isMenuOpen}
                      aria-label={isMenuOpen ? "Close chat menu" : "Open chat menu"}
                      onClick={(e) => {
                        e.stopPropagation();
                        const nextId = session.session_id;
                        setMenuOpenSessionId((id) => {
                          const next = id === nextId ? null : nextId;
                          if (next) {
                            const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                            setMenuAnchor(rect);
                          } else {
                            setMenuAnchor(null);
                          }
                          return next;
                        });
                      }}
                    >
                      <span className="chat-sidebar__item-kebab-icon" aria-hidden>
                        ⋮
                      </span>
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
          {sessions.length === 0 && (
            <li className="chat-sidebar__empty">Start a chat to see history</li>
          )}
        </ul>
      </aside>
      {menuPortal}

      <section className="chat-layout">
        <header className="chat-header">
          <h2 className="chat-header__title">{activeTitle}</h2>
        </header>

        {authPhase === "checking" ? (
          <div className="chat-auth-banner" role="status" aria-live="polite">
            Signing you in…
          </div>
        ) : null}

        {quotaLine ? (
          <div className="chat-quota-banner" role="status" aria-live="polite">
            {quotaLine}
          </div>
        ) : null}

        <ConnectionBanner error={bannerText} onDismiss={() => {}} />

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
          disabled={!authReady}
          onSend={(text) => void sendMessage(text)}
          onStop={stop}
        />
      </section>
    </div>
  );
}
