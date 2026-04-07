# Development Spec: Multi-Agent Search Chatbot

**Documentation map (three-tier, avoid context bloat):**

- **Product spec, scope, and architecture decisions:** [README.md](README.md)
- **Backend and AI engine (schema, agents, normative SSE):** [backend/TECH_SPEC.md](backend/TECH_SPEC.md)
- **Frontend and UI/UX (components, `useChat`, SSE parsing):** [frontend/TECH_SPEC.md](frontend/TECH_SPEC.md)

This file remains the **assignment baseline**: stack, storage rules, multi-agent intent, UX requirements, and README section checklist for grading. If the README SSE summary and §9 below ever disagree with `backend/TECH_SPEC.md`, **the TECH_SPEC wins** for wire-format details.

---

## 1. System Overview

This project is a web-search-enabled AI chatbot built on a decoupled architecture. The system utilizes a multi-agent approach to accurately determine user intent, executing web searches only when necessary. The final response must be delivered via text streaming with inline source citations. The project emphasizes **robust system design**, **enterprise-grade deployment strategies**, and **exceptional UI/UX**.

## 2. Tech Stack and Frameworks

- **Frontend:** React + TypeScript (**Vite**).
- **Backend:** Python 3.10+ (**FastAPI** for native async and SSE).
- **ORM and migrations:** **SQLModel** + **Alembic** (PostgreSQL schema management).
- **Cache and request protection:** **Redis** via **`redis.asyncio`**; **`fastapi-limiter`** (Redis-backed) for API limits (see **§4**).
- **Data validation and contracts:** **Pydantic** / **SQLModel** (API schemas, agent tool calling, and DB models where applicable).
- **Agent framework:** **LangGraph** or **OpenAI Function Calling** + Asyncio state machine.
- **Version control:** Git — **strict adherence to [Conventional Commits](https://www.conventionalcommits.org/)**.

## 3. Storage and Deployment Strategy (Hybrid Cloud)

Behavior must be driven **entirely by environment variables** (`.env`) so the same codebase runs in two modes.

### Local development (Dockerized)

- Provide a **root-level `docker-compose.yml`** that starts **frontend**, **backend**, **postgres**, and **redis**.
- Example local DB URL shape: `postgresql://user:pass@localhost:5432/localdb` (actual credentials via `.env`).

### Production (serverless-oriented)

- **Frontend:** Vercel or Netlify.
- **Backend:** Render or Railway as a web service.
- **Data:** Connect to **serverless Postgres** (e.g., **Neon**) and **serverless Redis** (e.g., **Upstash**).

### Migrations

- Use **Alembic** to manage and apply schema migrations for **both** local and remote databases (`alembic upgrade head`).

## 4. Database and Cache Implementation Strategy (PostgreSQL + Redis)

Persistent storage and performance layers are **strictly separated**. Generated code must follow these responsibilities and tools.

### A. PostgreSQL (persistence and source of truth)

- **Role:** Primary storage for **chat history**, **user sessions**, and durable state.
- **Do not** store chat message history in Redis. Relying on cache for conversation logs risks LLM context **amnesia** when keys expire or are evicted.
- **ORM and migrations:** **SQLModel** for schema definition (Pydantic-friendly models) and **Alembic** for migrations.
- **Core schemas (minimum):**
  - **`ChatSession`:** Session metadata (`id`, `created_at`, `user_id` or `session_token`, and other fields as needed).
  - **`ChatMessage`:** Messages (`id`, `session_id`, `role`, `content`, `created_at`).
- **Context assembly:** Before invoking agents, the backend must **load the conversation from Postgres** and build the **full context window** (plus the new user turn) passed into the pipeline.

### B. Redis (performance, caching, and protection)

- **Role:** **Ephemeral** use only — API result caching, rate limiting, and request deduplication. Not for durable chat logs.
- **Client:** **`redis.asyncio`** for **non-blocking** Redis I/O in Python.
- **External tool caching (cost + latency):** Cache JSON from **yfinance** and **Tavily** using **composite keys** (e.g., `cache:yfinance:AAPL:today`). Use a **strict TTL** (e.g., **300 seconds**). Tool paths must **read Redis first** and only call HTTP when there is a miss.
- **Rate limiting:** Use **`fastapi-limiter`** (Redis-backed) on **`POST /api/chat/stream`** to limit abuse and token burn (e.g., **10 requests per minute per IP or per session**, per product rules).
- **Idempotency (anti-debounce):** Store a **request hash** with a **short TTL** (e.g., **5 seconds**) to **reject duplicate** submissions (e.g., repeated **Send** clicks) and avoid parallel duplicate LLM runs.

### C. Connection and environment management

- Application code must stay **environment-agnostic** (local Docker vs cloud).
- Instantiate DB and Redis **only** from **`DATABASE_URL`** and **`REDIS_URL`** (and related standard env vars if documented, without hardcoding hosts).
- Use FastAPI **`Depends()`** with **yielding** DB sessions and Redis clients in route dependencies so connections close correctly and tests can substitute fakes.

## 5. Tool Integrations and Third-Party APIs

Integrate the following so answers stay timely, accurate, and **grounded** (no fabrication):

| Integration | Role |
| --- | --- |
| **Core LLM (OpenAI API)** | **gpt-4o-mini** for fast intent recognition and routing; **gpt-4o** for synthesis and final answers. |
| **General search (Tavily API)** | Retrieves news, macro context, and clean page content for citations. |
| **Finance (yfinance)** | Quotes for assets (e.g., gold, silver, uranium-related equities) to reduce numeric hallucinations. |

## 6. Pydantic and SQLModel Implementation Guidelines

- **Agent tool calling:** Pydantic models for tool inputs (e.g., `MarketDataQuery` with `asset_symbol`, `data_type`) for LLM function calling / JSON Schema.
- **API contracts:** `ChatRequest`, SSE payload models, etc.; FastAPI should return **422** on invalid input.
- **External APIs:** Response models (e.g., Tavily) to strip noise before context enters the LLM.
- **Persistence:** **SQLModel** for PostgreSQL entities (including **`ChatSession`** / **`ChatMessage`** and related tables); schema evolution via **Alembic** (same workflow for local Docker Postgres and cloud Neon).

## 7. Multi-Agent Architecture

**Router–Worker** pattern:

| Agent | Role | Behavior |
| --- | --- | --- |
| **Agent 1: Orchestrator (Router)** | Intent and routing. | If no recent external data is needed, replies directly. Otherwise routes optimized search queries to Agent 2. |
| **Agent 2: Researcher (Worker)** | Tools and grounded answers. | Calls **Tavily** (general search) and **yfinance** (financial data). Answers must be **strictly grounded** on retrieved context; append citations (e.g., `[1]`) at the end of referenced sentences. |

## 8. UX and Frontend Behavior

- **Multi-tab chat and history:** **Zustand** with **persist** middleware — save session state (multiple conversation tabs, message history) to **localStorage**.
- **Abort generation:** Use **`AbortController`**. Provide a **“Stop Generating”** control during streaming to halt the client stream and reduce wasted API use. The FastAPI backend must handle cancellation (**e.g., `asyncio.CancelledError`**) and tear down background work cleanly.
- **Rich execution feedback:** Before the token stream, drive a **“Thought Process”** UI from **`event: status`** (e.g., “Agent 1 analyzing intent…”, “Searched Tavily for CPI data”).

## 9. API and Streaming Interfaces

- **Endpoint:** `POST /api/chat/stream`
- **Request** (implement with Pydantic; shape may extend as needed — e.g. `session_id` + `message` per Phase 2):

```json
{
  "messages": [
    { "role": "user", "content": "..." }
  ]
}
```

**SSE (normative contract):** Defined in **[backend/TECH_SPEC.md](backend/TECH_SPEC.md)** (and mirrored in **[frontend/TECH_SPEC.md](frontend/TECH_SPEC.md)**): `status` (JSON with `message` and `tool`), `token` (**JSON string** chunks), terminal `done` / `error` payloads.

**Protections on this endpoint (see §4.B):** Redis-backed **rate limiting** (`fastapi-limiter`) and **idempotency** / deduplication for duplicate rapid requests.

## 10. Security and Compliance

- **Keys:** Never hardcode secrets; use `.env` and **`.gitignore`** for env files.
- **Agent 2 prompt:** *"You may only answer based on the context returned by the tools. Do not fabricate data. When citing information, you must append the source index, e.g., [1]."*

## 11. Documentation Requirements (`README.md`)

The **README.md** must stay current and include **these sections** (titles as below):

1. **Project Startup & Environment Setup** — `.env` setup, running **`docker-compose.yml`**, and local vs production notes.
2. **Architecture Design** — Multi-agent flow, hybrid deployment (Docker vs Vercel/Netlify + Render/Railway + Neon/Upstash), **PostgreSQL vs Redis roles**, **`ChatSession` / `ChatMessage`**, caching and rate-limit behavior, and **database schema** overview.
3. **AI Tools Usage** — Explicit documentation of prompts and methods used with AI tooling (e.g., Cursor/Copilot) for this assignment.

## 12. Engineering and Review Standards

Follow `.cursor/rules/senior-review-and-engineering-standards.mdc` for Staff/Principal-level code quality, typing, modularity, security, and review expectations.

## 13. Recommended Test Cases

1. **Agent 1 (no search):** *"Hello, can you explain what rate limiting is in system design?"* — Direct answer; no Tavily/yfinance.
2. **Agent 2:** *"Can you summarize today's latest US CPI inflation data and how the gold and silver spot markets are reacting?"* — Tavily (+ yfinance where appropriate); citations.
3. **Agent 2:** *"What is the current stock price of Cameco (CCJ)? Are there any major breaking news stories in the uranium market?"* — yfinance + Tavily; citations.
