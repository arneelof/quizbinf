"""A fixed address for the lecture that is running now: /live.

A session's own address (/s/<code>) is random and exists only once the teacher
has started the session, so it cannot be printed on slides prepared weeks
before. /live always leads to the newest session, which during a lecture is
the one the teacher has just started; slides can carry a single QR code for it.
/live/report does the same for the teacher's Report view, so a slide can link
to the projected results.

Only sessions started in the last LIVE_HOURS count, so an old session is never
picked up between lectures; with none, both go to the start page. Load-test
sessions never count.
"""

from datetime import timedelta

from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import QuizSession, utcnow

router = APIRouter(tags=["live"])

#: How old the newest session may be and still be "the lecture now".
LIVE_HOURS = 12


def newest_session(db: Session) -> QuizSession | None:
    since = utcnow() - timedelta(hours=LIVE_HOURS)
    return db.scalar(
        select(QuizSession)
        .where(QuizSession.is_loadtest.is_(False), QuizSession.created_at >= since)
        .order_by(QuizSession.created_at.desc(), QuizSession.id.desc())
        .limit(1)
    )


def _go(path: str) -> RedirectResponse:
    # 307, never cached: the target changes from one lecture to the next.
    return RedirectResponse(path, status_code=307, headers={"Cache-Control": "no-store"})


@router.get("/live", include_in_schema=False)
def live(db: Session = Depends(get_db)) -> RedirectResponse:
    session = newest_session(db)
    return _go(f"/s/{session.code}" if session else "/")


@router.get("/live/report", include_in_schema=False)
def live_report(db: Session = Depends(get_db)) -> RedirectResponse:
    session = newest_session(db)
    return _go(f"/teacher/session/{session.code}/report" if session else "/teacher")
