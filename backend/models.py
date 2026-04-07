"""SQLModel persistence: users, chat sessions, messages (OpenAI-shaped tool metadata)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import Column, Text
from sqlalchemy.dialects.postgresql import JSON
from sqlmodel import Field, Relationship, SQLModel


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    email: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)

    sessions: list["ChatSession"] = Relationship(back_populates="user")


class ChatSession(SQLModel, table=True):
    __tablename__ = "chat_sessions"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: uuid.UUID = Field(foreign_key="users.id")
    title: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=utc_now)

    user: Optional[User] = Relationship(back_populates="sessions")
    messages: list["ChatMessage"] = Relationship(back_populates="session")


class ChatMessage(SQLModel, table=True):
    __tablename__ = "chat_messages"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    session_id: uuid.UUID = Field(foreign_key="chat_sessions.id", index=True)
    role: str = Field(index=True)
    content: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    tool_calls: Optional[list[dict[str, Any]]] = Field(
        default=None,
        sa_column=Column(JSON, nullable=True),
    )
    tool_call_id: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)

    session: Optional[ChatSession] = Relationship(back_populates="messages")
