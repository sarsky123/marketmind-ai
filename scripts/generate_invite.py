#!/usr/bin/env python3
"""Create an invite code in Redis and print a magic link for invited users."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from datetime import UTC, datetime

import redis

# Must match `backend.config.ONE_WEEK_SECONDS` default for `INVITE_TTL_SECONDS`.
_INVITE_TTL_DEFAULT = 7 * 24 * 3600


def _invite_ttl_seconds() -> int:
    raw = os.environ.get("INVITE_TTL_SECONDS", "").strip()
    if raw == "":
        return _INVITE_TTL_DEFAULT
    value = int(raw)
    if value < 1:
        print("INVITE_TTL_SECONDS must be >= 1", file=sys.stderr)
        raise SystemExit(2)
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate invite code and store in Redis.")
    parser.add_argument(
        "--client",
        required=True,
        help='Label for this invite (e.g. organization or campaign name).',
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("PUBLIC_APP_ORIGIN", "http://localhost:5173").rstrip("/"),
        help="Frontend origin for the magic link (default: PUBLIC_APP_ORIGIN or localhost:5173).",
    )
    args = parser.parse_args()

    url = os.environ.get("REDIS_URL", "").strip()
    if not url:
        print("REDIS_URL is required", file=sys.stderr)
        return 1

    token = secrets.token_urlsafe(24)
    payload = {
        "status": "active",
        "client": args.client,
        "created_at": datetime.now(UTC).isoformat(),
    }
    key = f"invite:{token}"
    r = redis.Redis.from_url(url, decode_responses=True)
    ttl = _invite_ttl_seconds()
    try:
        r.set(key, json.dumps(payload), ex=ttl)
    finally:
        r.close()

    link = f"{args.base_url}/?invite={token}"
    print("Invite stored in Redis.")
    print(f"TTL: {ttl}s ({ttl // 86400}d)")
    print(f"Key: {key}")
    print(f"Magic link: {link}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
