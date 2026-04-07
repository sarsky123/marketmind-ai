import os
from functools import lru_cache
from typing import AsyncIterator

import redis.asyncio as redis
from redis.asyncio import Redis
from sqlmodel import SQLModel
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine


@lru_cache
def _database_url() -> str:
    # Strict: do not provide any fallback connection string.
    return os.environ["DATABASE_URL"]


@lru_cache
def _redis_url() -> str:
    # Strict: do not provide any fallback connection string.
    return os.environ["REDIS_URL"]


@lru_cache
def get_engine() -> AsyncEngine:
    return create_async_engine(_database_url(), echo=False, future=True)


async def get_db_session() -> AsyncIterator[AsyncSession]:
    async with AsyncSession(get_engine(), expire_on_commit=False) as async_session:
        yield async_session


@lru_cache
def get_redis_client() -> Redis:
    # decode_responses=True yields str values rather than bytes.
    return redis.from_url(_redis_url(), decode_responses=True)


async def close_redis_client() -> None:
    client = get_redis_client()
    await client.close()


def get_metadata() -> object:
    # Alembic should import SQLModel metadata from a stable API.
    return SQLModel.metadata

