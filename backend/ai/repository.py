from __future__ import annotations

import uuid
from typing import Any, Optional

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models import ChatMessage, ChatSession, User


class ChatRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @property
    def session(self) -> AsyncSession:
        return self._session

    async def ensure_user(self, user_id: uuid.UUID | None) -> uuid.UUID:
        if user_id is not None:
            u = await self._session.get(User, user_id)
            if u is not None:
                return user_id
        user = User()
        self._session.add(user)
        await self._session.flush()
        await self._session.refresh(user)
        return user.id

    async def create_session(self, user_id: uuid.UUID, title: str | None) -> ChatSession:
        sess = ChatSession(user_id=user_id, title=title)
        self._session.add(sess)
        await self._session.flush()
        await self._session.refresh(sess)
        return sess

    async def get_session(self, session_id: uuid.UUID) -> ChatSession | None:
        return await self._session.get(ChatSession, session_id)

    async def update_session_title(self, session_id: uuid.UUID, title: str) -> None:
        sess = await self._session.get(ChatSession, session_id)
        if sess is None:
            return
        sess.title = title
        await self._session.flush()

    async def delete_session_owned_by(
        self,
        session_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> bool:
        sess = await self._session.get(ChatSession, session_id)
        if sess is None or sess.user_id != user_id:
            return False
        await self._session.execute(
            delete(ChatMessage).where(ChatMessage.session_id == session_id),
        )
        await self._session.execute(
            delete(ChatSession).where(ChatSession.id == session_id),
        )
        await self._session.flush()
        return True

    async def list_sessions(self, user_id: uuid.UUID) -> list[ChatSession]:
        stmt = (
            select(ChatSession)
            .where(ChatSession.user_id == user_id)
            .order_by(ChatSession.created_at.desc())
        )
        result = await self._session.execute(stmt)
        return list(result.scalars().all())

    async def list_messages(self, session_id: uuid.UUID) -> list[ChatMessage]:
        stmt = (
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at)
        )
        result = await self._session.execute(stmt)
        return list(result.scalars().all())

    async def add_message(
        self,
        session_id: uuid.UUID,
        role: str,
        content: str | None,
        tool_calls: Optional[list[dict[str, Any]]] = None,
        tool_call_id: str | None = None,
    ) -> ChatMessage:
        msg = ChatMessage(
            session_id=session_id,
            role=role,
            content=content,
            tool_calls=tool_calls,
            tool_call_id=tool_call_id,
        )
        self._session.add(msg)
        await self._session.flush()
        await self._session.refresh(msg)
        return msg
