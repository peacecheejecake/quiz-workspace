"""Visibility of bank practice sessions across personal reset boundaries."""

from typing import Any

from sqlalchemy import exists, select

from quiz_api.repositories.tables import practice_reset_epochs, practice_sessions


def current_session(session: Any = practice_sessions) -> Any:
    """Session is visible until its owner's question epoch advances."""
    epochs = practice_reset_epochs
    return ~exists(
        select(1).where(
            epochs.c.user_id == session.c.user_id,
            epochs.c.question_id == session.c.question_id,
            epochs.c.epoch > session.c.reset_epoch,
        )
    )
