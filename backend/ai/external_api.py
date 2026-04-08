"""Sanitized shapes and helpers for third-party HTTP/SDK payloads (Tavily, yfinance).

Tavily's Python SDK types ``search`` as ``dict``; these TypedDicts follow the public
Search API response. yfinance ships without ``py.typed``; quote helpers use the
library's concrete ``Ticker`` and ``FastInfo`` types from their published modules.
"""

from __future__ import annotations

import logging
from typing import cast

import pandas as pd
from pydantic import TypeAdapter, ValidationError
from typing_extensions import TypedDict
from yfinance import Ticker
from yfinance.scrapers.quote import FastInfo


class TavilySearchResult(TypedDict, total=False):
    """One item under ``results`` in a Tavily Search response."""

    title: str
    url: str
    content: str
    raw_content: str
    score: float
    published_date: str


class TavilySearchResponse(TypedDict, total=False):
    """Tavily Search API JSON (``TavilyClient.search`` return shape)."""

    query: str
    answer: str
    results: list[TavilySearchResult]
    response_time: float


_TAVILY_SEARCH_ADAPTER = TypeAdapter(TavilySearchResponse)
logger = logging.getLogger(__name__)


def parse_tavily_search_response(data: object) -> TavilySearchResponse:
    """Validate/normalize Tavily ``search`` JSON; raises ``ValidationError`` if unusable."""
    try:
        return _TAVILY_SEARCH_ADAPTER.validate_python(data)
    except ValidationError:
        logger.exception("parse_tavily_search_response failed")
        raise


def tavily_results(payload: TavilySearchResponse) -> list[TavilySearchResult]:
    raw = payload.get("results")
    if raw is None:
        return []
    return cast(list[TavilySearchResult], raw)


def yfinance_fast_info_last_price(ticker: Ticker) -> float | None:
    """Best-effort last price from ``Ticker.fast_info`` (yfinance ``FastInfo``)."""
    info: FastInfo = ticker.fast_info
    last = info.last_price
    if last is None:
        return None
    try:
        return float(last)
    except (TypeError, ValueError):
        return None


def yfinance_last_close_from_history(ticker: Ticker, *, period: str = "5d") -> float | None:
    """Fallback close from recent history when ``fast_info`` has no last price."""
    hist: pd.DataFrame = ticker.history(period=period)
    if hist is None or hist.empty or "Close" not in hist.columns:
        return None
    close = hist["Close"].iloc[-1]
    try:
        return float(close)
    except (TypeError, ValueError):
        return None


def format_yfinance_price_line(symbol: str, *, last: float | None, history_close: float | None) -> str:
    upper = symbol.upper()
    if last is not None:
        return f"{upper} last: {last}"
    if history_close is not None:
        return f"{upper} last close: {history_close}"
    return f"No price data for {upper}."
