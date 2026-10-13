"""question kinds

Revision ID: b7e2c4d91a05
Revises: 9c3d1f7a2b64
Create Date: 2026-10-13 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7e2c4d91a05'
down_revision: Union[str, Sequence[str], None] = '9c3d1f7a2b64'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Questions that are not multiple choice: numbers, scales, words, text,
    rankings, several choices, a tap on a figure.

    Every existing question stays a `choice` question with no settings, and
    every existing answer keeps its choice id.
    """
    op.add_column(
        "questions",
        sa.Column("kind", sa.String(length=16), server_default="choice", nullable=False),
    )
    op.add_column("questions", sa.Column("settings", sa.Text(), nullable=True))
    op.add_column("answers", sa.Column("value", sa.Text(), nullable=True))
    op.add_column(
        "answers",
        sa.Column("hidden", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    # Batch mode: SQLite cannot drop NOT NULL in place.
    with op.batch_alter_table("answers") as batch:
        batch.alter_column("choice_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM answers WHERE choice_id IS NULL")
    with op.batch_alter_table("answers") as batch:
        batch.alter_column("choice_id", existing_type=sa.Integer(), nullable=False)
    op.drop_column("answers", "hidden")
    op.drop_column("answers", "value")
    op.drop_column("questions", "settings")
    op.drop_column("questions", "kind")
