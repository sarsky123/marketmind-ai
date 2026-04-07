import type { ChatMessage } from "../lib/types";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

interface Props {
  message: ChatMessage;
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

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";
  const content = message.content ?? "";

  return (
    <div className={`bubble-row ${isUser ? "bubble-row--user" : "bubble-row--assistant"}`}>
      <div className={`bubble ${isUser ? "bubble--user" : "bubble--assistant"}`}>
        {isUser ? (
          <p className="bubble__text bubble__text--plain">{content}</p>
        ) : (
          <div className="bubble__text bubble__text--markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {content}
            </ReactMarkdown>
            {!!message.citations?.length && (
              <div className="bubble__citations" aria-label="Citations">
                {message.citations.map((citation) => {
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
            )}
          </div>
        )}
      </div>
    </div>
  );
}
