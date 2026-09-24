"""question mode

Revision ID: 4f1c2a9d7e30
Revises: 2dc8f24e703a
Create Date: 2026-09-24 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4f1c2a9d7e30'
down_revision: Union[str, Sequence[str], None] = '2dc8f24e703a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """How often each question is asked and when its result is shown.

    Every existing question keeps running as before: two bouts, each result
    shown as soon as its round is halted.
    """
    op.add_column(
        "questions",
        sa.Column("mode", sa.String(length=16), server_default="twice", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("questions", "mode")
