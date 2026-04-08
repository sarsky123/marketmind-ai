from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt

from config import Settings, get_settings


AuthRole = Literal["visitor", "invited"]

SESSION_COOKIE_NAME = "session_token"


@dataclass(frozen=True)
class AuthClaims:
    session_id: uuid.UUID
    role: AuthRole
    quota: int
    exp: int


def mint_token(
    session_id: uuid.UUID,
    role: AuthRole,
    quota: int,
    settings: Settings | None = None,
) -> tuple[str, int]:
    """Return (jwt_str, expires_at_unix)."""
    s = settings or get_settings()
    now = datetime.now(UTC)
    exp = now + timedelta(seconds=s.jwt_expires_seconds)
    exp_ts = int(exp.timestamp())
    payload: dict[str, Any] = {
        "session_id": str(session_id),
        "role": role,
        "quota": quota,
        "exp": exp_ts,
        "iat": int(now.timestamp()),
    }
    encoded = jwt.encode(payload, s.auth_jwt_secret, algorithm=s.jwt_algorithm)
    if isinstance(encoded, bytes):
        encoded = encoded.decode("ascii")
    return encoded, exp_ts


def decode_verify(token: str, settings: Settings | None = None) -> AuthClaims:
    s = settings or get_settings()
    try:
        payload = jwt.decode(
            token,
            s.auth_jwt_secret,
            algorithms=[s.jwt_algorithm],
            options={"require": ["exp", "session_id", "role", "quota"]},
        )
    except jwt.PyJWTError as exc:
        msg = "Invalid or expired token"
        raise ValueError(msg) from exc
    sid_raw = payload.get("session_id")
    role_raw = payload.get("role")
    quota_raw = payload.get("quota")
    if role_raw not in ("visitor", "invited"):
        msg = "Invalid role"
        raise ValueError(msg)
    try:
        sid = uuid.UUID(str(sid_raw))
    except ValueError as exc:
        msg = "Invalid session id"
        raise ValueError(msg) from exc
    qv: int
    if isinstance(quota_raw, bool) or not isinstance(quota_raw, (int, float)):
        msg = "Invalid quota"
        raise ValueError(msg)
    qv = int(quota_raw)
    if qv < 0:
        msg = "Invalid quota"
        raise ValueError(msg)
    exp_raw = payload.get("exp")
    if isinstance(exp_raw, bool) or not isinstance(exp_raw, (int, float)):
        msg = "Invalid exp"
        raise ValueError(msg)
    return AuthClaims(session_id=sid, role=role_raw, quota=qv, exp=int(exp_raw))
