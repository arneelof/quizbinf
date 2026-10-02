"""anonymous sessions and guest users

Revision ID: 9c3d1f7a2b64
Revises: 4f1c2a9d7e30
Create Date: 2026-10-02 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9c3d1f7a2b64'
down_revision: Union[str, Sequence[str], None] = '4f1c2a9d7e30'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Every existing session stays a logged-in one, every user a real one."""
    op.add_column(
        "sessions",
        sa.Column("is_anonymous", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "users",
        sa.Column("is_guest", sa.Boolean(), server_default=sa.false(), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("users", "is_guest")
    op.drop_column("sessions", "is_anonymous")
