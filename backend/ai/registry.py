from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from openai.types.chat import ChatCompletionToolParam
from pydantic import TypeAdapter

from ai.context import RuntimeContext
from ai.permissions import ToolPermissionContext, filter_openai_tools
from ai.tools import (
    tool_clarify_intent,
    tool_get_asset_price,
    tool_search_web,
)
from ai.types import ToolName, ToolRunResult, parse_tool_name

ToolHandler = Callable[[RuntimeContext, dict[str, Any]], Awaitable[ToolRunResult]]

_ALL_OPENAI_TOOL_SCHEMAS: list[ChatCompletionToolParam] = TypeAdapter(
    list[ChatCompletionToolParam]
).validate_python([
    {
        "type": "function",
        "function": {
            "name": ToolName.SEARCH_WEB,
            "description": "Search the web for recent news and context (Tavily).",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Search query"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": ToolName.GET_ASSET_PRICE,
            "description": "Look up a recent price for a ticker symbol (yfinance).",
            "parameters": {
                "type": "object",
                "properties": {
                    "ticker": {"type": "string", "description": "Ticker symbol e.g. AAPL"},
                },
                "required": ["ticker"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": ToolName.CLARIFY_INTENT,
            "description": (
                "Ask the user ONE concise clarifying question, only if the request is truly underspecified "
                "and you cannot proceed with a safe, reasonable assumption."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "clarification_question": {
                        "type": "string",
                        "description": "Question to ask the user",
                    },
                },
                "required": ["clarification_question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": ToolName.CONSULT_FINANCE_AGENT,
            "description": (
                "CRITICAL: You MUST use this tool to delegate ANY questions related to "
                "stock prices, quantitative financial analysis, macroeconomic data, or market trends "
                "to the dedicated Finance Expert. Do not attempt to answer deep financial questions yourself "
                "or rely solely on web search."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "specific_task": {
                        "type": "string",
                        "description": (
                            "A highly detailed instruction for the finance expert. "
                            "Include specific tickers (if known), timeframes, and the exact analytical goal. "
                            "Example: 'Fetch the current price of AAPL and summarize its recent market performance.'"
                        ),
                    },
                },
                "required": ["specific_task"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": ToolName.SET_SESSION_TITLE,
            "description": (
                "Set a short, scannable chat title (summary of the user's request). "
                "Use 3–8 words, title case or sentence case, no surrounding quotes. "
                "The system requires this on the first message of a brand-new chat before you do anything else."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Concise topic label for the sidebar and header (max ~80 characters).",
                    },
                },
                "required": ["title"],
            },
        },
    },
])

_HANDLERS: dict[ToolName, ToolHandler] = {
    ToolName.SEARCH_WEB: lambda ctx, a: tool_search_web(ctx, str(a["query"])),
    ToolName.GET_ASSET_PRICE: lambda ctx, a: tool_get_asset_price(ctx, str(a["ticker"])),
    ToolName.CLARIFY_INTENT: lambda ctx, a: tool_clarify_intent(
        ctx, str(a["clarification_question"])
    ),
}


def get_openai_tools_for_orchestrator(ctx: ToolPermissionContext) -> list[ChatCompletionToolParam]:
    return filter_openai_tools(_ALL_OPENAI_TOOL_SCHEMAS, "orchestrator", ctx)


def get_openai_tools_for_finance_expert(ctx: ToolPermissionContext) -> list[ChatCompletionToolParam]:
    return filter_openai_tools(_ALL_OPENAI_TOOL_SCHEMAS, "finance_expert", ctx)


async def dispatch_registry_tool(
    name: str,
    arguments_json: str,
    ctx: RuntimeContext,
) -> ToolRunResult:
    tn = parse_tool_name(name)
    if tn is None:
        return ToolRunResult(ok=False, message=f"Unknown tool: {name}", meta={})
    if tn is ToolName.CONSULT_FINANCE_AGENT:
        return ToolRunResult(ok=False, message="handled by orchestrator", meta={})
    if tn is ToolName.SET_SESSION_TITLE:
        return ToolRunResult(ok=False, message="handled by orchestrator", meta={})
    handler = _HANDLERS.get(tn)
    if handler is None:
        return ToolRunResult(ok=False, message=f"Unknown tool: {name}", meta={})
    try:
        args = json.loads(arguments_json) if arguments_json else {}
    except json.JSONDecodeError as exc:
        return ToolRunResult(ok=False, message=f"Invalid JSON arguments: {exc}", meta={})
    if not isinstance(args, dict):
        return ToolRunResult(ok=False, message="Tool arguments must be a JSON object", meta={})
    return await handler(ctx, args)
