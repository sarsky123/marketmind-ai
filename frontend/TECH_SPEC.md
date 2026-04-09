# Frontend and UI/UX — technical specification

Normative detail for React/Vite client behavior, streaming, and abort handling. Product scope: [README.md](../README.md). Streaming server contract: this document (must match [backend/TECH_SPEC.md](../backend/TECH_SPEC.md) § SSE API Contract).

---

## Component tree (target)

```text
App
└── ChatLayout
    ├── header (title + "New chat" button)
    ├── ConnectionBanner (error alert, dismissible)
    ├── MessageList
    │   ├── MessageBubble (user | assistant)
    │   ├── ThoughtPanel (collapsible, from `status` events)
    │   └── StreamingBubble (in-progress assistant with cursor)
    ├── usage-bar (token count after done)
    └── Composer (auto-grow textarea + Send/Stop)
```

- **MessageBubble:** Renders pre-wrap plain text; user right-aligned, assistant left-aligned. Future: markdown + citations.
- **ThoughtPanel:** Collapsible strip showing latest `status.message` + `tool` badge. Expands to numbered step list.
- **StreamingBubble:** Shows accumulated `token` content with a blinking cursor. Merges into a final MessageBubble on `done`.

---

## State management: `useChat` hook (design)

Centralize chat + SSE logic in a custom hook, e.g. `useChat(options)`.

**Suggested state**

- `messages: ChatMessage[]` — committed conversation (roles + content).
- `statusSteps: { message: string; tool?: string }[]` — append-only or “latest N” from `status` events for the **current** request.
- `streamingText: string` — accumulator for `token` events **before** commit to `messages` (or flush into the last assistant bubble).
- `phase: "idle" | "streaming" | "done" | "error"`.
- `error: { message: string; code?: number } | null` from terminal `error` event.
- `usage: { total_tokens?: number } | null` from `done` (optional display).

**Suggested API**

- `sendMessage(text: string)` — POST `/api/chat/stream` with body per backend contract; attach `AbortController`.
- `stop()` — abort in-flight stream; reset streaming state to idle (server may emit nothing further).
- `clearStatus()` — optional between turns.

**Persistence**

- Align with [SPEC.md](../SPEC.md): **PostgreSQL** is authoritative for sessions and messages; the client fetches via HTTP. The **`useChat`** hook owns ephemeral UI state (streaming, status steps, errors) and may keep an **in-memory** per-session message cache when switching chats in one tab. **Multi-tab:** independent React state per tab unless cross-tab sync is added.

---

## User aborts: `AbortController`

- Create **`AbortController`** per send; pass `signal` to `fetch`.
- **Stop Generating** calls `controller.abort()`.
- On abort: close reader if using `getReader()`, clear streaming flags, optionally show “Generation stopped” in UI (without requiring a server `error` event — the server may still log cancellation).
- Do not treat `AbortError` as a fatal app error; handle as user-initiated stop.

---

## SSE API Contract (client)

**Endpoint:** `POST /api/chat/stream`

Must match [backend/TECH_SPEC.md](../backend/TECH_SPEC.md). Summary:

| SSE `event` | `data` | Client action |
| --- | --- | --- |
| `status` | JSON `{"message": "...", "tool": "..."}` | Update thought-process UI / tool badge. |
| `token` | JSON **string** chunk | Append to running assistant output (`JSON.parse` → string). |
| `done` | JSON `{"stop_reason": "...", "usage": {...}}` | Mark success; persist assistant message; clear “streaming”; optional usage toast. |
| `error` | JSON `{"message": "...", "code": 500}` | Show error UI; clear streaming; **do not** treat as partial success. |

### Parsing instructions

1. **Split frames** on blank line (`\n\n` or `\r\n\r\n`). Concatenate multiple `data:` lines inside one frame if they appear (per SSE spec).
2. **Ignore** lines starting with `:` (comments) and empty heartbeat frames.
3. **Read `event:`** line if present; default event type may be `message` in some servers — this API **always** sends explicit `event:`.
4. **`status` / `done` / `error`:** parse `data` with `JSON.parse` → object; validate required keys with narrow type guards.
5. **`token`:** parse `data` with `JSON.parse`; **expect type `string`**. If parse result is not a string, treat as protocol error or skip chunk (dev-only logging).
6. **Terminal events:** after `done` or `error`, stop reading and release the `AbortController` reference for that request.

### Rendering

- **Thought process:** append or replace a rolling log from `status` (`message` + optional `tool`).
- **Typewriter:** concatenate `token` strings into the assistant bubble for the in-flight turn.
- **Done:** finalize bubble, hide spinner, optionally show `usage.total_tokens`.
- **Error:** show non-blocking alert or inline banner with `message`; use `code` only for diagnostics / support.

---

## Types (illustrative)

```typescript
type StatusPayload = { message: string; tool: string };
type DonePayload = {
  stop_reason: string;
  usage?: { total_tokens?: number; [key: string]: unknown };
};
type ErrorPayload = { message: string; code: number };

type ChatStreamEvent =
  | { event: "status"; data: StatusPayload }
  | { event: "token"; data: string }
  | { event: "done"; data: DonePayload }
  | { event: "error"; data: ErrorPayload };
```

---

## Networking notes

- Use relative URL `/api/chat/stream` behind Vite proxy in dev (`vite.config` → backend).
- **CORS:** production must allow frontend origin; local dev already whitelisted in FastAPI.
- Prefer **`fetch` + stream reader** or `EventSource` only if the API is adapted to pure GET (this API is **POST** with body — use `fetch`).

### Proxy target configuration

The Vite dev-server proxy target is driven by the `VITE_PROXY_TARGET` env var in `vite.config.ts`:

| Environment | Value | How it's set |
| --- | --- | --- |
| **Host dev** (Vite on bare metal) | `http://127.0.0.1:8000` (default) | No config needed; just run backend on port 8000 |
| **Docker Compose** | `http://backend:8000` | Set via `environment:` in `docker-compose.yml` frontend service |

This avoids the DNS failure that occurs when Vite running on the host tries to resolve the `backend` Docker hostname.

### File structure

```text
src/
├── App.tsx               — Shell: renders ChatLayout + imports global CSS
├── index.css             — Global CSS with design tokens
├── main.tsx              — React root mount
├── components/
│   ├── ChatLayout.tsx    — Full-viewport chat shell (header, messages, composer)
│   ├── Composer.tsx      — Auto-growing textarea + Send/Stop buttons
│   ├── ConnectionBanner.tsx — Non-blocking error banner
│   ├── MessageBubble.tsx — Single user or assistant bubble
│   ├── MessageList.tsx   — Scrollable list with auto-scroll
│   ├── StreamingBubble.tsx — In-progress assistant bubble with cursor blink
│   └── ThoughtPanel.tsx  — Collapsible thought-process steps from status events
├── hooks/
│   └── useChat.ts        — All session + SSE + message state (see useChat hook section above)
└── lib/
    ├── sse.ts            — SSE frame parser (shared types + parseSSEFrame)
    └── types.ts          — ChatMessage, ChatPhase, StatusStep types
```
