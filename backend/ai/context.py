from __future__ import annotations

import os
from dataclasses import dataclass

from redis.asyncio import Redis

from config import Settings, get_settings


@dataclass(frozen=True)
class RuntimeContext:
    """Per-request flags and clients (no scattered os.environ in tools)."""

    redis: Redis
    openai_api_key: str
    tavily_api_key: str | None
    orchestrator_model: str
    finance_model: str
    tavily_configured: bool
    yfinance_cache_ttl_seconds: int
    tavily_max_results: int


def build_runtime_context(redis: Redis, settings: Settings | None = None) -> RuntimeContext:
    s = settings or get_settings()
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    tavily_key = os.environ.get("TAVILY_API_KEY") or None
    return RuntimeContext(
        redis=redis,
        openai_api_key=openai_key,
        tavily_api_key=tavily_key,
        orchestrator_model=os.environ.get("ORCHESTRATOR_MODEL", "gpt-4o-mini"),
        finance_model=os.environ.get("FINANCE_MODEL", "gpt-4o-mini"),
        tavily_configured=bool(tavily_key),
        yfinance_cache_ttl_seconds=s.yfinance_cache_ttl_seconds,
        tavily_max_results=s.tavily_max_results,
    )
