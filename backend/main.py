import asyncio
import json
import os
from typing import AsyncIterator, Literal

import asyncpg
import redis.asyncio as redis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


def _sse_event(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _ping_postgres() -> bool:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return False

    try:
        conn = await asyncpg.connect(database_url)
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
    postgres_ok = await _ping_postgres()
    redis_ok = await _ping_redis()
    return {"postgres": postgres_ok, "redis": redis_ok}


@app.post("/api/chat/stream")
async def chat_stream(_: ChatRequest) -> StreamingResponse:
    async def _stream() -> AsyncIterator[str]:
        try:
            yield _sse_event("status", {"message": "Dummy agent thinking..."})

            for token in ["Hello ", "from ", "SSE!"]:
                await asyncio.sleep(0.5)
                yield _sse_event("token", {"text": token})
        except asyncio.CancelledError:
            # Client disconnected or aborted generation.
            return

    return StreamingResponse(_stream(), media_type="text/event-stream")

