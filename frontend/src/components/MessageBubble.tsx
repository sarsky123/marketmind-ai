import type { ChatMessage } from "../lib/types";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

interface Props {
  message: ChatMessage;
}

function withClickableCitationLinks(markdown: string): string {
  const citationUrlByIndex = new Map<string, string>();
  const lines = markdown.split("\n");

  for (const line of lines) {
    const bracketMatch = line.match(/^\s*\[(\d+)\]\s*[:\-]\s*(https?:\/\/\S+)/i);
    if (bracketMatch) {
      citationUrlByIndex.set(bracketMatch[1], bracketMatch[2]);
      continue;
    }

    const numberedMatch = line.match(/^\s*(\d+)\.\s*(https?:\/\/\S+)/i);
    if (numberedMatch) {
      citationUrlByIndex.set(numberedMatch[1], numberedMatch[2]);
    }
  }

  if (citationUrlByIndex.size === 0) {
    return markdown;
  }

  return markdown.replace(/\[(\d+)\](?!\()/g, (fullMatch, idx: string) => {
    const url = citationUrlByIndex.get(idx);
    if (!url) {
      return fullMatch;
    }
    return `[${idx}](${url})`;
  });
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
  const markdownContent = withClickableCitationLinks(content);

  return (
    <div className={`bubble-row ${isUser ? "bubble-row--user" : "bubble-row--assistant"}`}>
      <div className={`bubble ${isUser ? "bubble--user" : "bubble--assistant"}`}>
        {isUser ? (
          <p className="bubble__text bubble__text--plain">{content}</p>
        ) : (
          <div className="bubble__text bubble__text--markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {markdownContent}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
