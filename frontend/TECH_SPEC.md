# Frontend and UI/UX — technical specification

Normative detail for React/Vite client behavior, streaming, and abort handling. Product scope: [README.md](../README.md). Streaming server contract: this document (must match [backend/TECH_SPEC.md](../backend/TECH_SPEC.md) § SSE API Contract).

---

## Component tree (target)

Current scaffold is a single `App` page; evolve toward:

```text
App
├── Layout / Shell
├── HealthPanel (optional dev)
└── ChatWorkspace
    ├── SessionSidebar (future: multi-session)
    ├── ChatWindow
    │   ├── MessageList
    │   │   └── MessageBubble (user | assistant | system)
    │   ├── ThoughtProcess / ToolStatusIndicator (from `status` events)
    │   └── StreamingIndicator (active when SSE open)
    └── ChatComposer
        ├── Text input
        ├── Send button
        └── StopGenerating (wired to AbortController)
```

- **MessageBubble:** Renders markdown or plain text for assistant; shows citations per product rules.
- **ToolStatusIndicator:** Shows latest `status.message` and optional `status.tool` badge (or short list of recent steps).

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

**Persistence (assignment / UX)**

- Align with [DEVELOPMENT_SPEC.md](../DEVELOPMENT_SPEC.md): **Zustand + persist** for multi-tab session and history in `localStorage` when that milestone lands; `useChat` can be the consumer of that store or wrap it.

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
