from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from auth.jwt_tokens import SESSION_COOKIE_NAME, decode_verify, mint_token
from auth.redis_limits import init_quota, invite_is_active, quota_key, try_reserve_visitor_slot
from config import get_settings
from db import get_redis_client

router = APIRouter(prefix="/api/auth", tags=["auth"])


class AnonymousAuthRequest(BaseModel):
    invite: str | None = Field(default=None, max_length=256)


class AnonymousAuthResponse(BaseModel):
    ok: bool
    exp: int


def _set_session_cookie(response: Response, token: str, max_age: int) -> None:
    s = get_settings()
    same = s.cookie_samesite.lower()
    if same not in ("lax", "strict", "none"):
        same = "lax"
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=s.cookie_secure,
        samesite=same,  # type: ignore[arg-type]
        path="/",
    )


@router.post("/anonymous", response_model=AnonymousAuthResponse)
async def anonymous_auth(body: AnonymousAuthRequest, response: Response) -> AnonymousAuthResponse:
    settings = get_settings()
    redis = get_redis_client()
    invite_code = (body.invite or "").strip()

    if invite_code:
        if not await invite_is_active(redis, invite_code):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid_invite",
            )
        role = "invited"
        quota = settings.invite_quota
    else:
        allowed = await try_reserve_visitor_slot(redis, settings)
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="daily_visitor_limit",
            )
        role = "visitor"
        quota = settings.visitor_quota

    auth_sid = uuid.uuid4()
    token, exp_ts = mint_token(auth_sid, role, quota, settings)
    await init_quota(redis, str(auth_sid), quota, settings.jwt_expires_seconds)
    _set_session_cookie(response, token, settings.jwt_expires_seconds)
    return AnonymousAuthResponse(ok=True, exp=exp_ts)


@router.get("/me")
async def auth_me(request: Request) -> dict[str, object]:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not_authenticated",
        )
    try:
        claims = decode_verify(token)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_token",
        ) from None
    redis = get_redis_client()
    raw = await redis.get(quota_key(str(claims.session_id)))
    quota_remaining: int | None
    if raw is None:
        quota_remaining = None
    else:
        try:
            quota_remaining = int(raw)
        except ValueError:
            quota_remaining = None
    return {
        "session_id": str(claims.session_id),
        "role": claims.role,
        "quota": claims.quota,
        "exp": claims.exp,
        "quota_remaining": quota_remaining,
    }
