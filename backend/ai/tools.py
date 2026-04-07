from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from ai.context import RuntimeContext
from ai.types import ToolRunResult


async def tool_search_web(ctx: RuntimeContext, query: str) -> ToolRunResult:
    if not ctx.tavily_configured or not ctx.tavily_api_key:
        return ToolRunResult(
            ok=False,
            message="Tavily is not configured (missing TAVILY_API_KEY).",
            meta={},
        )
    try:
        from tavily import TavilyClient  # type: ignore[import-untyped]

        def _search() -> object:
            client = TavilyClient(api_key=ctx.tavily_api_key)
            return client.search(query=query, max_results=5)

        data = await asyncio.to_thread(_search)
    except Exception as exc:  # noqa: BLE001
        return ToolRunResult(ok=False, message=f"Search failed: {exc}", meta={})

    try:
        results = getattr(data, "results", None) or (
            data.get("results") if isinstance(data, dict) else None
        )
        if not results:
            return ToolRunResult(ok=True, message="No results.", meta={"refs": []})
        lines: list[str] = []
        refs: list[dict[str, str]] = []
        for i, item in enumerate(results, start=1):
            if isinstance(item, dict):
                title = str(item.get("title", ""))
                url = str(item.get("url", ""))
                content = str(item.get("content", "") or item.get("raw_content", ""))
            else:
                title = str(getattr(item, "title", ""))
                url = str(getattr(item, "url", ""))
                content = str(
                    getattr(item, "content", "") or getattr(item, "raw_content", "")
                )
            lines.append(f"[{i}] {title} — {content[:800]}")
            refs.append({"title": title, "url": url})
        return ToolRunResult(ok=True, message="\n".join(lines), meta={"refs": refs})
    except Exception as exc:  # noqa: BLE001
        return ToolRunResult(
            ok=False,
            message=f"Failed to parse search results: {exc}",
            meta={},
        )


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
        import yfinance as yf  # type: ignore[import-untyped]

        def _quote() -> str:
            t = yf.Ticker(ticker)
            info = t.fast_info  # type: ignore[attr-defined]
            last = getattr(info, "last_price", None) or getattr(info, "lastPrice", None)
            if last is not None:
                return f"{ticker.upper()} last: {last}"
            hist = t.history(period="5d")
            if hist is not None and not hist.empty:
                close = float(hist["Close"].iloc[-1])
                return f"{ticker.upper()} last close: {close}"
            return f"No price data for {ticker.upper()}."

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
