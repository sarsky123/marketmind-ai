from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid

logger = logging.getLogger(__name__)
from typing import AsyncIterator

import asyncpg
import redis.asyncio as redis
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ai.agents import map_engine_event_to_sse, run_orchestrator
from ai.context import build_runtime_context
from ai.permissions import ToolPermissionContext
from ai.repository import ChatRepository
from ai.types import Citation, parse_stored_citations
from auth.middleware import ProtectApiMiddleware
from auth.routes import router as auth_router
from config import get_engine_config, get_settings
from db import get_db_session, get_engine, get_redis_client

_settings = get_settings()

app = FastAPI(title="AI Financial Assistant API")

app.add_middleware(ProtectApiMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)


class CreateSessionRequest(BaseModel):
    title: str | None = None
    user_id: uuid.UUID | None = None


class CreateSessionResponse(BaseModel):
    session_id: uuid.UUID
    user_id: uuid.UUID


class SessionSummaryResponse(BaseModel):
    session_id: uuid.UUID
    title: str | None = None
    created_at: str
    updated_at: str


class ChatMessageResponse(BaseModel):
    id: uuid.UUID
    role: str
    content: str | None = None
    created_at: str
    citations: list[Citation] | None = None


class ChatStreamRequest(BaseModel):
    session_id: uuid.UUID
    message: str = Field(..., min_length=1)


def _sse_line(event: str, data: object) -> str:
    """Emit one SSE frame; token data must be a JSON string (quoted)."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _database_url_for_asyncpg(url: str) -> str:
    if "+asyncpg" in url:
        return url.replace("postgresql+asyncpg://", "postgresql://", 1)
    return url


async def _ping_postgres() -> bool:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return False
    url = _database_url_for_asyncpg(database_url)
    try:
        conn = await asyncpg.connect(url)
        try:
            result = await asyncio.wait_for(conn.fetchval("SELECT 1"), timeout=3.0)
            return result == 1
        finally:
            await conn.close()
    except Exception:
        return False


async def _ping_redis() -> bool:
    redis_url = os.environ.get("REDIS_URL")
    if not redis_url:
        return False
    client = redis.from_url(redis_url)
    try:
        result = await asyncio.wait_for(client.ping(), timeout=3.0)
        return bool(result)
    except Exception:
        return False
    finally:
        await client.close()


@app.get("/")
async def root() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health")
async def health() -> dict[str, bool]:
    postgres_ok_source = bool(os.environ.get("DATABASE_URL"))
    redis_ok_source = bool(os.environ.get("REDIS_URL"))
    postgres_ok = postgres_ok_source and await _ping_postgres()
    redis_ok = redis_ok_source and await _ping_redis()
    return {"postgres": postgres_ok, "redis": redis_ok}


@app.post("/api/sessions", response_model=CreateSessionResponse)
async def create_session(
    body: CreateSessionRequest,
    db_session: AsyncSession = Depends(get_db_session),
) -> CreateSessionResponse:
    repo = ChatRepository(db_session)
    uid = await repo.ensure_user(body.user_id)
    sess = await repo.create_session(uid, body.title)
    await db_session.commit()
    return CreateSessionResponse(session_id=sess.id, user_id=uid)


@app.get("/api/sessions", response_model=list[SessionSummaryResponse])
async def list_sessions(
    user_id: uuid.UUID,
    db_session: AsyncSession = Depends(get_db_session),
) -> list[SessionSummaryResponse]:
    repo = ChatRepository(db_session)
    sessions = await repo.list_sessions(user_id)
    return [
        SessionSummaryResponse(
            session_id=s.id,
            title=s.title,
            created_at=s.created_at.isoformat(),
            updated_at=s.updated_at.isoformat(),
        )
        for s in sessions
    ]


@app.delete("/api/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: uuid.UUID,
    user_id: uuid.UUID,
    db_session: AsyncSession = Depends(get_db_session),
) -> Response:
    repo = ChatRepository(db_session)
    deleted = await repo.delete_session_owned_by(session_id, user_id)
    if not deleted:
        return Response(status_code=404)
    await db_session.commit()
    return Response(status_code=204)


@app.get("/api/sessions/{session_id}/messages", response_model=list[ChatMessageResponse])
async def list_session_messages(
    session_id: uuid.UUID,
    db_session: AsyncSession = Depends(get_db_session),
) -> list[ChatMessageResponse]:
    repo = ChatRepository(db_session)
    sess = await repo.get_session(session_id)
    if sess is None:
        return []
    messages = await repo.list_messages(session_id)
    return [
        ChatMessageResponse(
            id=m.id,
            role=m.role,
            content=m.content,
            created_at=m.created_at.isoformat(),
            citations=parse_stored_citations(m.tool_calls),
        )
        for m in messages
    ]


@app.post("/api/chat/stream")
async def chat_stream(body: ChatStreamRequest) -> StreamingResponse:
    redis_client = get_redis_client()
    engine = get_engine()
    config = get_engine_config()
    perm = ToolPermissionContext()

    async def _gen() -> AsyncIterator[str]:
        try:
            async with AsyncSession(engine, expire_on_commit=False) as db_session:
                repo = ChatRepository(db_session)
                sess = await repo.get_session(body.session_id)
                if sess is None:
                    yield _sse_line(
                        "error",
                        {"message": "Session not found.", "code": 404},
                    )
                    return

                ctx = build_runtime_context(redis_client, _settings)
                async for ev in run_orchestrator(
                    db_session=db_session,
                    repo=repo,
                    ctx=ctx,
                    session_id=body.session_id,
                    user_message=body.message,
                    config=config,
                    perm=perm,
                ):
                    event_name, payload = map_engine_event_to_sse(ev)
                    yield _sse_line(event_name, payload)
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            logger.exception("chat stream failed")
            yield _sse_line(
                "error",
                {"message": "An unexpected error occurred.", "code": 500},
            )
            _ = exc

    return StreamingResponse(_gen(), media_type="text/event-stream")
