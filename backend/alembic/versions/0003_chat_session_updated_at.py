"""Add chat_sessions.updated_at and index for session list sorting."""

from alembic import op
import sqlalchemy as sa

revision = "0003_chat_session_updated_at"
down_revision = "0002_user_chat_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE chat_sessions SET updated_at = created_at WHERE updated_at IS NULL")
    op.alter_column("chat_sessions", "updated_at", nullable=False)
    op.create_index(
        "ix_chat_sessions_user_id_updated_at",
        "chat_sessions",
        ["user_id", "updated_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_chat_sessions_user_id_updated_at", table_name="chat_sessions")
    op.drop_column("chat_sessions", "updated_at")
