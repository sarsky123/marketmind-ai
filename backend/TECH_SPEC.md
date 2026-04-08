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
data: {"message": "...", "tool": "...", "stage": "...", "tool_display": "...", "agent": "..."}
```

- `message` — human-readable step description.
- `tool` — optional tool name (or empty string if none); use for `ToolStatusIndicator` UIs.
- `stage` — optional machine-readable phase (e.g. `load_history`, `thinking`, `tool_start`, `tool_done`, `tool_error`, `subagent_start`, `subagent_thinking`, `subagent_tool_start`, `subagent_tool_done`, `subagent_tool_error`).
- `tool_display` — optional human-friendly tool label (e.g. `Web Search`); clients may prefer this over raw tool ids.
- `agent` — optional delegated agent identifier for nested activity (e.g. `finance_expert`).

Both orchestrator and delegated sub-agents may emit `status` events during a single streamed response.

**`event: token`**

```text
data: "..."
```

- The value after `data:` is a **JSON-encoded string** (including escaping). Example: `data: "Hello "` then `data: "world"`.
- Client: `JSON.parse(dataLine)` → `string`, then concatenate.

**`event: done`**

```text
data: {"stop_reason": "completed", "usage": {"total_tokens": 123}, "citations": [{"index": 1, "title": "Example source", "url": "https://example.com"}]}
```

- `stop_reason` — short machine-readable reason (e.g. `completed`, `cancelled` if you distinguish client abort without `error`).
- `usage` — optional aggregate token accounting for the request; shape may grow but **must** stay JSON-serializable.
- `citations` — optional structured citation metadata for the final assistant response. Each citation object contains:
  - `index: number`
  - `title: string`
  - `url: string`

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
- **yfinance:** typically no API key; cache JSON in Redis with composite key and **TTL** from `YFINANCE_CACHE_TTL_SECONDS` (default **300s**; key shape `cache:yfinance:{TICKER}:{UTC_DATE}`).
- **Anonymous auth / cost control** (see dedicated section below): `AUTH_JWT_SECRET`, `MAX_DAILY_VISITORS`, `VISITOR_QUOTA`, `INVITE_QUOTA`, `INVITE_TTL_SECONDS` (default **604800**, one week, for Redis `invite:{token}` keys from the CLI), `RATE_LIMIT_PER_MIN`, `JWT_*`, `COOKIE_*`, `CORS_ORIGINS`, `CLIENT_IP_TRUST_PROXY`. Central loader: [`config.py`](config.py); `invite_ttl_seconds` reflects **`INVITE_TTL_SECONDS`** (CLI reads the same variable when writing Redis).

---

## Anonymous JWT authentication and API cost controls

This stack uses **invite-aware anonymous JWTs** in an **HttpOnly cookie** plus **Redis** for daily visitor caps, per-browser-session API quotas, and IP throttling. **PostgreSQL** remains the source of truth for chat rows; the JWT claim `session_id` is an **auth session id** used only for Redis keys (`quota:{session_id}`), not the `ChatSession` primary key.

### End-to-end flow

1. The SPA calls `GET /api/auth/me` with **`credentials: "include"`** (same origin via the Vite proxy).
2. If unauthenticated (`401`), the client reads `?invite=` from the URL (if present) and calls `POST /api/auth/anonymous` with `{ "invite": "<optional>" }`.
3. On success the API responds with **`Set-Cookie: session_token=...`** (`HttpOnly`, `Secure` and `SameSite` from env — use `SameSite=None` + `Secure=true` for cross-site production frontends).
4. Every protected `/api/*` request includes the cookie. **Middleware** (after CORS) enforces **IP rate limits** and **JWT + quota** before route handlers run. **One successful HTTP request consumes one quota unit** at the edge (including `POST /api/chat/stream`), so one chat turn decrements quota once even though the body streams.

### Visitor and invited users

| Mode | Condition | JWT `role` | Initial quota (Redis) |
| --- | --- | --- | --- |
| Visitor | No invite; must increment global daily key under cap | `visitor` | `VISITOR_QUOTA` |
| Invited | `invite:{code}` exists in Redis with `"status": "active"` | `invited` | `INVITE_QUOTA` |

- **Daily visitor gate:** Redis key `visitors:{YYYY-MM-DD}` (UTC). Only the **no-invite** path increments this counter when minting a token. If the cap is exceeded, `/api/auth/anonymous` returns **403** (`daily_visitor_limit`).
- **Invalid invite:** If the client sends a non-empty `invite` that is missing or not active, the API returns **400** (`invalid_invite`) — it does **not** fall back silently to the visitor path.

### Redis key taxonomy

| Key pattern | Purpose |
| --- | --- |
| `visitors:{YYYY-MM-DD}` | Count of successful anonymous visitor mints that day (UTC) |
| `invite:{token}` | JSON `{"status":"active|…","client":"…","created_at":"…"}`; **`SET` with `EX`** — TTL from **`INVITE_TTL_SECONDS`** (default **604800** = 7 days), applied by `scripts/generate_invite.py` |
| `quota:{auth_session_uuid}` | Remaining API units; `DECR` per protected request; TTL aligned with JWT lifetime |
| `rl:{client_ip}:{unix_minute}` | Fixed **1-minute** IP window; compare to `RATE_LIMIT_PER_MIN` |

### Middleware behavior

- **Public** (no JWT/quota): `/`, `/health`, `POST /api/auth/anonymous`, `GET /api/auth/me`, `/docs`, `/openapi.json`, `/redoc`.
- **`OPTIONS`:** Passed through immediately so CORS preflight is not blocked.
- **All `/api/*`:** Subject to **IP** fixed-window limiting (returns **429** with `detail: rate_limit`).
- **Protected `/api/*`:** Requires valid `session_token`; then **quota `DECR`** — if exhausted, **403** (`quota_exceeded`). **401** if cookie missing or JWT invalid.
- **Client IP:** If `CLIENT_IP_TRUST_PROXY=true`, the first hop of `X-Forwarded-For` is used (only behind a **trusted** edge proxy).

### Invite generation (CLI)

From repo root, with `REDIS_URL` set (and optional `PUBLIC_APP_ORIGIN` for the printed link). TTL is **`INVITE_TTL_SECONDS`** (default **604800** = 7 days), or override per run by exporting that variable before invoking the script.

```bash
python scripts/generate_invite.py --client "Aikido"
```

### V1 limitation (authorization vs cost)

JWT + quota **limits token/API spend**; it does **not** prove ownership of a Postgres `user_id` or `ChatSession`. Tightening would require embedding or binding `user_id` in the JWT and validating session routes against it.

---

## Module layout (target)

See Phase 2 plan: `backend/ai/` (`context`, `permissions`, `registry`, `tools`, `prompts`, `agents`, `repository`, `trace`), thin `main.py` route handlers, SQLModel in `backend/models.py`.
