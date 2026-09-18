"""Tests for answer submission rules and aggregate results."""

from tests.conftest import make_quiz_with_question


def _open_session(teacher_client):
    quiz_id, qid, choice_ids = make_quiz_with_question(teacher_client)
    code = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]
    rid = teacher_client.post(
        f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "pre"}
    ).json()["id"]
    return code, qid, choice_ids, rid


def test_answer_requires_login(client, teacher_client):
    code, qid, choice_ids, rid = _open_session(teacher_client)
    resp = client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]})
    assert resp.status_code == 401


def test_last_write_wins_while_open(student_client, teacher_client):
    code, qid, choice_ids, rid = _open_session(teacher_client)
    student_client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]})
    student_client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[1]})
    hist = teacher_client.get(f"/api/sessions/{code}/rounds/{rid}/histogram").json()
    # one student, one net answer on their latest choice
    assert hist["total"] == 1
    assert hist["counts"][str(choice_ids[1])] == 1
    assert hist["counts"][str(choice_ids[0])] == 0


def test_no_answer_after_close(student_client, teacher_client):
    code, qid, choice_ids, rid = _open_session(teacher_client)
    teacher_client.post(f"/api/sessions/{code}/rounds/{rid}/close")
    resp = student_client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]})
    assert resp.status_code == 409


def test_pre_post_comparison(student_client, teacher_client):
    code, qid, choice_ids, pre_id = _open_session(teacher_client)
    student_client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[1]})  # wrong
    teacher_client.post(f"/api/sessions/{code}/rounds/{pre_id}/close")
    teacher_client.post(
        f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "post"}
    )
    student_client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]})  # correct
    cmp = teacher_client.get(f"/api/sessions/{code}/questions/{qid}/comparison").json()
    assert cmp["pre"][str(choice_ids[1])] == 1
    assert cmp["post"][str(choice_ids[0])] == 1


def test_state_hides_correct_answer(student_client, teacher_client):
    code, qid, choice_ids, rid = _open_session(teacher_client)
    state = student_client.get(f"/api/sessions/{code}/state").json()
    for choice in state["question"]["choices"]:
        assert "is_correct" not in choice


def test_state_omits_closed_round_while_a_round_is_open(student_client, teacher_client):
    code, qid, choice_ids, rid = _open_session(teacher_client)
    state = student_client.get(f"/api/sessions/{code}/state").json()
    assert state["closed_round"] is None
    assert state["closed_round_histogram"] is None


def test_state_shows_histogram_once_halted(student_client, teacher_client):
    """The feature this pins: a student's own device gets the bar chart too,
    once the teacher halts submissions -- not just the teacher's Report view."""
    code, qid, choice_ids, rid = _open_session(teacher_client)
    student_client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]})
    teacher_client.post(f"/api/sessions/{code}/rounds/{rid}/close")

    state = student_client.get(f"/api/sessions/{code}/state").json()
    assert state["open_round"] is None
    assert state["closed_round"]["id"] == rid
    assert state["closed_round_question"]["id"] == qid
    assert state["closed_round_histogram"][str(choice_ids[0])] == 1
    # Still no reveal of which choice was correct, same rule as the open question.
    for choice in state["closed_round_question"]["choices"]:
        assert "is_correct" not in choice


def test_closed_round_histogram_clears_once_a_new_round_opens(student_client, teacher_client):
    code, qid, choice_ids, rid = _open_session(teacher_client)
    teacher_client.post(f"/api/sessions/{code}/rounds/{rid}/close")
    teacher_client.post(
        f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "post"}
    )

    state = student_client.get(f"/api/sessions/{code}/state").json()
    assert state["open_round"] is not None
    assert state["closed_round"] is None
    assert state["closed_round_histogram"] is None
