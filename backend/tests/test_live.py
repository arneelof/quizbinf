"""/live: one fixed address for the lecture running now, for a QR code on slides."""

from datetime import timedelta

from app.db import SessionLocal, writing
from app.models import QuizSession
from tests.conftest import make_quiz_with_question


def test_live_leads_to_the_newest_session(teacher_client):
    quiz_id, _, _ = make_quiz_with_question(teacher_client)
    teacher_client.post(f"/api/sessions?quiz_id={quiz_id}")
    newest = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]

    resp = teacher_client.get("/live", follow_redirects=False)
    assert resp.status_code == 307 and resp.headers["location"] == f"/s/{newest}"
    assert resp.headers["cache-control"] == "no-store"
    report = teacher_client.get("/live/report", follow_redirects=False)
    assert report.headers["location"] == f"/teacher/session/{newest}/report"


def test_an_old_session_is_not_the_lecture_now(teacher_client):
    quiz_id, _, _ = make_quiz_with_question(teacher_client)
    code = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]
    with SessionLocal() as db, writing(db):
        s = db.query(QuizSession).filter_by(code=code).one()
        s.created_at = s.created_at - timedelta(days=2)
        db.commit()
    resp = teacher_client.get("/live", follow_redirects=False)
    assert resp.headers["location"] == "/"


def test_live_needs_no_login(client):
    assert client.get("/live", follow_redirects=False).status_code == 307
