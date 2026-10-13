"""Questions that are not single-choice: several choices, rankings, numbers,
scales, words, text and taps on a figure.

What has to hold for every kind: the answer is checked against the question
on the server, the result is aggregated or anonymous, the answer to a graded
question is never sent to students, and a text answer the teacher hides is
gone from what students and the projector see.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import login


def _quiz(teacher_client, **question) -> tuple[int, dict]:
    quiz_id = teacher_client.post("/api/quizzes", json={"title": "Kinds"}).json()["id"]
    resp = teacher_client.post(f"/api/quizzes/{quiz_id}/questions", json=question)
    assert resp.status_code == 201, resp.text
    return quiz_id, resp.json()


def _students(*names) -> dict[str, TestClient]:
    clients = {}
    for name in names:
        c = TestClient(app)
        login(c, name)
        clients[name] = c
    return clients


def _ask(teacher_client, quiz_id, qid, answers: dict, phase="pre"):
    """Open a round, post {name: AnswerIn body}, close it. Returns (code, statuses)."""
    code = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]
    clients = _students(*answers)
    rnd = teacher_client.post(
        f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": phase}
    ).json()
    statuses = {
        name: clients[name].post(f"/api/sessions/{code}/answers", json=body).status_code
        for name, body in answers.items()
    }
    teacher_client.post(f"/api/sessions/{code}/rounds/{rnd['id']}/close")
    return code, statuses, clients


def _result(teacher_client, code, qid, phase="pre"):
    return teacher_client.get(f"/api/sessions/{code}/questions/{qid}/comparison").json()[
        f"{phase}_result"
    ]


# --- authoring rules ---------------------------------------------------------


@pytest.mark.parametrize(
    "question",
    [
        {"text": "Q", "kind": "number", "choices": [{"text": "a"}, {"text": "b"}]},
        {"text": "Q", "kind": "rank", "choices": [{"text": "a", "is_correct": True}, {"text": "b"}]},
        {"text": "Q", "kind": "multi", "choices": [{"text": "a"}]},
        {"text": "Q", "kind": "scale", "settings": {"min": 1, "max": 50}},
        {"text": "Q", "kind": "scale", "settings": {"min": 1.5, "max": 5}},
        {"text": "Q", "kind": "number", "settings": {"min": 0, "max": 10, "answer": 20}},
        {"text": "Q", "kind": "point"},
        {"text": "Q", "kind": "word", "settings": {"colour": "red"}},
    ],
)
def test_a_question_that_does_not_fit_its_kind_is_refused(teacher_client, question):
    quiz_id = teacher_client.post("/api/quizzes", json={"title": "x"}).json()["id"]
    resp = teacher_client.post(f"/api/quizzes/{quiz_id}/questions", json=question)
    assert resp.status_code == 422, question


def test_a_single_choice_question_may_have_no_right_answer(teacher_client):
    quiz_id, q = _quiz(
        teacher_client, text="Which do you prefer?", choices=[{"text": "tea"}, {"text": "coffee"}]
    )
    assert q["kind"] == "choice" and q["graded"] is False


# --- each kind ---------------------------------------------------------------


def test_several_choices_are_counted_and_graded_as_a_set(teacher_client):
    quiz_id, q = _quiz(
        teacher_client,
        text="Which are amino acids?",
        kind="multi",
        choices=[
            {"text": "glycine", "is_correct": True},
            {"text": "adenine"},
            {"text": "lysine", "is_correct": True},
        ],
    )
    gly, ade, lys = (c["id"] for c in q["choices"])
    code, statuses, _ = _ask(
        teacher_client, quiz_id, q["id"],
        {"anna": {"choice_ids": [gly, lys]}, "bo": {"choice_ids": [gly]},
         "cia": {"choice_ids": []}, "dan": {"choice_ids": [gly, 999]}},
    )
    assert statuses == {"anna": 200, "bo": 200, "cia": 409, "dan": 409}
    result = _result(teacher_client, code, q["id"])
    assert result["total"] == 2
    assert result["counts"] == {str(gly): 2, str(ade): 0, str(lys): 1}

    rows = {r["username"]: r for r in
            teacher_client.get(f"/api/sessions/{code}/participation").json()["rows"]}
    assert rows["anna"]["answers"][0]["pre"] is True
    assert rows["bo"]["answers"][0]["pre"] is False


def test_a_ranking_must_order_every_choice_and_reports_mean_ranks(teacher_client):
    quiz_id, q = _quiz(
        teacher_client, text="Order by size", kind="rank",
        choices=[{"text": "atom"}, {"text": "protein"}, {"text": "cell"}],
    )
    a, p, c = (ch["id"] for ch in q["choices"])
    code, statuses, _ = _ask(
        teacher_client, quiz_id, q["id"],
        {"anna": {"choice_ids": [a, p, c]}, "bo": {"choice_ids": [p, a, c]},
         "cia": {"choice_ids": [a, p]}},
    )
    assert statuses == {"anna": 200, "bo": 200, "cia": 409}
    result = _result(teacher_client, code, q["id"])
    assert result["mean_rank"] == {str(a): 1.5, str(p): 1.5, str(c): 3.0}
    assert result["rank_counts"][str(c)] == [0, 0, 2]
    assert result["counts"] == {str(a): 1, str(p): 1, str(c): 0}  # put first


def test_numbers_are_checked_against_the_range_and_graded_within_tolerance(teacher_client):
    quiz_id, q = _quiz(
        teacher_client, text="How many amino acids?", kind="number",
        settings={"min": 0, "max": 100, "answer": 20, "tolerance": 1, "unit": "aa"},
    )
    code, statuses, clients = _ask(
        teacher_client, quiz_id, q["id"],
        {"anna": {"number": 20}, "bo": {"number": 21}, "cia": {"number": 25},
         "dan": {"number": 150}, "eva": {}},
    )
    assert statuses == {"anna": 200, "bo": 200, "cia": 200, "dan": 409, "eva": 409}
    result = _result(teacher_client, code, q["id"])
    assert result["values"] == [20, 21, 25] and result["median"] == 21

    rows = {r["username"]: r for r in
            teacher_client.get(f"/api/sessions/{code}/participation").json()["rows"]}
    assert [rows[n]["answers"][0]["pre"] for n in ("anna", "bo", "cia")] == [True, True, False]


def test_students_never_see_the_numerical_answer(teacher_client):
    quiz_id, q = _quiz(
        teacher_client, text="How many?", kind="number",
        settings={"answer": 20, "tolerance": 1, "unit": "aa"},
    )
    assert q["settings"]["answer"] == 20  # the teacher sees it
    code = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]
    student = _students("anna")["anna"]
    teacher_client.post(f"/api/sessions/{code}/rounds", json={"question_id": q["id"], "phase": "pre"})
    state = student.get(f"/api/sessions/{code}/state").json()
    assert state["question"]["settings"] == {"unit": "aa"}
    assert "graded" not in state["question"]


def test_a_scale_takes_whole_numbers_and_counts_each_value(teacher_client):
    quiz_id, q = _quiz(
        teacher_client, text="How confident are you?", kind="scale",
        settings={"min": 1, "max": 5, "min_label": "not at all", "max_label": "completely"},
    )
    code, statuses, _ = _ask(
        teacher_client, quiz_id, q["id"],
        {"anna": {"number": 4}, "bo": {"number": 4}, "cia": {"number": 2},
         "dan": {"number": 3.5}, "eva": {"number": 6}},
    )
    assert statuses == {"anna": 200, "bo": 200, "cia": 200, "dan": 409, "eva": 409}
    result = _result(teacher_client, code, q["id"])
    assert result["counts"] == {"1": 0, "2": 1, "3": 0, "4": 2, "5": 0}
    assert result["mean"] == pytest.approx(10 / 3)


def test_words_are_tidied_and_counted_case_insensitively(teacher_client):
    quiz_id, q = _quiz(
        teacher_client, text="One word for AlphaFold", kind="word", settings={"max_words": 2}
    )
    code, statuses, _ = _ask(
        teacher_client, quiz_id, q["id"],
        {"anna": {"words": ["Magic", " structure  prediction! "]},
         "bo": {"words": ["magic"]},
         "cia": {"words": ["MAGIC", "magic"]},
         "dan": {"words": ["a", "b", "c"]},
         "eva": {"words": ["  "]}},
    )
    assert statuses == {"anna": 200, "bo": 200, "cia": 200, "dan": 409, "eva": 409}
    words = _result(teacher_client, code, q["id"])["words"]
    assert words[0]["count"] == 3 and words[0]["word"].lower() == "magic"
    assert {"word": "structure prediction", "count": 1} in words


def test_hidden_text_answers_leave_the_projected_and_student_views(teacher_client):
    quiz_id, q = _quiz(teacher_client, text="What was unclear?", kind="text")
    code, statuses, clients = _ask(
        teacher_client, quiz_id, q["id"],
        {"anna": {"text": "Backpropagation"}, "bo": {"text": "something rude"},
         "cia": {"text": "   "}},
    )
    assert statuses == {"anna": 200, "bo": 200, "cia": 409}
    texts = _result(teacher_client, code, q["id"])["texts"]
    assert sorted(t["text"] for t in texts) == ["Backpropagation", "something rude"]
    assert all("hidden" in t for t in texts)  # the teacher's view marks them
    rude = next(t for t in texts if t["text"] == "something rude")

    # A student cannot hide anything.
    assert clients["anna"].post(f"/api/sessions/{code}/answers/{rude['id']}/hidden").status_code == 403
    assert teacher_client.post(f"/api/sessions/{code}/answers/{rude['id']}/hidden").status_code == 200

    state = clients["anna"].get(f"/api/sessions/{code}/state").json()
    assert [t["text"] for t in state["closed_round_result"]["texts"]] == ["Backpropagation"]
    teacher_view = _result(teacher_client, code, q["id"])["texts"]
    assert next(t for t in teacher_view if t["id"] == rude["id"])["hidden"] is True

    teacher_client.post(f"/api/sessions/{code}/answers/{rude['id']}/hidden?hidden=false")
    state = clients["anna"].get(f"/api/sessions/{code}/state").json()
    assert len(state["closed_round_result"]["texts"]) == 2


def test_text_answers_carry_no_names(teacher_client):
    quiz_id, q = _quiz(teacher_client, text="Why?", kind="text")
    code, _, _ = _ask(teacher_client, quiz_id, q["id"], {"anna": {"text": "Because"}})
    (card,) = _result(teacher_client, code, q["id"])["texts"]
    assert set(card) == {"id", "text", "hidden"}


def test_a_tap_must_land_on_the_figure(teacher_client):
    quiz_id, q = _quiz(
        teacher_client, text="Where is the active site?", kind="point",
        image_url="/api/images/x.png",
    )
    code, statuses, _ = _ask(
        teacher_client, quiz_id, q["id"],
        {"anna": {"point": [0.25, 0.5]}, "bo": {"point": [1.2, 0.5]}, "cia": {"point": [0.5]}},
    )
    assert statuses == {"anna": 200, "bo": 409, "cia": 422}
    assert _result(teacher_client, code, q["id"])["points"] == [[0.25, 0.5]]


def test_the_students_own_answer_comes_back_in_the_state(teacher_client):
    quiz_id, q = _quiz(teacher_client, text="Words", kind="word")
    code = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]
    student = _students("anna")["anna"]
    teacher_client.post(f"/api/sessions/{code}/rounds", json={"question_id": q["id"], "phase": "pre"})
    student.post(f"/api/sessions/{code}/answers", json={"words": ["fold", "fold", "energy"]})
    state = student.get(f"/api/sessions/{code}/state").json()
    assert state["my_answer"] == {"words": ["fold", "energy"]}
    assert state["my_choice_id"] is None


def test_an_answered_question_cannot_change_kind(teacher_client):
    quiz_id, q = _quiz(teacher_client, text="How many?", kind="number")
    _ask(teacher_client, quiz_id, q["id"], {"anna": {"number": 3}})
    resp = teacher_client.put(
        f"/api/quizzes/{quiz_id}/questions/{q['id']}",
        json={"text": "How many?", "kind": "scale", "settings": {"min": 1, "max": 5}},
    )
    assert resp.status_code == 409
    # Settings can still be corrected, e.g. the answer.
    resp = teacher_client.put(
        f"/api/quizzes/{quiz_id}/questions/{q['id']}",
        json={"text": "How many?", "settings": {"answer": 3}},
    )
    assert resp.status_code == 200 and resp.json()["settings"] == {"answer": 3}


def test_old_clients_still_get_histograms_for_choice_questions(teacher_client):
    """`pre`/`post` and `closed_round_histogram` keep their shape."""
    quiz_id, q = _quiz(
        teacher_client, text="Pick", choices=[{"text": "a", "is_correct": True}, {"text": "b"}]
    )
    a, b = (c["id"] for c in q["choices"])
    code, _, clients = _ask(teacher_client, quiz_id, q["id"], {"anna": {"choice_id": a}})
    comparison = teacher_client.get(f"/api/sessions/{code}/questions/{q['id']}/comparison").json()
    assert comparison["pre"] == {str(a): 1, str(b): 0}
    state = clients["anna"].get(f"/api/sessions/{code}/state").json()
    assert state["closed_round_histogram"] == {str(a): 1, str(b): 0}
    assert state["closed_round_result"]["counts"] == {str(a): 1, str(b): 0}


def test_the_handout_says_what_kind_of_answer_is_asked_for(teacher_client):
    quiz_id, q = _quiz(
        teacher_client, text="How many amino acids?", kind="number",
        settings={"answer": 20, "tolerance": 1, "unit": "aa"},
    )
    with_answers = teacher_client.get(f"/api/quizzes/{quiz_id}/export.md").text
    without = teacher_client.get(f"/api/quizzes/{quiz_id}/export.md?answers=false").text
    assert "Answer: 20 ± 1 aa" in with_answers
    assert "Answer:" not in without and "Answer with a number (aa)" in without
