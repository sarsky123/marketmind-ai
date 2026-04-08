from __future__ import annotations

import logging
from typing import Callable

from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from auth.jwt_tokens import SESSION_COOKIE_NAME, decode_verify
from auth.redis_limits import check_ip_rate_limit, consume_quota_unit
from config import Settings, get_settings
from db import get_redis_client

logger = logging.getLogger(__name__)


def client_ip(request: Request, settings: Settings) -> str:
    if settings.client_ip_trust_proxy:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


def _skip_ip_rate_limit(path: str) -> bool:
    return path in ("/", "/health")


def _skip_auth_and_quota(path: str) -> bool:
    if path.startswith("/api/auth/anonymous"):
        return True
    if path == "/api/auth/me":
        return True
    if path in ("/docs", "/redoc", "/openapi.json"):
        return True
    return False


class ProtectApiMiddleware(BaseHTTPMiddleware):
    """IP rate limit on `/api`; JWT + per-session Redis quota on protected `/api` routes."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next: Callable[[Request], Response]) -> Response:
        if request.method == "OPTIONS":
            return await call_next(request)

        path = request.url.path
        settings = get_settings()

        if not _skip_ip_rate_limit(path) and path.startswith("/api"):
            redis = get_redis_client()
            ip = client_ip(request, settings)
            allowed, _ = await check_ip_rate_limit(redis, ip, settings)
            if not allowed:
                return JSONResponse(
                    status_code=429,
                    content={
                        "detail": "rate_limit",
                        "message": "Too many requests from this network.",
                    },
                )

        if path.startswith("/api") and not _skip_auth_and_quota(path):
            token = request.cookies.get(SESSION_COOKIE_NAME)
            if not token:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "not_authenticated", "message": "Missing session."},
                )
            try:
                claims = decode_verify(token, settings)
            except ValueError:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "invalid_token", "message": "Invalid or expired session."},
                )

            redis = get_redis_client()
            ok, remaining = await consume_quota_unit(redis, str(claims.session_id))
            if not ok:
                return JSONResponse(
                    status_code=403,
                    content={
                        "detail": "quota_exceeded",
                        "message": "API quota exceeded for this session.",
                    },
                )
            request.state.auth_claims = claims
            request.state.quota_remaining = remaining

        return await call_next(request)
