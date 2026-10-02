"""Shared quizzes (every teacher runs every quiz) and anonymous sessions.

Shared quizzes is a deployment setting, for a course taught by several
teachers together. Anonymous is a per-session choice: students join without
logging in, each browser answers as a throwaway guest, and the session stays
out of everything that names students.
"""

import pytest
from fastapi.testclient import TestClient

from app.auth import COOKIE_NAME, guest_cookie_name
from app.config import get_settings
from app.main import app
from tests.conftest import login, make_quiz_with_question


@pytest.fixture
def colleague(monkeypatch):
    """A second teacher, logged in; `shared` turns shared quizzes on."""

    def make(shared: bool) -> TestClient:
        monkeypatch.setenv("TEACHER_USERNAMES", "teach,petras")
        monkeypatch.setenv("SHARED_QUIZZES", "true" if shared else "false")
        get_settings.cache_clear()
        c = TestClient(app)
        login(c, "petras")
        return c

    yield make
    # monkeypatch restores the variables; the cache must be dropped too, or
    # later tests keep the widened allowlist.
    monkeypatch.undo()
    get_settings.cache_clear()


def _open(teacher_client, anonymous: bool = False):
    quiz_id, qid, choice_ids = make_quiz_with_question(teacher_client)
    flag = "&anonymous=true" if anonymous else ""
    resp = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}{flag}")
    assert resp.status_code == 201
    assert resp.json()["is_anonymous"] is anonymous
    code = resp.json()["code"]
    rid = teacher_client.post(
        f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "pre"}
    ).json()["id"]
    return quiz_id, code, qid, choice_ids, rid


# --- shared quizzes ---------------------------------------------------------


def test_without_sharing_a_colleague_sees_nothing(teacher_client, colleague):
    quiz_id, code, *_ = _open(teacher_client)
    petras = colleague(shared=False)
    assert petras.get("/api/quizzes").json() == []
    assert petras.get(f"/api/quizzes/{quiz_id}").status_code in (403, 404)
    assert petras.get(f"/api/sessions/{code}/live").status_code == 403


def test_with_sharing_a_colleague_sees_and_runs_every_quiz(teacher_client, colleague):
    quiz_id, code, qid, choice_ids, rid = _open(teacher_client)
    petras = colleague(shared=True)

    assert [q["id"] for q in petras.get("/api/quizzes").json()] == [quiz_id]
    assert petras.get(f"/api/quizzes/{quiz_id}").status_code == 200
    # ...and can drive a lecture of it, including one already running.
    assert petras.get(f"/api/sessions/{code}/live").status_code == 200
    assert petras.post(f"/api/sessions/{code}/rounds/{rid}/close").status_code == 200
    assert petras.post(f"/api/sessions?quiz_id={quiz_id}").status_code == 201


def test_a_colleague_watching_is_not_counted_as_a_student(teacher_client, colleague):
    _, code, *_ = _open(teacher_client)
    petras = colleague(shared=True)
    petras.get(f"/api/sessions/{code}/state")
    assert teacher_client.get(f"/api/sessions/{code}/participants").json()["joined"] == 0


def test_sharing_does_not_make_students_teachers(teacher_client, colleague, make_client):
    colleague(shared=True)
    student = make_client()
    login(student, "anna")
    assert student.get("/api/quizzes").status_code == 403


# --- anonymous sessions -----------------------------------------------------


def test_anonymous_is_off_unless_asked_for(teacher_client, client):
    _, code, _, choice_ids, _ = _open(teacher_client)
    assert client.get(f"/api/sessions/{code}/state").status_code == 401
    resp = client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]})
    assert resp.status_code == 401


def test_a_student_answers_without_logging_in(teacher_client, client):
    _, code, _, choice_ids, rid = _open(teacher_client, anonymous=True)

    state = client.get(f"/api/sessions/{code}/state")
    assert state.status_code == 200
    assert state.json()["anonymous"] is True
    assert client.cookies.get(guest_cookie_name(code))

    resp = client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]})
    assert resp.status_code == 200
    # Changing the answer keeps one vote: the cookie is the same guest.
    client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[1]})
    hist = teacher_client.get(f"/api/sessions/{code}/rounds/{rid}/histogram").json()
    assert hist["total"] == 1
    assert hist["counts"][str(choice_ids[1])] == 1
    assert client.get(f"/api/sessions/{code}/state").json()["my_choice_id"] == choice_ids[1]


def test_each_browser_is_its_own_guest(teacher_client, make_client):
    _, code, _, choice_ids, rid = _open(teacher_client, anonymous=True)
    for i in range(3):
        browser = make_client()
        browser.get(f"/api/sessions/{code}/state")  # opening it is joining
        browser.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[i]})
    hist = teacher_client.get(f"/api/sessions/{code}/rounds/{rid}/histogram").json()
    assert hist["total"] == 3
    assert teacher_client.get(f"/api/sessions/{code}/participants").json()["joined"] == 3


def test_a_logged_in_student_still_answers_as_a_guest(teacher_client, make_client):
    """The real login is neither used nor replaced."""
    _, code, _, choice_ids, _ = _open(teacher_client, anonymous=True)
    student = make_client()
    login(student, "anna")
    login_cookie = student.cookies.get(COOKIE_NAME)

    student.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]})
    assert student.cookies.get(COOKIE_NAME) == login_cookie
    assert student.get("/api/auth/me").json()["username"] == "anna"

    report = teacher_client.get(f"/api/sessions/{code}/participation").json()
    assert report["rows"] == []
    semester = teacher_client.get("/api/reports/participation").json()
    assert semester["sessions"] == []
    assert all(r["username"] != "anna" for r in semester["students"])


def test_a_guest_cookie_is_good_for_its_own_session_only(teacher_client, client):
    _, first, *_ = _open(teacher_client, anonymous=True)
    _, second, _, choice_ids, rid = _open(teacher_client, anonymous=True)
    client.get(f"/api/sessions/{first}/state")
    token = client.cookies.get(guest_cookie_name(first))

    # Replayed under the other session's name, the cookie is not accepted:
    # the browser gets a fresh guest instead of reusing the first one.
    replay = TestClient(app)
    replay.cookies.set(guest_cookie_name(second), token)
    resp = replay.post(f"/api/sessions/{second}/answers", json={"choice_id": choice_ids[0]})
    assert resp.cookies.get(guest_cookie_name(second)) not in (None, token)
    hist = teacher_client.get(f"/api/sessions/{second}/rounds/{rid}/histogram").json()
    assert hist["total"] == 1


def test_guests_cannot_reach_teacher_views(teacher_client, client):
    _, code, *_ = _open(teacher_client, anonymous=True)
    client.get(f"/api/sessions/{code}/state")
    assert client.get(f"/api/sessions/{code}/live").status_code == 401
    assert client.get("/api/quizzes").status_code == 401
    assert client.get("/api/auth/me").status_code == 401


def test_the_teacher_keeps_their_identity_and_is_not_counted(teacher_client):
    _, code, *_ = _open(teacher_client, anonymous=True)
    state = teacher_client.get(f"/api/sessions/{code}/state")
    assert state.status_code == 200
    assert not teacher_client.cookies.get(guest_cookie_name(code))
    assert teacher_client.get(f"/api/sessions/{code}/participants").json()["joined"] == 0


def test_nothing_names_anyone_in_an_anonymous_session(teacher_client, client):
    _, code, qid, choice_ids, _ = _open(teacher_client, anonymous=True)
    client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]})

    for path in (
        f"/api/sessions/{code}/participation.csv",
        f"/api/sessions/{code}/canvas-readiness",
        f"/api/sessions/{code}/canvas-participation.csv",
        f"/api/sessions/{code}/questions/{qid}/discussants",
    ):
        assert teacher_client.get(path).status_code == 409, path
