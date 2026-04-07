from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class EngineTrace:
    """Append-only log for status UI and debugging (not sent to OpenAI)."""

    entries: list[tuple[str, str]] = field(default_factory=list)

    def add(self, title: str, detail: str = "") -> None:
        self.entries.append((title, detail))
