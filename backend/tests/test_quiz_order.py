"""The quiz list: in title order (numbers as numbers), and quizzes can be renamed or deleted."""

from tests.conftest import make_quiz_with_question


def test_quizzes_are_listed_in_session_order(teacher_client):
    for title in ["Session 10: B", "Session 2: A", "Session 1: Z", "Extra"]:
        assert teacher_client.post("/api/quizzes", json={"title": title}).status_code == 201
    titles = [q["title"] for q in teacher_client.get("/api/quizzes").json()]
    assert titles == ["Extra", "Session 1: Z", "Session 2: A", "Session 10: B"]


def test_a_quiz_can_be_renamed_but_titles_stay_unique(teacher_client):
    a = teacher_client.post("/api/quizzes", json={"title": "Session 6: Linear models"}).json()
    teacher_client.post("/api/quizzes", json={"title": "Session 6: Protein Structure"})
    resp = teacher_client.patch(f"/api/quizzes/{a['id']}", json={"title": "Session 7: Linear models"})
    assert resp.status_code == 200 and resp.json()["title"] == "Session 7: Linear models"
    clash = teacher_client.patch(f"/api/quizzes/{a['id']}", json={"title": "Session 6: Protein Structure"})
    assert clash.status_code == 409


def test_an_unanswered_quiz_can_be_deleted_with_its_sessions(teacher_client):
    quiz_id, qid, _ = make_quiz_with_question(teacher_client)
    code = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]
    teacher_client.post(f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "pre"})
    assert teacher_client.delete(f"/api/quizzes/{quiz_id}").status_code == 204
    assert teacher_client.get(f"/api/quizzes/{quiz_id}").status_code == 404


def test_a_quiz_with_answers_cannot_be_deleted(teacher_client, student_client):
    quiz_id, qid, choice_ids = make_quiz_with_question(teacher_client)
    code = teacher_client.post(f"/api/sessions?quiz_id={quiz_id}").json()["code"]
    teacher_client.post(f"/api/sessions/{code}/rounds", json={"question_id": qid, "phase": "pre"})
    student_client.get(f"/api/sessions/{code}")
    assert student_client.post(f"/api/sessions/{code}/answers", json={"choice_id": choice_ids[0]}).status_code < 300
    assert teacher_client.delete(f"/api/quizzes/{quiz_id}").status_code == 409
