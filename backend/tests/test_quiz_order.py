"""The quiz list is in title order, numbers compared as numbers, whatever the import order."""


def test_quizzes_are_listed_in_session_order(teacher_client):
    for title in ["Session 10: B", "Session 2: A", "Session 1: Z", "Extra"]:
        assert teacher_client.post("/api/quizzes", json={"title": title}).status_code == 201
    titles = [q["title"] for q in teacher_client.get("/api/quizzes").json()]
    assert titles == ["Extra", "Session 1: Z", "Session 2: A", "Session 10: B"]
