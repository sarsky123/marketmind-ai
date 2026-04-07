import { useChat } from "../hooks/useChat";
import { Composer } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { MessageList } from "./MessageList";

export function ChatLayout() {
  const {
    messages,
    statusSteps,
    streamingContent,
    phase,
    error,
    usage,
    sendMessage,
    stop,
    initSession,
  } = useChat();

  const isStreaming = phase === "streaming";

  return (
    <div className="chat-layout">
      <header className="chat-header">
        <h1 className="chat-header__title">AI Financial Assistant</h1>
        <button type="button" className="chat-header__new" onClick={() => void initSession()}>
          New chat
        </button>
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
    </div>
  );
}
