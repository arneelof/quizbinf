"""competition sessions: time limit and nicknames

Revision ID: d4a8e2f61c37
Revises: b7e2c4d91a05
Create Date: 2026-10-22 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4a8e2f61c37'
down_revision: Union[str, Sequence[str], None] = 'b7e2c4d91a05'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Every existing session stays a peer-instruction one."""
    op.add_column(
        "sessions",
        sa.Column("is_competition", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column("sessions", sa.Column("time_limit", sa.Integer(), nullable=True))
    op.add_column(
        "session_participants", sa.Column("nickname", sa.String(length=24), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("session_participants", "nickname")
    op.drop_column("sessions", "time_limit")
    op.drop_column("sessions", "is_competition")
