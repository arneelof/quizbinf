"""Competition sessions: Kahoot-style games run on the session machinery.

What is pinned here: every question is asked once against a clock, the first
answer counts, a right answer scores more the faster it came, and the
leaderboard ranks *nicknames* over closed rounds only — never real names, and
never moving while a question is open.
"""

from datetime import timedelta

from app import service
from app.db import SessionLocal, writing
from app.models import Answer, QuizSession, Round
from app.routers.sessions import _auto_close_sync
from tests.conftest import login


def _quiz(teacher, questions=1, mode=None):
    quiz = teacher.post("/api/quizzes", json={"title": "Game"}).json()
    ids = []
    for i in range(questions):
        body = {
            "text": f"Question {i + 1}",
            "choices": [
                {"text": "Right", "is_correct": True},
                {"text": "Wrong", "is_correct": False},
            ],
        }
        if mode:
            body["mode"] = mode
        q = teacher.post(f"/api/quizzes/{quiz['id']}/questions", json=body).json()
        ids.append((q["id"], [c["id"] for c in q["choices"]]))
    return quiz["id"], ids


def _game(teacher, questions=1, time_limit=None, mode=None):
    quiz_id, ids = _quiz(teacher, questions, mode)
    extra = f"&time_limit={time_limit}" if time_limit else ""
    resp = teacher.post(f"/api/sessions?quiz_id={quiz_id}&competition=true{extra}")
    assert resp.status_code == 201, resp.text
    return resp.json()["code"], ids


def _player(make_client, code, username, nickname):
    c = make_client()
    login(c, username)
    c.get(f"/api/sessions/{code}/state")
    resp = c.put(f"/api/sessions/{code}/nickname", json={"nickname": nickname})
    assert resp.status_code == 200, resp.text
    return c


def _open(teacher, code, qid):
    resp = teacher.post(f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "pre"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _close(teacher, code, round_id):
    assert teacher.post(f"/api/sessions/{code}/rounds/{round_id}/close").status_code == 200


def _answered_after(round_id, user_seconds: dict[str, float]):
    """Pretend each named user answered that many seconds into the round."""
    db = SessionLocal()
    try:
        with writing(db):
            round_ = db.get(Round, round_id)
            for answer in round_.answers:
                taken = user_seconds.get(answer.user.username)
                if taken is not None:
                    answer.submitted_at = round_.opened_at + timedelta(seconds=taken)
            db.commit()
    finally:
        db.close()
    service._ROUND_SCORES.clear()


def test_a_competition_session_records_its_clock(teacher_client):
    code, _ = _game(teacher_client, time_limit=30)
    state = teacher_client.get(f"/api/sessions/{code}/state").json()
    assert state["competition"] is True
    assert state["time_limit"] == 30


def test_the_clock_defaults_and_is_bounded(teacher_client):
    code, _ = _game(teacher_client)
    assert teacher_client.get(f"/api/sessions/{code}/state").json()["time_limit"] == 20
    quiz_id, _ = _quiz(teacher_client)
    resp = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}&competition=true&time_limit=1")
    assert resp.status_code == 422


def test_an_ordinary_session_is_not_a_competition(teacher_client):
    quiz_id, _ = _quiz(teacher_client)
    code = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]
    state = teacher_client.get(f"/api/sessions/{code}/state").json()
    assert state["competition"] is False and state["time_limit"] is None
    assert teacher_client.get(f"/api/sessions/{code}/leaderboard").status_code == 409


def test_every_question_is_asked_once(teacher_client):
    code, [(qid, _)] = _game(teacher_client)  # the question itself says "twice"
    round_id = _open(teacher_client, code, qid)
    _close(teacher_client, code, round_id)
    resp = teacher_client.post(
        f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "post"}
    )
    assert resp.status_code == 409


def test_an_open_round_carries_its_deadline(teacher_client):
    code, [(qid, _)] = _game(teacher_client, time_limit=15)
    _open(teacher_client, code, qid)
    state = teacher_client.get(f"/api/sessions/{code}/state").json()
    assert state["round_deadline"] is not None and state["server_time"] is not None


def test_a_player_needs_a_nickname_to_answer(teacher_client, student_client):
    code, [(qid, choices)] = _game(teacher_client)
    student_client.get(f"/api/sessions/{code}/state")
    _open(teacher_client, code, qid)
    resp = student_client.post(f"/api/sessions/{code}/answers", json={"choice_id": choices[0]})
    assert resp.status_code == 409 and "nickname" in resp.json()["detail"]


def test_nicknames_are_unique_ignoring_case(teacher_client, make_client):
    code, _ = _game(teacher_client)
    _player(make_client, code, "alice", "Speedy")
    bob = make_client()
    login(bob, "bob")
    resp = bob.put(f"/api/sessions/{code}/nickname", json={"nickname": "  speedy "})
    assert resp.status_code == 409


def test_a_nickname_is_cleaned_and_bounded(teacher_client, make_client):
    code, _ = _game(teacher_client)
    alice = _player(make_client, code, "alice", "  Blast \t  Off  ")
    assert alice.get(f"/api/sessions/{code}/standing").json()["nickname"] == "Blast Off"
    for bad in ["", "   ", "x" * 21]:
        assert alice.put(f"/api/sessions/{code}/nickname", json={"nickname": bad}).status_code == 409


def test_teachers_do_not_play(teacher_client):
    code, _ = _game(teacher_client)
    resp = teacher_client.put(f"/api/sessions/{code}/nickname", json={"nickname": "Boss"})
    assert resp.status_code == 409


def test_nicknames_belong_to_competitions(teacher_client, student_client):
    quiz_id, _ = _quiz(teacher_client)
    code = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]
    resp = student_client.put(f"/api/sessions/{code}/nickname", json={"nickname": "Me"})
    assert resp.status_code == 409


def test_the_first_answer_is_locked_in(teacher_client, make_client):
    code, [(qid, choices)] = _game(teacher_client)
    alice = _player(make_client, code, "alice", "A")
    _open(teacher_client, code, qid)
    url = f"/api/sessions/{code}/answers"
    assert alice.post(url, json={"choice_id": choices[1]}).status_code == 200
    # The same answer again is a phone re-sending, not a change.
    assert alice.post(url, json={"choice_id": choices[1]}).status_code == 200
    resp = alice.post(url, json={"choice_id": choices[0]})
    assert resp.status_code == 409 and "locked" in resp.json()["detail"]


def test_no_answer_after_the_clock_runs_out(teacher_client, make_client):
    code, [(qid, choices)] = _game(teacher_client, time_limit=10)
    alice = _player(make_client, code, "alice", "A")
    round_id = _open(teacher_client, code, qid)
    db = SessionLocal()
    try:
        with writing(db):
            round_ = db.get(Round, round_id)
            round_.opened_at = round_.opened_at - timedelta(seconds=12)
            db.commit()
    finally:
        db.close()
    resp = alice.post(f"/api/sessions/{code}/answers", json={"choice_id": choices[0]})
    assert resp.status_code == 409 and resp.json()["detail"] == "Time is up"


def test_points_fall_with_time_and_wrong_answers_score_nothing(teacher_client, make_client):
    code, [(qid, choices)] = _game(teacher_client, time_limit=20)
    fast = _player(make_client, code, "fast", "Fast")
    slow = _player(make_client, code, "slow", "Slow")
    wrong = _player(make_client, code, "wrong", "Wrong")
    round_id = _open(teacher_client, code, qid)
    for c, choice in [(fast, choices[0]), (slow, choices[0]), (wrong, choices[1])]:
        assert c.post(f"/api/sessions/{code}/answers", json={"choice_id": choice}).status_code == 200
    _close(teacher_client, code, round_id)
    _answered_after(round_id, {"fast": 0, "slow": 20, "wrong": 1})

    board = teacher_client.get(f"/api/sessions/{code}/leaderboard").json()
    scores = {e["nickname"]: e["score"] for e in board["entries"]}
    assert scores == {"Fast": 1000, "Slow": 500, "Wrong": 0}
    assert [e["nickname"] for e in board["entries"]] == ["Fast", "Slow", "Wrong"]


def test_the_leaderboard_names_nobody(teacher_client, make_client):
    code, [(qid, choices)] = _game(teacher_client)
    _player(make_client, code, "alice", "Neo")
    board = teacher_client.get(f"/api/sessions/{code}/leaderboard").json()
    entry = board["entries"][0]
    assert entry["nickname"] == "Neo"
    assert "alice" not in str(board)
    assert set(entry) == {
        "participant_id", "nickname", "score", "gained", "rank", "previous_rank", "last_correct",
    }


def test_the_leaderboard_is_the_teachers(teacher_client, make_client):
    code, _ = _game(teacher_client)
    alice = _player(make_client, code, "alice", "A")
    assert alice.get(f"/api/sessions/{code}/leaderboard").status_code == 403


def test_an_open_round_does_not_move_the_leaderboard(teacher_client, make_client):
    code, [(qid, choices)] = _game(teacher_client)
    alice = _player(make_client, code, "alice", "A")
    _open(teacher_client, code, qid)
    alice.post(f"/api/sessions/{code}/answers", json={"choice_id": choices[0]})
    board = teacher_client.get(f"/api/sessions/{code}/leaderboard").json()
    assert board["rounds_played"] == 0
    assert board["entries"][0]["score"] == 0
    standing = alice.get(f"/api/sessions/{code}/standing").json()
    assert standing["score"] == 0 and standing["last_correct"] is None


def test_ranks_share_ties_and_remember_where_they_were(teacher_client, make_client):
    code, [(q1, c1), (q2, c2)] = _game(teacher_client, questions=2)
    a = _player(make_client, code, "a", "Ann")
    b = _player(make_client, code, "b", "Ben")
    c = _player(make_client, code, "c", "Cy")

    r1 = _open(teacher_client, code, q1)
    a.post(f"/api/sessions/{code}/answers", json={"choice_id": c1[0]})
    b.post(f"/api/sessions/{code}/answers", json={"choice_id": c1[0]})
    c.post(f"/api/sessions/{code}/answers", json={"choice_id": c1[1]})
    _close(teacher_client, code, r1)
    _answered_after(r1, {"a": 0, "b": 0})
    board = teacher_client.get(f"/api/sessions/{code}/leaderboard").json()
    assert [(e["nickname"], e["rank"]) for e in board["entries"]] == [("Ann", 1), ("Ben", 1), ("Cy", 3)]
    assert all(e["previous_rank"] is None for e in board["entries"])

    r2 = _open(teacher_client, code, q2)
    c.post(f"/api/sessions/{code}/answers", json={"choice_id": c2[0]})
    a.post(f"/api/sessions/{code}/answers", json={"choice_id": c2[1]})
    _close(teacher_client, code, r2)
    _answered_after(r2, {"c": 0})
    board = teacher_client.get(f"/api/sessions/{code}/leaderboard").json()
    by_name = {e["nickname"]: e for e in board["entries"]}
    assert by_name["Ann"]["score"] == by_name["Ben"]["score"] == by_name["Cy"]["score"] == 1000
    assert by_name["Cy"]["gained"] == 1000 and by_name["Cy"]["previous_rank"] == 3
    assert by_name["Ann"]["last_correct"] is False and by_name["Ben"]["last_correct"] is None


def test_a_student_sees_only_their_own_standing(teacher_client, make_client):
    code, [(qid, choices)] = _game(teacher_client)
    alice = _player(make_client, code, "alice", "A")
    _player(make_client, code, "bob", "B")
    round_id = _open(teacher_client, code, qid)
    alice.post(f"/api/sessions/{code}/answers", json={"choice_id": choices[0]})
    _close(teacher_client, code, round_id)
    standing = alice.get(f"/api/sessions/{code}/standing").json()
    assert standing["nickname"] == "A"
    assert standing["rank"] == 1 and standing["players"] == 2
    assert standing["last_correct"] is True and standing["last_points"] >= 500
    assert standing["last_answered"] is True
    bob_standing = make_client()
    login(bob_standing, "bob")
    assert bob_standing.get(f"/api/sessions/{code}/standing").json()["last_answered"] is False
    assert "B" not in str({k: v for k, v in standing.items() if k != "players"})


def test_the_teacher_can_take_a_nickname_down(teacher_client, make_client):
    code, [(qid, choices)] = _game(teacher_client)
    alice = _player(make_client, code, "alice", "Rude")
    pid = teacher_client.get(f"/api/sessions/{code}/leaderboard").json()["entries"][0]["participant_id"]
    assert teacher_client.delete(f"/api/sessions/{code}/players/{pid}/nickname").status_code == 200
    assert teacher_client.get(f"/api/sessions/{code}/leaderboard").json()["entries"] == []
    assert alice.get(f"/api/sessions/{code}/standing").json()["nickname"] is None
    _open(teacher_client, code, qid)
    resp = alice.post(f"/api/sessions/{code}/answers", json={"choice_id": choices[0]})
    assert resp.status_code == 409


def test_the_clock_closes_the_round(teacher_client):
    code, [(qid, _)] = _game(teacher_client)
    round_id = _open(teacher_client, code, qid)
    assert _auto_close_sync(round_id) is True
    assert teacher_client.get(f"/api/sessions/{code}/state").json()["open_round"] is None
    # The teacher halting first leaves the clock nothing to do.
    assert _auto_close_sync(round_id) is False


def test_results_at_the_end_are_shown_after_the_one_round(teacher_client, make_client):
    code, [(qid, choices)] = _game(teacher_client, mode="twice_end")
    alice = _player(make_client, code, "alice", "A")
    round_id = _open(teacher_client, code, qid)
    alice.post(f"/api/sessions/{code}/answers", json={"choice_id": choices[0]})
    _close(teacher_client, code, round_id)
    state = alice.get(f"/api/sessions/{code}/state").json()
    assert state["closed_round_histogram"][str(choices[0])] == 1
