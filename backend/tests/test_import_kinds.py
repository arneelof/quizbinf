"""The Markdown format for the other kinds of question (docs/quiz-authoring.md),
and that what the importer produces is accepted by the API."""

from pathlib import Path

import pytest

from scripts.import_quiz import FormatError, parse_quiz, question_payload

QUIZ = """# Discussion: Session 9

## How many parameters does the network have?
type: number
answer: 1250 ± 10
range: 0-100000
unit: parameters

## How sure are you?
type: scale
range: 1-5
labels: not at all | completely
mode: once

## One word for what a hidden layer does
type: word
max words: 2

## What was unclear today?
type: text

## Which are activation functions?
type: multi
- [x] ReLU
- [ ] Adam
- [x] sigmoid

## Order these from slowest to fastest to train
type: rank
- [ ] RNN
- [ ] CNN
- [ ] linear model

## Which do you prefer?
- [ ] PyTorch
- [ ] JAX
"""


def test_every_kind_parses(tmp_path):
    quiz = parse_quiz(QUIZ, tmp_path)
    kinds = [q.get("kind", "choice") for q in quiz["questions"]]
    assert kinds == ["number", "scale", "word", "text", "multi", "rank", "choice"]
    number, scale, word = quiz["questions"][:3]
    assert number["settings"] == {"answer": 1250, "tolerance": 10, "min": 0, "max": 100000,
                                  "unit": "parameters"}
    assert scale["settings"] == {"min": 1, "max": 5, "min_label": "not at all",
                                 "max_label": "completely"}
    assert scale["mode"] == "once"
    assert word["settings"] == {"max_words": 2}
    # Settings lines are not part of the question text.
    assert number["text"] == "How many parameters does the network have?"


def test_the_api_accepts_what_the_importer_produces(teacher_client, tmp_path):
    quiz = parse_quiz(QUIZ, tmp_path)
    quiz_id = teacher_client.post("/api/quizzes", json={"title": quiz["title"]}).json()["id"]
    for q in quiz["questions"]:
        resp = teacher_client.post(f"/api/quizzes/{quiz_id}/questions", json=question_payload(q))
        assert resp.status_code == 201, (q["text"], resp.text)


def test_a_point_question_takes_its_first_figure(tmp_path):
    (tmp_path / "heart.png").write_bytes(b"\x89PNG")
    quiz = parse_quiz("# T\n\n## Where is the left ventricle?\ntype: point\n\n![](heart.png)\n", tmp_path)
    (q,) = quiz["questions"]
    assert q["image_url"] == "heart.png" and "heart.png" not in q["text"]


@pytest.mark.parametrize(
    "block",
    [
        "type: banana",
        "type: number\nanswer: lots",
        "type: scale\nrange: 1 or 5",
        "type: number\n- [ ] a\n- [ ] b",
        "type: rank\n- [x] a\n- [ ] b",
        "- [x] a\n- [x] b",
        "type: point",
    ],
)
def test_mistakes_are_reported(tmp_path, block):
    with pytest.raises(FormatError):
        parse_quiz(f"# T\n\n## Q\n{block}\n", tmp_path)


def test_existing_files_parse_as_before(tmp_path):
    quiz = parse_quiz("# T\n\n## Q\n- [x] a\n- [ ] b\n", tmp_path)
    assert quiz["questions"][0] == {
        "text": "Q", "choices": [{"text": "a", "is_correct": True},
                                 {"text": "b", "is_correct": False}], "mode": "twice"}
