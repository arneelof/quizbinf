"""The three ways a question can be run.

- `once`: one round, result shown when it is halted.
- `twice` (the default): pre and post, each result shown as it is halted.
- `twice_end`: pre and post, nothing shown until post is halted, then both.

What a student's own device shows is the part pinned here. The projected
Report view applies the same rules in the frontend (session-feed.service.ts).
"""

from pathlib import Path

from scripts.import_quiz import parse_quiz
from tests.conftest import login


def _session(teacher, mode: str | None) -> tuple[str, int, list[int]]:
    quiz = teacher.post("/api/quizzes", json={"title": "Modes"}).json()
    body = {
        "text": "What does BLAST do?",
        "choices": [
            {"text": "Aligns sequences", "is_correct": True},
            {"text": "Folds proteins", "is_correct": False},
        ],
    }
    if mode is not None:
        body["mode"] = mode
    q = teacher.post(f"/api/quizzes/{quiz['id']}/questions", json=body).json()
    code = teacher.post(f"/api/sessions?quiz_id={quiz['id']}").json()["code"]
    return code, q["id"], [c["id"] for c in q["choices"]]


def _round(teacher, student, code, qid, phase, choice_id):
    resp = teacher.post(f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": phase})
    assert resp.status_code == 201, resp.text
    student.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_id})
    teacher.post(f"/api/sessions/{code}/rounds/{resp.json()['id']}/close")


def _state(client, code):
    return client.get(f"/api/sessions/{code}/state").json()


def test_questions_default_to_twice(teacher_client):
    code, qid, _ = _session(teacher_client, None)
    quiz_id = teacher_client.get(f"/api/sessions/{code}/state").json()["quiz_id"]
    quiz = teacher_client.get(f"/api/quizzes/{quiz_id}").json()
    assert quiz["questions"][0]["mode"] == "twice"


def test_an_unknown_mode_is_refused(teacher_client):
    quiz = teacher_client.post("/api/quizzes", json={"title": "Modes"}).json()
    resp = teacher_client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "text": "Q",
            "choices": [{"text": "a", "is_correct": True}, {"text": "b"}],
            "mode": "thrice",
        },
    )
    assert resp.status_code == 422


def test_once_shows_the_result_and_refuses_a_second_round(teacher_client, student_client):
    code, qid, choices = _session(teacher_client, "once")
    _round(teacher_client, student_client, code, qid, "pre", choices[0])

    state = _state(student_client, code)
    assert state["closed_round_histogram"][str(choices[0])] == 1
    assert state["closed_round_pre_histogram"] is None

    resp = teacher_client.post(
        f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "post"}
    )
    assert resp.status_code == 409
    assert "only once" in resp.json()["detail"]


def test_twice_shows_each_result_and_both_after_the_second(teacher_client, student_client):
    code, qid, choices = _session(teacher_client, "twice")
    _round(teacher_client, student_client, code, qid, "pre", choices[1])
    assert _state(student_client, code)["closed_round_histogram"][str(choices[1])] == 1

    _round(teacher_client, student_client, code, qid, "post", choices[0])
    state = _state(student_client, code)
    assert state["closed_round"]["phase"] == "post"
    assert state["closed_round_histogram"][str(choices[0])] == 1
    assert state["closed_round_pre_histogram"][str(choices[1])] == 1


def test_twice_end_hides_the_first_result_until_the_second_is_halted(
    teacher_client, student_client
):
    code, qid, choices = _session(teacher_client, "twice_end")
    _round(teacher_client, student_client, code, qid, "pre", choices[1])

    # Discussion time: the page knows a round just closed, but not the split.
    state = _state(student_client, code)
    assert state["closed_round"]["phase"] == "pre"
    assert state["closed_round_question"]["mode"] == "twice_end"
    assert state["closed_round_histogram"] is None
    assert state["closed_round_pre_histogram"] is None

    _round(teacher_client, student_client, code, qid, "post", choices[0])
    state = _state(student_client, code)
    assert state["closed_round_histogram"][str(choices[0])] == 1
    assert state["closed_round_pre_histogram"][str(choices[1])] == 1


def test_twice_end_is_hidden_from_anonymous_broadcast_state_too(teacher_client, student_client, client):
    """The SSE broadcast is built from the same state with no user; the
    hidden result must not leak through it."""
    code, qid, choices = _session(teacher_client, "twice_end")
    _round(teacher_client, student_client, code, qid, "pre", choices[1])
    from app.db import SessionLocal
    from app.models import QuizSession
    from app.routers.sessions import _state as build_state
    from sqlalchemy import select

    with SessionLocal() as db:
        session = db.scalar(select(QuizSession).where(QuizSession.code == code))
        assert build_state(db, session, user=None).closed_round_histogram is None


def test_editing_can_change_the_mode_and_leaving_it_out_keeps_it(teacher_client):
    code, qid, _ = _session(teacher_client, "once")
    quiz_id = _state(teacher_client, code)["quiz_id"]
    q = teacher_client.get(f"/api/quizzes/{quiz_id}").json()["questions"][0]
    edit = {"text": "Reworded", "choices": [{"id": c["id"], "text": c["text"], "is_correct": c["is_correct"]} for c in q["choices"]]}

    # An older client that knows nothing of modes must not reset it.
    assert teacher_client.put(f"/api/quizzes/{quiz_id}/questions/{qid}", json=edit).json()["mode"] == "once"
    resp = teacher_client.put(f"/api/quizzes/{quiz_id}/questions/{qid}", json={**edit, "mode": "twice_end"})
    assert resp.json()["mode"] == "twice_end"


def test_a_once_question_counts_for_attendance_after_one_round(teacher_client, make_client):
    present, absent = make_client(), make_client()
    login(present, "adam")
    login(absent, "bo")
    code, qid, choices = _session(teacher_client, "once")
    rid = teacher_client.post(
        f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "pre"}
    ).json()["id"]
    present.post(f"/api/sessions/{code}/answers", json={"choice_id": choices[0]})
    absent.get(f"/api/sessions/{code}/state")  # joined, never answered
    teacher_client.post(f"/api/sessions/{code}/rounds/{rid}/close")

    report = teacher_client.get("/api/reports/participation").json()
    by_user = {r["username"]: r["sessions"][0] for r in report["students"]}
    assert by_user["adam"] == {"completed": 1, "asked": 1, "took_part": True}
    assert by_user["bo"]["took_part"] is False


def test_the_markdown_importer_reads_a_mode_line(tmp_path: Path):
    quiz = parse_quiz(
        """# Modes

## Asked once
mode: once

- [x] a
- [ ] b

## Asked twice, revealed at the end
Mode: twice-end

- [x] a
- [ ] b

## Default

- [x] a
- [ ] b
""",
        tmp_path,
    )
    assert [q["mode"] for q in quiz["questions"]] == ["once", "twice_end", "twice"]
    # The mode line is an instruction, not part of the question text.
    assert "mode" not in quiz["questions"][0]["text"].lower()
