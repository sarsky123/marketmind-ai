"""Centralized environment-backed settings (no hardcoded limits in routes/tools)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

# Default Redis TTL for `invite:{token}` keys (keep in sync with `scripts/generate_invite.py`).
ONE_WEEK_SECONDS = 7 * 24 * 3600


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.environ.get(key)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def _env_str(key: str, default: str) -> str:
    raw = os.environ.get(key)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip()


def _parse_cors_origins(raw: str) -> list[str]:
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    return parts or ["http://localhost:5173", "http://127.0.0.1:5173"]


def _parse_max_context_messages(raw: str | None) -> int | None:
    """Unset or empty → 60; 'none' / 'unlimited' → None; else int."""
    if raw is None or raw.strip() == "":
        return 60
    s = raw.strip().lower()
    if s in ("none", "unlimited"):
        return None
    return int(s)


@dataclass(frozen=True)
class Settings:
    auth_jwt_secret: str
    max_daily_visitors: int
    visitor_quota: int
    invite_quota: int
    rate_limit_per_min: int
    jwt_expires_seconds: int
    jwt_algorithm: str
    cookie_secure: bool
    cookie_samesite: str
    cors_origins: list[str]
    client_ip_trust_proxy: bool
    max_orchestrator_rounds: int
    max_finance_rounds: int
    max_context_messages: int | None
    yfinance_cache_ttl_seconds: int
    tavily_max_results: int
    invite_ttl_seconds: int


@lru_cache
def get_settings() -> Settings:
    secret = os.environ.get("AUTH_JWT_SECRET", "").strip()
    if not secret:
        msg = "AUTH_JWT_SECRET is required"
        raise RuntimeError(msg)
    invite_ttl = _env_int("INVITE_TTL_SECONDS", ONE_WEEK_SECONDS)
    if invite_ttl < 1:
        invite_ttl = ONE_WEEK_SECONDS
    return Settings(
        auth_jwt_secret=secret,
        max_daily_visitors=_env_int("MAX_DAILY_VISITORS", 10),
        visitor_quota=_env_int("VISITOR_QUOTA", 50),
        invite_quota=_env_int("INVITE_QUOTA", 200),
        rate_limit_per_min=_env_int("RATE_LIMIT_PER_MIN", 20),
        jwt_expires_seconds=_env_int("JWT_EXPIRES_SECONDS", 86400),
        jwt_algorithm=_env_str("JWT_ALGORITHM", "HS256"),
        cookie_secure=_env_bool("COOKIE_SECURE", False),
        cookie_samesite=_env_str("COOKIE_SAMESITE", "lax").lower(),
        cors_origins=_parse_cors_origins(os.environ.get("CORS_ORIGINS", "")),
        client_ip_trust_proxy=_env_bool("CLIENT_IP_TRUST_PROXY", False),
        max_orchestrator_rounds=_env_int("MAX_ORCHESTRATOR_ROUNDS", 20),
        max_finance_rounds=_env_int("MAX_FINANCE_ROUNDS", 15),
        max_context_messages=_parse_max_context_messages(os.environ.get("MAX_CONTEXT_MESSAGES")),
        yfinance_cache_ttl_seconds=_env_int("YFINANCE_CACHE_TTL_SECONDS", 300),
        tavily_max_results=_env_int("TAVILY_MAX_RESULTS", 5),
        invite_ttl_seconds=invite_ttl,
    )


def reset_settings_cache() -> None:
    """Test hook."""
    get_settings.cache_clear()


def get_engine_config() -> "EngineConfig":
    from ai.types import EngineConfig

    s = get_settings()
    return EngineConfig(
        max_orchestrator_rounds=s.max_orchestrator_rounds,
        max_finance_rounds=s.max_finance_rounds,
        max_context_messages=s.max_context_messages,
    )
