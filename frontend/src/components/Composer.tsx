import { useCallback, useRef, useState } from "react";
import type { ChatPhase } from "../lib/types";

interface Props {
  phase: ChatPhase;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ phase, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = phase === "streaming";

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, isStreaming, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        className="composer__input"
        placeholder="Ask about finance, markets, or news..."
        value={text}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        rows={1}
        aria-label="Message input"
        disabled={isStreaming}
      />
      {isStreaming ? (
        <button type="button" className="composer__btn composer__btn--stop" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button
          type="button"
          className="composer__btn composer__btn--send"
          onClick={handleSubmit}
          disabled={!text.trim()}
        >
          Send
        </button>
      )}
    </div>
  );
}
