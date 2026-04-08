from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from ai.context import RuntimeContext
from ai.external_api import (
    format_yfinance_price_line,
    parse_tavily_search_response,
    tavily_results,
    yfinance_fast_info_last_price,
    yfinance_last_close_from_history,
)
from ai.types import ToolRunResult, ToolWebRef
from pydantic import ValidationError


async def tool_search_web(ctx: RuntimeContext, query: str) -> ToolRunResult:
    if not ctx.tavily_configured or not ctx.tavily_api_key:
        return ToolRunResult(
            ok=False,
            message="Tavily is not configured (missing TAVILY_API_KEY).",
            meta={},
        )
    try:
        from tavily import TavilyClient

        def _search() -> object:
            client = TavilyClient(api_key=ctx.tavily_api_key)
            return client.search(query=query, max_results=5)

        data = await asyncio.to_thread(_search)
    except Exception as exc:  # noqa: BLE001
        return ToolRunResult(ok=False, message=f"Search failed: {exc}", meta={})

    if not isinstance(data, dict):
        return ToolRunResult(
            ok=False,
            message="Unexpected Tavily response (expected JSON object).",
            meta={},
        )
    try:
        payload = parse_tavily_search_response(data)
    except ValidationError as exc:
        return ToolRunResult(
            ok=False,
            message=f"Invalid Tavily response shape: {exc}",
            meta={},
        )

    results = tavily_results(payload)
    if not results:
        return ToolRunResult(ok=True, message="No results.", meta={"refs": []})
    lines: list[str] = []
    refs: list[ToolWebRef] = []
    for i, item in enumerate(results, start=1):
        title = str(item.get("title", ""))
        url = str(item.get("url", ""))
        content = str(item.get("content", "") or item.get("raw_content", ""))
        lines.append(f"[{i}] {title} — {content[:800]}")
        refs.append({"title": title, "url": url})
    return ToolRunResult(ok=True, message="\n".join(lines), meta={"refs": refs})


def _yfinance_cache_key(ticker: str) -> str:
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"cache:yfinance:{ticker.upper()}:{day}"


async def tool_get_asset_price(ctx: RuntimeContext, ticker: str) -> ToolRunResult:
    key = _yfinance_cache_key(ticker)
    try:
        cached = await ctx.redis.get(key)
        if cached:
            return ToolRunResult(ok=True, message=str(cached), meta={"cached": True})
    except Exception:
        pass

    try:
        import yfinance as yf

        def _quote() -> str:
            t = yf.Ticker(ticker)
            last = yfinance_fast_info_last_price(t)
            hist_close = None if last is not None else yfinance_last_close_from_history(t)
            return format_yfinance_price_line(ticker, last=last, history_close=hist_close)

        text = await asyncio.to_thread(_quote)
    except Exception as exc:  # noqa: BLE001
        return ToolRunResult(ok=False, message=f"Price lookup failed: {exc}", meta={})

    try:
        await ctx.redis.set(key, text, ex=300)
    except Exception:
        pass
    return ToolRunResult(ok=True, message=text, meta={"cached": False})


async def tool_clarify_intent(_ctx: RuntimeContext, clarification_question: str) -> ToolRunResult:
    return ToolRunResult(ok=True, message=clarification_question, meta={})
