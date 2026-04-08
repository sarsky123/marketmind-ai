from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI
from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionMessageToolCallUnionParam,
)
from pydantic import TypeAdapter, ValidationError
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
    Citation,
    EngineConfig,
    ToolName,
    ToolRunResult,
    ToolWebRef,
    UsageTotals,
    parse_tool_name,
    parse_tool_web_refs,
)
from models import ChatMessage

_TOOL_CALLS_LIST_ADAPTER = TypeAdapter(list[ChatCompletionMessageToolCallUnionParam])
_CHAT_MESSAGES_LIST_ADAPTER = TypeAdapter(list[ChatCompletionMessageParam])


@dataclass
class _HistoryRow:
    role: str
    content: str | None
    tool_calls: list[ChatCompletionMessageToolCallUnionParam] | None = None
    tool_call_id: str | None = None


class _IncrementalChatHistory:
    """Maintains bounded chat rows and lazily builds OpenAI-compatible messages."""

    def __init__(self, *, system_prompt: str, max_messages: int | None) -> None:
        self._system_prompt = system_prompt
        self._max_messages = max_messages
        self._rows: list[_HistoryRow] = []
        self._tool_response_ids: set[str] = set()
        self._cache: list[ChatCompletionMessageParam] | None = None

    def hydrate(self, rows: list[ChatMessage]) -> None:
        for row in rows:
            self.append_row(
                role=row.role,
                content=row.content,
                tool_calls=row.tool_calls if _is_openai_tool_calls_param_list(row.tool_calls) else None,
                tool_call_id=row.tool_call_id,
            )

    def append_row(
        self,
        *,
        role: str,
        content: str | None,
        tool_calls: list[ChatCompletionMessageToolCallUnionParam] | None = None,
        tool_call_id: str | None = None,
    ) -> None:
        self._rows.append(
            _HistoryRow(
                role=role,
                content=content,
                tool_calls=tool_calls,
                tool_call_id=tool_call_id,
            )
        )
        if role == "tool" and isinstance(tool_call_id, str) and tool_call_id:
            self._tool_response_ids.add(tool_call_id)
        self._trim_window_if_needed()
        self._cache = None

    def build_messages(self) -> list[ChatCompletionMessageParam]:
        if self._cache is not None:
            return self._cache

        msgs: list[dict[str, Any]] = [{"role": "system", "content": self._system_prompt}]
        for row in self._rows:
            if row.role == "tool":
                msgs.append(
                    {
                        "role": "tool",
                        "content": row.content or "",
                        "tool_call_id": row.tool_call_id or "",
                    }
                )
                continue
            if row.role == "assistant" and row.tool_calls:
                assistant_call_ids = [
                    str(tc.get("id"))
                    for tc in row.tool_calls
                    if isinstance(tc, dict) and isinstance(tc.get("id"), str) and tc.get("id")
                ]
                missing_ids = [
                    tcid for tcid in assistant_call_ids if tcid not in self._tool_response_ids
                ]
                if missing_ids:
                    # Corrupted history guard: send this as a plain assistant text turn.
                    msgs.append({"role": "assistant", "content": row.content or ""})
                    continue
                msgs.append(
                    {
                        "role": "assistant",
                        "content": row.content,
                        "tool_calls": row.tool_calls,
                    }
                )
                continue
            msgs.append({"role": row.role, "content": row.content or ""})

        self._cache = _CHAT_MESSAGES_LIST_ADAPTER.validate_python(msgs)
        return self._cache

    def _trim_window_if_needed(self) -> None:
        if self._max_messages is None:
            return
        while len(self._rows) > self._max_messages:
            dropped = self._rows.pop(0)
            if dropped.role == "tool" and isinstance(dropped.tool_call_id, str) and dropped.tool_call_id:
                self._tool_response_ids.discard(dropped.tool_call_id)


def _usage_add(usage: UsageTotals, completion: Any) -> None:
    usage.add_usage_object(getattr(completion, "usage", None))


def _tool_calls_to_stored(message: Any) -> list[ChatCompletionMessageToolCallUnionParam]:
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
    return _TOOL_CALLS_LIST_ADAPTER.validate_python(out)


def _is_openai_tool_calls_param_list(raw: object) -> bool:
    """True when ``raw`` is non-empty and validates as OpenAI chat ``tool_calls`` params."""
    if not isinstance(raw, list) or len(raw) == 0:
        return False
    try:
        _TOOL_CALLS_LIST_ADAPTER.validate_python(raw)
    except ValidationError:
        return False
    return True


def _merge_citation_refs(citations: list[Citation], refs: list[ToolWebRef]) -> None:
    existing_urls = {c["url"] for c in citations}
    for ref in refs:
        title = ref["title"].strip()
        url = ref["url"].strip()
        if not title or not url or url in existing_urls:
            continue
        citations.append({"index": len(citations) + 1, "title": title, "url": url})
        existing_urls.add(url)


def _humanize_tool_name(tool_name: str) -> str:
    labels = {
        "search_web": "Web Search",
        "get_asset_price": "Market Data",
        "clarify_intent": "Clarification",
        "consult_finance_agent": "Finance Expert",
        "set_session_title": "Chat title",
    }
    if tool_name in labels:
        return labels[tool_name]
    return tool_name.replace("_", " ").strip().title() or "Tool"


def _status_event(
    *,
    message: str,
    tool: str = "",
    stage: str = "",
    tool_display: str = "",
    agent: str = "",
) -> dict[str, str]:
    return {
        "kind": "status",
        "message": message,
        "tool": tool,
        "stage": stage,
        "tool_display": tool_display,
        "agent": agent,
    }


def format_history_for_openai(
    rows: list[ChatMessage],
    system_prompt: str,
    max_messages: int | None,
) -> list[ChatCompletionMessageParam]:
    history = _IncrementalChatHistory(system_prompt=system_prompt, max_messages=max_messages)
    history.hydrate(rows)
    return history.build_messages()


async def run_finance_expert(
    *,
    ctx: RuntimeContext,
    perm: ToolPermissionContext,
    client: AsyncOpenAI,
    specific_task: str,
    config: EngineConfig,
    trace: EngineTrace,
) -> AsyncIterator[dict[str, Any]]:
    """Tight isolation: [system, user task] only; inner tool loop; no DB history."""
    history = _IncrementalChatHistory(
        system_prompt=get_finance_expert_system_prompt(),
        max_messages=None,
    )
    history.append_row(role="user", content=specific_task)
    tools = get_openai_tools_for_finance_expert(perm)
    usage = UsageTotals()
    citations: list[Citation] = []
    yield _status_event(
        message="Getting financial resources for you...",
        tool=str(ToolName.CONSULT_FINANCE_AGENT),
        stage="subagent_start",
        tool_display="Finance Analysis",
        agent="finance_expert",
    )
    rounds = 0
    while rounds < config.max_finance_rounds:
        rounds += 1
        trace.add("finance_expert_round", str(rounds))
        yield _status_event(
            message=f"Analyzing financial context (pass {rounds})...",
            tool=str(ToolName.CONSULT_FINANCE_AGENT),
            stage="subagent_thinking",
            tool_display="Finance Analysis",
            agent="finance_expert",
        )
        round_messages = history.build_messages()
        trace.add("finance_context_messages", str(len(round_messages)))
        completion = await client.chat.completions.create(
            model=ctx.finance_model,
            messages=round_messages,
            tools=tools,
            tool_choice="auto",
        )
        choice = completion.choices[0].message
        _usage_add(usage, completion)
        if choice.tool_calls:
            stored = _tool_calls_to_stored(choice)
            history.append_row(
                role="assistant",
                content=choice.content,
                tool_calls=stored,
            )
            for tc in choice.tool_calls:
                name = tc.function.name
                args = tc.function.arguments or "{}"
                trace.add("finance_tool", name)
                tool_display = _humanize_tool_name(name)
                yield _status_event(
                    message=f"Getting {tool_display.lower()}...",
                    tool=name,
                    stage="subagent_tool_start",
                    tool_display=tool_display,
                    agent="finance_expert",
                )
                tr = await dispatch_registry_tool(name, args, ctx)
                _merge_citation_refs(citations, parse_tool_web_refs(tr.meta.get("refs")))
                if tr.ok:
                    yield _status_event(
                        message=f"{tool_display} complete.",
                        tool=name,
                        stage="subagent_tool_done",
                        tool_display=tool_display,
                        agent="finance_expert",
                    )
                else:
                    yield _status_event(
                        message=f"{tool_display} had an issue. Continuing...",
                        tool=name,
                        stage="subagent_tool_error",
                        tool_display=tool_display,
                        agent="finance_expert",
                    )
                content = tr.message if tr.ok else f"Tool error: {tr.message}"
                history.append_row(
                    role="tool",
                    tool_call_id=tc.id,
                    content=content,
                )
            continue
        yield {
            "kind": "finance_result",
            "summary": choice.content or "",
            "usage_total_tokens": usage.total_tokens,
            "citations": citations,
        }
        return
    yield {
        "kind": "finance_result",
        "summary": "Finance expert stopped after maximum iterations without a final answer.",
        "usage_total_tokens": usage.total_tokens,
        "citations": citations,
    }


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
    citations: list[Citation] = []

    if not ctx.openai_api_key:
        yield {
            "kind": "error",
            "message": "OPENAI_API_KEY is not set.",
            "code": 500,
        }
        return

    client = AsyncOpenAI(api_key=ctx.openai_api_key)
    tools = get_openai_tools_for_orchestrator(perm)

    yield _status_event(message="Loading conversation...", stage="load_history")
    rows = await repo.list_messages(session_id)
    is_first_user_turn = len(rows) == 0
    history = _IncrementalChatHistory(
        system_prompt=get_orchestrator_system_prompt(),
        max_messages=config.max_context_messages,
    )
    history.hydrate(rows)
    await repo.add_message(session_id, "user", user_message)
    await repo.touch_session(session_id)
    await db_session.commit()
    history.append_row(role="user", content=user_message)

    yield _status_event(message="Thinking...", stage="thinking")

    iteration = 0
    final_text: str | None = None
    pending_forced_title = is_first_user_turn

    while iteration < config.max_orchestrator_rounds:
        iteration += 1
        oai_messages = history.build_messages()
        trace.add("orchestrator_context_messages", str(len(oai_messages)))

        force_title_round = pending_forced_title
        round_tools = [
            spec
            for spec in tools
            if pending_forced_title
            or (spec.get("function") or {}).get("name")
            != str(ToolName.SET_SESSION_TITLE)
        ]

        tool_choice: str | dict[str, Any] = "auto"
        if force_title_round:
            tool_choice = {
                "type": "function",
                "function": {"name": str(ToolName.SET_SESSION_TITLE)},
            }
        completion = await client.chat.completions.create(
            model=ctx.orchestrator_model,
            messages=oai_messages,
            tools=round_tools,
            tool_choice=tool_choice,
        )
        msg = completion.choices[0].message
        _usage_add(usage_total, completion)

        if force_title_round and not msg.tool_calls:
            pending_forced_title = False
            fallback = (user_message or "").strip()
            if fallback:
                safe_title = fallback[:120]
                await repo.update_session_title(session_id, safe_title)
                await db_session.commit()
                yield {"kind": "session_title", "title": safe_title}

        if msg.tool_calls:
            stored_calls = _tool_calls_to_stored(msg)
            await repo.add_message(
                session_id,
                "assistant",
                msg.content,
                tool_calls=stored_calls,
                tool_call_id=None,
            )
            await db_session.commit()
            history.append_row(role="assistant", content=msg.content, tool_calls=stored_calls)

            for tc in msg.tool_calls:
                name_str = tc.function.name
                args = tc.function.arguments or "{}"
                tool_enum = parse_tool_name(name_str)
                tool_display = _humanize_tool_name(name_str)
                yield _status_event(
                    message=f"Running {tool_display}...",
                    tool=name_str,
                    stage="tool_start",
                    tool_display=tool_display,
                )

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
                            summary = ""
                            fin_usage_tokens = 0
                            fin_citations: list[Citation] = []
                            async for fin_ev in run_finance_expert(
                                ctx=ctx,
                                perm=perm,
                                client=client,
                                specific_task=task,
                                config=config,
                                trace=trace,
                            ):
                                if fin_ev.get("kind") == "status":
                                    yield fin_ev
                                elif fin_ev.get("kind") == "finance_result":
                                    summary = str(fin_ev.get("summary", ""))
                                    fin_usage_tokens = int(fin_ev.get("usage_total_tokens", 0))
                                    raw_citations = fin_ev.get("citations", [])
                                    if isinstance(raw_citations, list):
                                        fin_citations = [
                                            c
                                            for c in raw_citations
                                            if isinstance(c, dict)
                                            and isinstance(c.get("title"), str)
                                            and isinstance(c.get("url"), str)
                                            and isinstance(c.get("index"), int)
                                        ]
                        except Exception as exc:  # noqa: BLE001
                            tr = ToolRunResult(
                                ok=False,
                                message=f"Finance expert failed: {exc}",
                                meta={},
                            )
                        else:
                            usage_total.total_tokens += fin_usage_tokens
                            finance_refs: list[ToolWebRef] = [
                                {"title": c["title"], "url": c["url"]} for c in fin_citations
                            ]
                            tr = ToolRunResult(
                                ok=True,
                                message=summary,
                                meta={"refs": finance_refs},
                            )
                elif tool_enum is ToolName.SET_SESSION_TITLE:
                    try:
                        parsed = json.loads(args) if args else {}
                    except json.JSONDecodeError:
                        tr = ToolRunResult(
                            ok=False,
                            message=f"Invalid JSON for {ToolName.SET_SESSION_TITLE}",
                            meta={},
                        )
                    else:
                        raw_title = str(parsed.get("title", "")).strip()
                        if not raw_title:
                            tr = ToolRunResult(
                                ok=False,
                                message="Title must be non-empty.",
                                meta={},
                            )
                        else:
                            safe_title = raw_title[:120]
                            await repo.update_session_title(session_id, safe_title)
                            await db_session.commit()
                            yield {"kind": "session_title", "title": safe_title}
                            tr = ToolRunResult(ok=True, message="Title updated.", meta={})
                elif tool_enum is None:
                    tr = ToolRunResult(
                        ok=False,
                        message=f"Unknown tool: {name_str}",
                        meta={},
                    )
                else:
                    tr = await dispatch_registry_tool(name_str, args, ctx)

                _merge_citation_refs(citations, parse_tool_web_refs(tr.meta.get("refs")))
                tool_content = tr.message if tr.ok else f"Error: {tr.message}"
                await repo.add_message(
                    session_id,
                    "tool",
                    tool_content,
                    tool_calls=None,
                    tool_call_id=tc.id,
                )
                await db_session.commit()
                history.append_row(
                    role="tool",
                    content=tool_content,
                    tool_call_id=tc.id,
                )
            if force_title_round:
                pending_forced_title = False
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

    citation_payload: list[Citation] | None = None
    if citations:
        citation_payload = [
            {"index": c["index"], "title": c["title"], "url": c["url"]}
            for c in citations
        ]
    await repo.add_message(
        session_id,
        "assistant",
        final_text,
        tool_calls=citation_payload,
    )
    await db_session.commit()

    chunk_size = 24
    for i in range(0, len(final_text), chunk_size):
        yield {"kind": "token", "text": final_text[i : i + chunk_size]}

    yield {
        "kind": "done",
        "stop_reason": "completed",
        "usage": {"total_tokens": usage_total.total_tokens},
        "citations": citations,
    }


def map_engine_event_to_sse(event: dict[str, Any]) -> tuple[str, object]:
    kind = event.get("kind")
    if kind == "status":
        return "status", {
            "message": event.get("message", ""),
            "tool": event.get("tool", "") or "",
            "stage": event.get("stage", "") or "",
            "tool_display": event.get("tool_display", "") or "",
            "agent": event.get("agent", "") or "",
        }
    if kind == "token":
        return "token", event.get("text", "")
    if kind == "session_title":
        return "session_title", {"title": str(event.get("title", ""))}
    if kind == "done":
        return "done", {
            "stop_reason": event.get("stop_reason", "completed"),
            "usage": event.get("usage", {}),
            "citations": event.get("citations", []),
        }
    if kind == "error":
        return "error", {
            "message": event.get("message", "Unknown error"),
            "code": int(event.get("code", 500)),
        }
    return "status", {"message": str(event), "tool": ""}
