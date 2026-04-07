# Backend and AI engine — technical specification

Normative detail for the FastAPI service, persistence, and the multi-agent engine. Product-level scope and trade-offs: [README.md](../README.md).

---

## Database schema (SQLModel + PostgreSQL)

Tables use Alembic migrations; models live in `backend/models.py` (or equivalent package layout).

### `User`

- `id: UUID` (PK, default factory)
- `email: str | None`
- `created_at` (timezone-aware UTC)

### `ChatSession`

- `id: UUID` (PK)
- `user_id: UUID` (FK → `users.id`)
- `title: str` (optional / nullable per product rules)
- `created_at`

### `ChatMessage`

- `id: UUID` (PK)
- `session_id: UUID` (FK → `chat_sessions.id`, **indexed**)
- `role: str` — one of `system`, `user`, `assistant`, `tool`
- `content: str | None` (text)
- `tool_calls: JSON | None` — native JSON column storing OpenAI-shaped tool call list when `role == assistant` and the model emitted tools
- `tool_call_id: str | None` — for `role == tool` rows
- `created_at`

**Rules**

- Load orchestrator context from these rows only (not from Redis).
- Finance expert **mini-thread** is **not** persisted as `ChatMessage` by default (see Multi-agent section).

---

## Multi-agent engine design

### Roles

| Role | Responsibility |
| --- | --- |
| **Orchestrator** | Intent, routing, user-facing reply. Tool surface: e.g. web search, clarify intent, **ConsultFinanceAgent**, etc. Uses **windowed** session history from Postgres. |
| **Finance expert** | Invoked **only** when the orchestrator calls `ConsultFinanceAgent`. Tool surface: subset (e.g. web search + market data). **Tight context isolation** (below). |

### Tight context isolation (finance expert)

The finance expert **must not** receive full `ChatMessage` history from the session.

- OpenAI `messages` for the expert = **`[system, user]`** only:
  - `system`: finance expert system prompt.
  - `user`: body built from `ConsultFinanceAgent`’s **`specific_task`** (verbatim or lightly formatted). Optional: a **single** short disambiguation line in the same `user` blob — **not** the orchestrator transcript.
- Tool rounds inside the expert append assistant/tool messages **only inside this in-memory mini-thread**.
- Return value: **final assistant text string** only, embedded in the orchestrator’s tool result.

### Config (representative)

- `max_orchestrator_rounds` — cap orchestrator tool iterations per user turn; on exceed → emit SSE **`error`**.
- `max_finance_rounds` — cap expert inner loop.
- `max_context_messages` — applies to **orchestrator** history loading only.

---

## Pipeline stages and tool registry

### Named stages (for logs, trace, and `status` copy)

1. `load_history` — read messages for `session_id` from Postgres.
2. `persist_user` — write user message row.
3. `model_turn` — OpenAI completion (or stream chunks) for orchestrator.
4. `execute_tools` — dispatch tool calls via registry (allowlist only).
5. `persist` — write assistant / tool rows.
6. `stream_final` — stream answer tokens to client.

### Tool registry pattern

- Registry maps OpenAI `function.name` → JSON schema fragment + **async** runner.
- **Allowlist dispatch:** unknown tool names are rejected or turned into structured tool errors the model can see.
- **`ToolPermissionContext`** (or equivalent) **filters** which registry entries each agent receives (orchestrator vs finance expert).
- Structured result type (e.g. `ToolRunResult`) for consistent error handling and citation metadata.

### Delegation

- `ConsultFinanceAgent` is **not** executed as a generic registry call like Tavily; it **`await`s** `run_finance_expert(...)` and injects the string result as a tool message on the **orchestrator** thread.

---

## Graceful cancellation

- The ASGI stream must handle client disconnect and **`asyncio.CancelledError`** when the client aborts (e.g. **AbortController** on the browser).
- On cancel: stop yielding SSE, stop scheduling further OpenAI/tool work where possible, and exit the generator without leaking tasks.

---

## SSE API Contract

**Endpoint:** `POST /api/chat/stream`

All frames use standard SSE: optional `event:` line, one or more `data:` lines, blank line to terminate the frame. Clients should buffer until a full frame; ignore comment lines (`:` prefix) if present.

| SSE `event` | `data` body | Semantics |
| --- | --- | --- |
| `status` | JSON object | Thought process / tool execution UI. |
| `token` | **JSON string** (quoted chunk) | Append to assistant message for typewriter effect. |
| `done` | JSON object | **Terminal** success. |
| `error` | JSON object | **Terminal** failure (validation, provider error, **loop cap exceeded**, etc.). |

### Exact payload shapes (normative)

**`event: status`**

```text
data: {"message": "...", "tool": "..."}
```

- `message` — human-readable step description.
- `tool` — optional tool name (or empty string if none); use for `ToolStatusIndicator` UIs.

**`event: token`**

```text
data: "..."
```

- The value after `data:` is a **JSON-encoded string** (including escaping). Example: `data: "Hello "` then `data: "world"`.
- Client: `JSON.parse(dataLine)` → `string`, then concatenate.

**`event: done`**

```text
data: {"stop_reason": "completed", "usage": {"total_tokens": 123}}
```

- `stop_reason` — short machine-readable reason (e.g. `completed`, `cancelled` if you distinguish client abort without `error`).
- `usage` — optional aggregate token accounting for the request; shape may grow but **must** stay JSON-serializable.

**`event: error`**

```text
data: {"message": "...", "code": 500}
```

- `message` — **safe for end users** (no stack traces).
- `code` — numeric hint (HTTP-style or app-specific); use for support / logging correlation on the client if needed.

**Ordering**

- Many `status` and `token` events may precede exactly one terminal event: **`done`** or **`error`** (not both).
- After `done` or `error`, the server should close the stream.

---

## Environment and integrations

- **Postgres:** `DATABASE_URL` (async driver URL where applicable, e.g. `postgresql+asyncpg://...`).
- **Redis:** `REDIS_URL`; **`redis.asyncio`** for non-blocking I/O.
- **OpenAI:** `OPENAI_API_KEY`; async client in agent loop.
- **Tavily:** `TAVILY_API_KEY` for search tool.
- **yfinance:** typically no API key; cache JSON in Redis with composite key and **TTL ~300s** (e.g. `cache:yfinance:{TICKER}:{UTC_DATE}`).

---

## Module layout (target)

See Phase 2 plan: `backend/ai/` (`context`, `permissions`, `registry`, `tools`, `prompts`, `agents`, `repository`, `trace`), thin `main.py` route handlers, SQLModel in `backend/models.py`.
