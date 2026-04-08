import { useEffect, useRef } from "react";
import type { ChatMessage, StatusStep } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { StreamingBubble } from "./StreamingBubble";
import { ThoughtPanel } from "./ThoughtPanel";

interface Props {
  messages: ChatMessage[];
  streamingContent: string;
  statusSteps: StatusStep[];
  isStreaming: boolean;
}

export function MessageList({ messages, streamingContent, statusSteps, isStreaming }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const followLatest = () => bottomRef.current?.scrollIntoView({ behavior: "smooth" });

  useEffect(() => {
    followLatest();
  }, [messages, streamingContent, statusSteps]);

  const hasContent = messages.length > 0 || isStreaming;

  return (
    <div className="message-list" role="log" aria-label="Chat messages" aria-live="polite">
      {!hasContent && (
        <div className="message-list__empty">
          <div className="message-list__empty-icon">💬</div>
          <h2 className="message-list__empty-title">AI Financial Assistant</h2>
          <p className="message-list__empty-hint">
            Ask about stock prices, market news, or financial analysis.
          </p>
        </div>
      )}

      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} onRolloutProgress={followLatest} />
      ))}

      {isStreaming && statusSteps.length > 0 && (
        <div className="bubble-row bubble-row--assistant">
          <ThoughtPanel steps={statusSteps} />
        </div>
      )}

      <StreamingBubble content={streamingContent} />

      <div ref={bottomRef} />
    </div>
  );
}
