from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal

from pydantic import TypeAdapter, ValidationError
from typing_extensions import TypedDict


class ToolName(StrEnum):
    """Canonical OpenAI function names — single source of truth for registry and permissions."""

    SEARCH_WEB = "search_web"
    GET_ASSET_PRICE = "get_asset_price"
    CLARIFY_INTENT = "clarify_intent"
    CONSULT_FINANCE_AGENT = "consult_finance_agent"
    SET_SESSION_TITLE = "set_session_title"


def parse_tool_name(name: str) -> ToolName | None:
    try:
        return ToolName(name)
    except ValueError:
        return None


AgentRole = Literal["orchestrator", "finance_expert"]

StopReason = Literal["completed", "tool_calls", "error", "max_iterations"]


class Citation(TypedDict):
    index: int
    title: str
    url: str


class ToolWebRef(TypedDict):
    """Source link from search/tools before ``index`` is assigned for ``Citation``."""

    title: str
    url: str


_TOOL_WEB_REFS_ADAPTER = TypeAdapter(list[ToolWebRef])


def parse_tool_web_refs(raw: object) -> list[ToolWebRef]:
    """Coerce tool ``meta['refs']`` (or similar) into validated ``ToolWebRef`` rows."""
    if not isinstance(raw, list) or not raw:
        return []
    try:
        return _TOOL_WEB_REFS_ADAPTER.validate_python(raw)
    except ValidationError:
        return []


def parse_stored_citations(raw: object) -> list[Citation] | None:
    """Parse citation blobs from ``ChatMessage.tool_calls`` JSON (final assistant turn)."""
    if not isinstance(raw, list) or not raw:
        return None
    out: list[Citation] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        idx = item.get("index")
        title = item.get("title")
        url = item.get("url")
        if isinstance(idx, int) and isinstance(title, str) and isinstance(url, str):
            out.append({"index": idx, "title": title, "url": url})
    return out or None


@dataclass
class ToolRunResult:
    ok: bool
    message: str
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class EngineConfig:
    """Engine tuning; construct via `EngineConfig` from application settings (no defaults here)."""

    max_orchestrator_rounds: int
    max_finance_rounds: int
    max_context_messages: int | None


@dataclass
class UsageTotals:
    total_tokens: int = 0

    def add_usage_object(self, u: object | None) -> None:
        if u is None:
            return
        total = getattr(u, "total_tokens", None)
        if isinstance(total, int):
            self.total_tokens += total
            return
        pt = getattr(u, "prompt_tokens", None)
        ct = getattr(u, "completion_tokens", None)
        if isinstance(pt, int):
            self.total_tokens += pt
        if isinstance(ct, int):
            self.total_tokens += ct
