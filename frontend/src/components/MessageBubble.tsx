import { useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../lib/types";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

interface Props {
  message: ChatMessage;
  onRolloutProgress?: () => void;
}

function sanitizeLinkHref(href?: string): string | undefined {
  if (!href) {
    return undefined;
  }

  try {
    const parsed = new URL(href, "https://local.invalid");
    const allowedProtocols = new Set(["http:", "https:", "mailto:"]);

    if (allowedProtocols.has(parsed.protocol)) {
      return href;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

const markdownComponents: Components = {
  a: ({ href, children }) => {
    const safeHref = sanitizeLinkHref(href);

    if (!safeHref) {
      return <span>{children}</span>;
    }

    return (
      <a href={safeHref} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  code: ({ inline, className, children }) => {
    const languageMatch = /language-(\w+)/.exec(className ?? "");
    const language = languageMatch?.[1];
    const codeText = String(children).replace(/\n$/, "");

    if (!inline && language) {
      return (
        <SyntaxHighlighter language={language} style={oneDark} PreTag="div">
          {codeText}
        </SyntaxHighlighter>
      );
    }

    return <code className={className}>{children}</code>;
  }
};

export function MessageBubble({ message, onRolloutProgress }: Props) {
  const isUser = message.role === "user";
  const content = message.content ?? "";
  const shouldRollout = !isUser && !!message.animateOnMount;
  const [revealLength, setRevealLength] = useState(
    shouldRollout ? 0 : content.length,
  );
  const [showAllCitations, setShowAllCitations] = useState(false);
  const displayedContent = useMemo(
    () => (shouldRollout ? content.slice(0, revealLength) : content),
    [content, revealLength, shouldRollout],
  );
  const rolloutComplete = revealLength >= content.length;

  useEffect(() => {
    if (!shouldRollout || rolloutComplete) {
      return;
    }
    onRolloutProgress?.();
  }, [revealLength, rolloutComplete, shouldRollout, onRolloutProgress]);

  useEffect(() => {
    if (!shouldRollout) {
      setRevealLength(content.length);
      return;
    }

    setRevealLength(0);
    const step = Math.max(1, Math.ceil(content.length / 180));
    const timer = window.setInterval(() => {
      setRevealLength((prev) => {
        const next = prev + step;
        return next >= content.length ? content.length : next;
      });
    }, 22);

    return () => window.clearInterval(timer);
  }, [content, shouldRollout]);

  const citationThreshold = 5;
  const safeCitations =
    message.citations?.filter((citation) => sanitizeLinkHref(citation.url) !== undefined) ?? [];
  const hasHiddenCitations = safeCitations.length > citationThreshold;
  const displayedCitations =
    hasHiddenCitations && !showAllCitations ? safeCitations.slice(0, citationThreshold) : safeCitations;

  const hasAssistantBody =
    content.trim().length > 0 || (!!safeCitations.length && rolloutComplete);

  return (
    <div className={`bubble-row ${isUser ? "bubble-row--user" : "bubble-row--assistant"}`}>
      <div
        className={`bubble ${
          isUser
            ? "bubble--user"
            : `bubble--assistant ${message.animateOnMount ? "bubble--assistant-animate" : ""}`
        }`}
      >
        {isUser ? (
          <p className="bubble__text bubble__text--plain">{content}</p>
        ) : (
          <div className="bubble__text bubble__text--markdown">
            {displayedContent.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {displayedContent}
              </ReactMarkdown>
            ) : null}
            {!!safeCitations.length && rolloutComplete && (
              <div className="bubble__citations-wrap">
                <div className="bubble__citations" aria-label="Citations">
                  {displayedCitations.map((citation) => {
                    const safeHref = sanitizeLinkHref(citation.url);
                    if (!safeHref) {
                      return null;
                    }
                    return (
                      <a
                        key={`${citation.index}-${citation.url}`}
                        className="bubble__citation-chip"
                        href={safeHref}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={citation.title}
                      >
                        [{citation.index}] {citation.title}
                      </a>
                    );
                  })}
                </div>
                {hasHiddenCitations && (
                  <button
                    type="button"
                    className="bubble__citations-toggle"
                    onClick={() => setShowAllCitations((v) => !v)}
                    aria-expanded={showAllCitations}
                  >
                    {showAllCitations
                      ? "Show fewer sources"
                      : `Show ${safeCitations.length - citationThreshold} more sources`}
                  </button>
                )}
              </div>
            )}
            {message.generationStopped && rolloutComplete && (
              <div
                className={
                  hasAssistantBody
                    ? "bubble__stopped-note"
                    : "bubble__stopped-note bubble__stopped-note--standalone"
                }
                role="status"
              >
                {content.trim()
                  ? "You stopped generation."
                  : "You stopped generation before the assistant produced a reply."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
