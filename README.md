# Multi-Agent Search Chatbot

This repository is a “walking skeleton” for a multi-agent, web-search-enabled AI chatbot. It scaffolds a hybrid local environment (React + FastAPI + Postgres + Redis) and validates SSE streaming end-to-end.

## Project Startup & Environment Setup

### 1. Configure environment variables

1. Copy the backend environment template:

   ```bash
   cp backend/.env.example backend/.env
   ```

2. Ensure `backend/.env` contains valid connection strings:
   - `DATABASE_URL` (PostgreSQL, for example local Docker Postgres)
   - `REDIS_URL` (Redis)

### 2. Start the local hybrid stack (Docker)

From the repository root:

```bash
docker-compose up --build
```

Or using the Makefile:

```bash
make up
```

Expected ports:
- Frontend (Vite): `http://localhost:5173`
- Backend (FastAPI): `http://localhost:8000`
- RedisInsight UI: `http://localhost:5540`

### 3. Stop the stack

```bash
docker-compose down
```

## Architecture Design

### Multi-agent flow (Router–Worker)

The intended architecture follows a Router–Worker pattern:
- **Agent 1 (Orchestrator / Router):** determines whether the user needs fresh external data; routes requests accordingly.
- **Agent 2 (Researcher / Worker):** executes external tools (e.g., Tavily and yfinance) and produces grounded responses with inline citations.

This walking-skeleton phase does not implement the agent logic yet, but it validates the plumbing:
- **Streaming endpoint:** `POST /api/chat/stream`
- **SSE events:**
  - `event: status` → `{ "message": "..." }` (rich execution feedback)
  - `event: token` → `{ "text": "..." }` (token streaming / typewriter effect)

### Hybrid deployment strategy (local vs production)

The system is designed to run in two environments, controlled by `.env` configuration:
- **Local development (Dockerized):** `docker-compose.yml` runs `frontend`, `backend`, `postgres`, and `redis`.
- **Production (serverless-oriented):** frontend on Vercel/Netlify; backend on Render/Railway; Postgres on Neon (or equivalent); Redis on Upstash (or equivalent).

### PostgreSQL + Redis responsibilities (source of truth vs performance)

- **PostgreSQL (source of truth):** persistence for durable chat/session state (e.g., `ChatSession`, `ChatMessage`).
- **Redis (ephemeral):** API caching, rate limiting, and request deduplication.

Schema state in this phase:
- Alembic/SQLModel wiring is set up.
- The initial revision is currently a no-op (`0001_initial`), so there are no user tables yet.

### Migrations

The backend runs:
1. `alembic upgrade head`
2. then starts the FastAPI server.

So schema changes should be applied via Alembic before startup.

## AI Tools Usage

This phase used Cursor to scaffold the initial repository structure and wiring.

Example prompts used (for traceability):
- “Generate a root `docker-compose.yml` with frontend, backend, Postgres 15, Redis, and RedisInsight.”
- “Create FastAPI endpoints for `/health` and dummy SSE `POST /api/chat/stream` with correct event framing.”
- “Scaffold a minimal Vite + React + TypeScript UI that calls `/health` and renders streamed `event: token` text.”

## Developer Ergonomics (Makefile)

Use the Makefile for local schema evolution without restarting containers:

```bash
make db-upgrade
```

Create a new Alembic migration:

```bash
make db-migrate MSG="add_new_tables"
```

