from __future__ import annotations

import os
from dataclasses import dataclass

from redis.asyncio import Redis


@dataclass(frozen=True)
class RuntimeContext:
    """Per-request flags and clients (no scattered os.environ in tools)."""

    redis: Redis
    openai_api_key: str
    tavily_api_key: str | None
    orchestrator_model: str
    finance_model: str
    tavily_configured: bool


def build_runtime_context(redis: Redis) -> RuntimeContext:
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    tavily_key = os.environ.get("TAVILY_API_KEY") or None
    return RuntimeContext(
        redis=redis,
        openai_api_key=openai_key,
        tavily_api_key=tavily_key,
        orchestrator_model=os.environ.get("ORCHESTRATOR_MODEL", "gpt-4o-mini"),
        finance_model=os.environ.get("FINANCE_MODEL", "gpt-4o-mini"),
        tavily_configured=bool(tavily_key),
    )
