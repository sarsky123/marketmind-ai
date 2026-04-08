from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta

from redis.asyncio import Redis

from config import Settings, get_settings


def visitors_key_utc_today() -> str:
    day = datetime.now(UTC).strftime("%Y-%m-%d")
    return f"visitors:{day}"


def _utc_day() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d")


def quota_key(session_id: str, utc_day: str | None = None) -> str:
    day = utc_day or _utc_day()
    return f"quota:{session_id}:{day}"


def _quota_ttl_seconds(now: datetime | None = None) -> int:
    """
    Keep today's quota keys around long enough for late reads/debugging.

    Strategy: expire ~24h after next UTC midnight (max ~48h).
    """
    n = now or datetime.now(UTC)
    next_midnight = datetime(n.year, n.month, n.day, tzinfo=UTC) + timedelta(days=1)
    seconds_until_midnight = int((next_midnight - n).total_seconds())
    return max(1, seconds_until_midnight + 86400)


def invite_key(code: str) -> str:
    return f"invite:{code}"


def rate_limit_key(client_ip: str, window_minute: int) -> str:
    return f"rl:{client_ip}:{window_minute}"


async def try_reserve_visitor_slot(redis: Redis, settings: Settings | None = None) -> bool:
    """Increment daily visitor count; return True if this visit is within cap."""
    s = settings or get_settings()
    key = visitors_key_utc_today()
    value = await redis.incr(key)
    if value == 1:
        await redis.expire(key, 172800)
    if value > s.max_daily_visitors:
        await redis.decr(key)
        return False
    return True


async def invite_is_active(redis: Redis, code: str) -> bool:
    raw = await redis.get(invite_key(code.strip()))
    if not raw:
        return False
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return False
    return isinstance(data, dict) and data.get("status") == "active"


async def init_quota(redis: Redis, session_id: str, quota: int, ttl_seconds: int) -> None:
    """
    Deprecated: quota is daily; minting should not pre-create quota keys.

    Kept temporarily to avoid breaking imports; do not call.
    """
    _ = (redis, session_id, quota, ttl_seconds)


async def check_ip_rate_limit(
    redis: Redis,
    client_ip: str,
    settings: Settings | None = None,
) -> tuple[bool, int]:
    """
    Fixed 1-minute window. Returns (allowed, current_count_after_increment).
    """
    s = settings or get_settings()
    window = int(time.time() // 60)
    key = rate_limit_key(client_ip, window)
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, 120)
    if count > s.rate_limit_per_min:
        await redis.decr(key)
        return False, count - 1
    return True, count


async def consume_quota_unit(
    redis: Redis,
    session_id: str,
    daily_limit: int,
) -> tuple[bool, int | None]:
    """
    DECR today's UTC quota key. Returns (allowed, remaining_after_decrement or None if missing key).
    If not allowed, rolls back the decrement.
    """
    if daily_limit < 0:
        daily_limit = 0
    key = quota_key(session_id)
    # Lazy-init the daily bucket so `/api/auth/me` can show "full day left" before any request.
    try:
        await redis.set(key, str(daily_limit), ex=_quota_ttl_seconds(), nx=True)
    except Exception:
        # If Redis rejects SET NX for any reason, fallback to best-effort DECR behavior.
        pass
    remaining = await redis.decr(key)
    if remaining < 0:
        await redis.incr(key)
        return False, None
    return True, remaining
