from __future__ import annotations

from dataclasses import dataclass, field

from openai.types.chat import ChatCompletionToolParam

from ai.types import AgentRole, ToolName, parse_tool_name


@dataclass
class ToolPermissionContext:
    """Future: per-user denies; V1: static role-based subsets."""

    denied_names: frozenset[ToolName] = field(default_factory=frozenset)


ORCHESTRATOR_TOOLS: frozenset[ToolName] = frozenset(
    {
        ToolName.SEARCH_WEB,
        ToolName.GET_ASSET_PRICE,
        ToolName.CLARIFY_INTENT,
        ToolName.CONSULT_FINANCE_AGENT,
        ToolName.SET_SESSION_TITLE,
    }
)
FINANCE_EXPERT_TOOLS: frozenset[ToolName] = frozenset(
    {
        ToolName.SEARCH_WEB,
        ToolName.GET_ASSET_PRICE,
    }
)


def allowed_tools_for_agent(role: AgentRole, ctx: ToolPermissionContext) -> frozenset[ToolName]:
    base = ORCHESTRATOR_TOOLS if role == "orchestrator" else FINANCE_EXPERT_TOOLS
    return frozenset(n for n in base if n not in ctx.denied_names)


def filter_openai_tools(
    schemas: list[ChatCompletionToolParam],
    role: AgentRole,
    ctx: ToolPermissionContext,
) -> list[ChatCompletionToolParam]:
    allowed = allowed_tools_for_agent(role, ctx)
    out: list[ChatCompletionToolParam] = []
    for spec in schemas:
        fn = spec.get("function")
        if fn is None:
            continue
        raw = fn.get("name")
        if not isinstance(raw, str):
            continue
        tn = parse_tool_name(raw)
        if tn is not None and tn in allowed:
            out.append(spec)
    return out
