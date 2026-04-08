import { useCallback, useRef, useState } from "react";
import type { ChatPhase } from "../lib/types";

interface Props {
  phase: ChatPhase;
  onSend: (text: string) => void;
  onStop: () => void;
  /** When true (e.g. auth not ready), input and send are blocked. */
  disabled?: boolean;
}

export function Composer({ phase, onSend, onStop, disabled = false }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = phase === "streaming";
  const locked = disabled || isStreaming;

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || locked) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, locked, onSend]);

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
        placeholder={
          disabled ? "Signing in…" : "Ask about finance, markets, or news..."
        }
        value={text}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        rows={1}
        aria-label="Message input"
        disabled={locked}
      />
      {isStreaming ? (
        <button
          type="button"
          className="composer__btn composer__btn--stop"
          onClick={onStop}
          aria-label="Stop generating the assistant response"
        >
          Stop generating
        </button>
      ) : (
        <button
          type="button"
          className="composer__btn composer__btn--send"
          onClick={handleSubmit}
          disabled={!text.trim() || disabled}
        >
          Send
        </button>
      )}
    </div>
  );
}
