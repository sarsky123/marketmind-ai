"""Initial no-op schema.

This walking-skeleton phase sets up Alembic/SQLModel wiring, but does not
introduce any tables yet.
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # No tables in walking skeleton yet.
    pass


def downgrade() -> None:
    # No tables in walking skeleton yet.
    pass

