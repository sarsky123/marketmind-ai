from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from ai.context import RuntimeContext
from ai.permissions import ToolPermissionContext
from ai.prompts import get_finance_expert_system_prompt, get_orchestrator_system_prompt
from ai.registry import (
    dispatch_registry_tool,
    get_openai_tools_for_finance_expert,
    get_openai_tools_for_orchestrator,
)
from ai.repository import ChatRepository
from ai.trace import EngineTrace
from ai.types import (
    EngineConfig,
    ToolName,
    ToolRunResult,
    UsageTotals,
    parse_tool_name,
)
from models import ChatMessage


def _usage_add(usage: UsageTotals, completion: Any) -> None:
    usage.add_usage_object(getattr(completion, "usage", None))


def _tool_calls_to_stored(message: Any) -> list[dict[str, Any]]:
    raw = getattr(message, "tool_calls", None) or []
    out: list[dict[str, Any]] = []
    for tc in raw:
        fn = getattr(tc, "function", None)
        if fn is None:
            continue
        out.append(
            {
                "id": getattr(tc, "id", ""),
                "type": "function",
                "function": {
                    "name": getattr(fn, "name", ""),
                    "arguments": getattr(fn, "arguments", "") or "{}",
                },
            }
        )
    return out


def format_history_for_openai(
    rows: list[ChatMessage],
    system_prompt: str,
    max_messages: int | None,
) -> list[dict[str, Any]]:
    msgs: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    slice_rows = rows
    if max_messages is not None and len(rows) > max_messages:
        slice_rows = rows[-max_messages:]
    for m in slice_rows:
        if m.role == "tool":
            msgs.append(
                {
                    "role": "tool",
                    "content": m.content or "",
                    "tool_call_id": m.tool_call_id or "",
                }
            )
        elif m.role == "assistant" and m.tool_calls:
            msgs.append(
                {
                    "role": "assistant",
                    "content": m.content,
                    "tool_calls": m.tool_calls,
                }
            )
        else:
            msgs.append({"role": m.role, "content": m.content or ""})
    return msgs


async def run_finance_expert(
    *,
    ctx: RuntimeContext,
    perm: ToolPermissionContext,
    client: AsyncOpenAI,
    specific_task: str,
    config: EngineConfig,
    trace: EngineTrace,
) -> tuple[str, UsageTotals]:
    """Tight isolation: [system, user task] only; inner tool loop; no DB history."""
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": get_finance_expert_system_prompt()},
        {"role": "user", "content": specific_task},
    ]
    tools = get_openai_tools_for_finance_expert(perm)
    usage = UsageTotals()
    rounds = 0
    while rounds < config.max_finance_rounds:
        rounds += 1
        trace.add("finance_expert_round", str(rounds))
        completion = await client.chat.completions.create(
            model=ctx.finance_model,
            messages=messages,
            tools=tools,
            tool_choice="auto",
        )
        choice = completion.choices[0].message
        _usage_add(usage, completion)
        if choice.tool_calls:
            stored = _tool_calls_to_stored(choice)
            messages.append(
                {
                    "role": "assistant",
                    "content": choice.content,
                    "tool_calls": stored,
                }
            )
            for tc in choice.tool_calls:
                name = tc.function.name
                args = tc.function.arguments or "{}"
                trace.add("finance_tool", name)
                tr = await dispatch_registry_tool(name, args, ctx)
                content = tr.message if tr.ok else f"Tool error: {tr.message}"
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": content,
                    }
                )
            continue
        return choice.content or "", usage
    return (
        "Finance expert stopped after maximum iterations without a final answer.",
        usage,
    )


async def run_orchestrator(
    *,
    db_session: AsyncSession,
    repo: ChatRepository,
    ctx: RuntimeContext,
    session_id: uuid.UUID,
    user_message: str,
    config: EngineConfig,
    perm: ToolPermissionContext | None = None,
) -> AsyncIterator[dict[str, Any]]:
    perm = perm or ToolPermissionContext()
    trace = EngineTrace()
    usage_total = UsageTotals()

    if not ctx.openai_api_key:
        yield {
            "kind": "error",
            "message": "OPENAI_API_KEY is not set.",
            "code": 500,
        }
        return

    client = AsyncOpenAI(api_key=ctx.openai_api_key)
    tools = get_openai_tools_for_orchestrator(perm)

    yield {"kind": "status", "message": "Loading conversation…", "tool": ""}
    rows = await repo.list_messages(session_id)
    await repo.add_message(session_id, "user", user_message)
    await db_session.commit()

    yield {"kind": "status", "message": "Thinking…", "tool": ""}

    iteration = 0
    final_text: str | None = None

    while iteration < config.max_orchestrator_rounds:
        iteration += 1
        rows = await repo.list_messages(session_id)
        oai_messages = format_history_for_openai(
            rows,
            get_orchestrator_system_prompt(),
            config.max_context_messages,
        )

        completion = await client.chat.completions.create(
            model=ctx.orchestrator_model,
            messages=oai_messages,
            tools=tools,
            tool_choice="auto",
        )
        msg = completion.choices[0].message
        _usage_add(usage_total, completion)

        if msg.tool_calls:
            await repo.add_message(
                session_id,
                "assistant",
                msg.content,
                tool_calls=_tool_calls_to_stored(msg),
                tool_call_id=None,
            )
            await db_session.commit()

            for tc in msg.tool_calls:
                name_str = tc.function.name
                args = tc.function.arguments or "{}"
                tool_enum = parse_tool_name(name_str)
                yield {
                    "kind": "status",
                    "message": f"Running {name_str}…",
                    "tool": name_str,
                }

                if tool_enum is ToolName.CONSULT_FINANCE_AGENT:
                    try:
                        parsed = json.loads(args) if args else {}
                    except json.JSONDecodeError:
                        tr = ToolRunResult(
                            ok=False,
                            message=f"Invalid JSON for {ToolName.CONSULT_FINANCE_AGENT}",
                            meta={},
                        )
                    else:
                        task = str(parsed.get("specific_task", ""))
                        trace.add(str(ToolName.CONSULT_FINANCE_AGENT), task[:200])
                        try:
                            summary, u_fin = await run_finance_expert(
                                ctx=ctx,
                                perm=perm,
                                client=client,
                                specific_task=task,
                                config=config,
                                trace=trace,
                            )
                        except Exception as exc:  # noqa: BLE001
                            tr = ToolRunResult(
                                ok=False,
                                message=f"Finance expert failed: {exc}",
                                meta={},
                            )
                        else:
                            usage_total.total_tokens += u_fin.total_tokens
                            tr = ToolRunResult(ok=True, message=summary, meta={})
                elif tool_enum is None:
                    tr = ToolRunResult(
                        ok=False,
                        message=f"Unknown tool: {name_str}",
                        meta={},
                    )
                else:
                    tr = await dispatch_registry_tool(name_str, args, ctx)

                tool_content = tr.message if tr.ok else f"Error: {tr.message}"
                await repo.add_message(
                    session_id,
                    "tool",
                    tool_content,
                    tool_calls=None,
                    tool_call_id=tc.id,
                )
                await db_session.commit()
            continue

        final_text = msg.content or ""
        break

    if iteration >= config.max_orchestrator_rounds and final_text is None:
        yield {
            "kind": "error",
            "message": "Agent stopped: maximum tool rounds exceeded.",
            "code": 500,
        }
        return

    if final_text is None:
        final_text = ""

    await repo.add_message(session_id, "assistant", final_text)
    await db_session.commit()

    chunk_size = 24
    for i in range(0, len(final_text), chunk_size):
        yield {"kind": "token", "text": final_text[i : i + chunk_size]}

    yield {
        "kind": "done",
        "stop_reason": "completed",
        "usage": {"total_tokens": usage_total.total_tokens},
    }


def map_engine_event_to_sse(event: dict[str, Any]) -> tuple[str, object]:
    kind = event.get("kind")
    if kind == "status":
        return "status", {
            "message": event.get("message", ""),
            "tool": event.get("tool", "") or "",
        }
    if kind == "token":
        return "token", event.get("text", "")
    if kind == "done":
        return "done", {
            "stop_reason": event.get("stop_reason", "completed"),
            "usage": event.get("usage", {}),
        }
    if kind == "error":
        return "error", {
            "message": event.get("message", "Unknown error"),
            "code": int(event.get("code", 500)),
        }
    return "status", {"message": str(event), "tool": ""}
