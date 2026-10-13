#!/usr/bin/env python3
"""Load a quiz written in quizbinf's Markdown authoring format into the app.

The format is documented in `docs/quiz-authoring.md`. In short:

    # Quiz title

    ## Question text, itself Markdown, may span multiple lines
    and include a figure: ![](local-figure.png){width=60%}

    - [ ] A wrong choice
    - [x] The correct choice
    - [ ] Another wrong choice

Repeat the `##` block for each question. A local image path (anything that
is not `http(s)://` or `/api/...`) is resolved relative to the Markdown
file's own directory, uploaded through `POST /api/images`, and the reference
rewritten to the URL the server hands back — the same thing pasting a figure
into the authoring UI does.

Quiz deletion is not implemented yet (see CLAUDE.md), so a bad import cannot
be undone by re-running this script — it can only add more quizzes. Use
--dry-run first; it does no networking beyond checking local image files
exist, and prints exactly what would be created.
"""

import argparse
import re
import sys
from pathlib import Path

import httpx

QUESTION_HEADING = re.compile(r"^##\s+(.*)$")
QUIZ_TITLE = re.compile(r"^#\s+(.*)$")
CHOICE_LINE = re.compile(r"^-\s*\[([ xX])\]\s*(.+)$")
# A line on its own inside a question block. See docs/quiz-authoring.md.
MODE_LINE = re.compile(r"^mode:\s*(once|twice|twice[-_]end)\s*$", re.IGNORECASE)
IMAGE_REF = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)(\{[^}]*\})?")
# The other settings lines of a question block; see docs/quiz-authoring.md.
SETTING_LINE = re.compile(
    r"^(type|answer|tolerance|range|unit|labels|max[ _]words|max[ _]length|figure):\s*(.+?)\s*$",
    re.IGNORECASE,
)
KINDS = {
    "choice": "choice", "single": "choice", "poll": "choice",
    "multi": "multi", "several": "multi", "multiple": "multi",
    "rank": "rank", "ranking": "rank", "order": "rank",
    "number": "number", "numerical": "number",
    "scale": "scale",
    "word": "word", "words": "word", "wordcloud": "word", "word cloud": "word",
    "text": "text", "free text": "text", "long text": "text",
    "point": "point", "click": "point", "figure": "point", "tap": "point",
}
NUMBER = r"(-?\d+(?:\.\d+)?)"
RANGE = re.compile(rf"^{NUMBER}\s*(?:-|–|to|\.\.)\s*{NUMBER}$", re.IGNORECASE)
ANSWER = re.compile(rf"^{NUMBER}(?:\s*(?:±|\+-|\+/-)\s*{NUMBER})?$")


class FormatError(Exception):
    """The Markdown file does not follow the quiz-authoring format."""


def parse_quiz(text: str, source_dir: Path) -> dict:
    lines = text.splitlines()

    title = None
    question_blocks: list[list[str]] = []
    for line in lines:
        m = QUIZ_TITLE.match(line)
        if m and title is None:
            title = m.group(1).strip()
            continue
        if QUESTION_HEADING.match(line):
            question_blocks.append([line])
        elif question_blocks:
            question_blocks[-1].append(line)
        # Lines before the first "##" heading (other than the title) are
        # ignored — free-form notes a chapter's author might leave there.

    if not title:
        raise FormatError("No `# Quiz title` heading found")
    if not question_blocks:
        raise FormatError("No `## Question` headings found")

    questions = [_parse_question(block, source_dir) for block in question_blocks]
    return {"title": title, "questions": questions}


def _number(value: str, what: str, heading: str) -> float:
    try:
        x = float(value)
    except ValueError:
        raise FormatError(f"Question {heading!r}: {what} {value!r} is not a number")
    return int(x) if x == int(x) else x


def _parse_question(block: list[str], source_dir: Path) -> dict:
    heading = QUESTION_HEADING.match(block[0]).group(1).strip()
    body_lines = [heading]
    choices: list[tuple[bool, str]] = []
    mode = "twice"
    kind = "choice"
    settings: dict = {}
    figure = None

    for line in block[1:]:
        mode_match = MODE_LINE.match(line.strip())
        if mode_match:
            mode = mode_match.group(1).lower().replace("-", "_")
            continue
        setting = SETTING_LINE.match(line.strip())
        if setting:
            key, value = setting.group(1).lower().replace(" ", "_"), setting.group(2)
            if key == "type":
                if value.lower() not in KINDS:
                    raise FormatError(f"Question {heading!r}: unknown type {value!r}; "
                                      f"use one of {', '.join(sorted(set(KINDS.values())))}")
                kind = KINDS[value.lower()]
            elif key == "answer":
                m = ANSWER.match(value)
                if not m:
                    raise FormatError(f"Question {heading!r}: answer {value!r} is not "
                                      "a number, or a number ± a tolerance")
                settings["answer"] = _number(m.group(1), "answer", heading)
                if m.group(2):
                    settings["tolerance"] = _number(m.group(2), "tolerance", heading)
            elif key == "tolerance":
                settings["tolerance"] = _number(value, "tolerance", heading)
            elif key == "range":
                m = RANGE.match(value)
                if not m:
                    raise FormatError(f"Question {heading!r}: range {value!r} should read like 1-5")
                settings["min"] = _number(m.group(1), "range", heading)
                settings["max"] = _number(m.group(2), "range", heading)
            elif key == "labels":
                low, _, high = value.partition("|")
                settings["min_label"], settings["max_label"] = low.strip(), high.strip()
            elif key in ("max_words", "max_length"):
                settings[key] = int(_number(value, key.replace("_", " "), heading))
            elif key == "unit":
                settings["unit"] = value
            elif key == "figure":
                figure = value
            continue
        m = CHOICE_LINE.match(line.strip())
        if m:
            is_correct = m.group(1).lower() == "x"
            choices.append((is_correct, m.group(2).strip()))
        else:
            body_lines.append(line)

    text = "\n".join(body_lines).strip()
    if kind == "point" and figure is None:
        # The first figure in the text is the one to tap; it moves out of the
        # text so it is not shown twice.
        m = IMAGE_REF.search(text)
        if not m:
            raise FormatError(f"Question {heading!r}: a point question needs a figure")
        figure = m.group(2)
        text = (text[: m.start()] + text[m.end():]).strip()
    text = _resolve_images(text, source_dir)
    if figure and _is_local(figure) and not (source_dir / figure).is_file():
        raise FormatError(f"Referenced image not found: {figure}")

    correct_count = sum(1 for c, _ in choices if c)
    if kind in ("choice", "multi", "rank"):
        if len(choices) < 2:
            raise FormatError(f"Question {heading!r} has fewer than 2 choices")
        if kind == "choice" and correct_count > 1:
            raise FormatError(
                f"Question {heading!r} has {correct_count} choices marked [x]; a single-choice "
                "question has at most 1 (use `type: multi` for several)"
            )
        if kind == "rank" and correct_count:
            raise FormatError(f"Question {heading!r}: a ranking has no choice marked [x]")
    elif choices:
        raise FormatError(f"Question {heading!r}: a {kind} question has no `- [ ]` choices")

    question = {
        "text": text,
        "choices": [{"text": t, "is_correct": c} for c, t in choices],
        "mode": mode,
    }
    if kind != "choice":
        question["kind"] = kind
    if settings:
        question["settings"] = settings
    if figure:
        question["image_url"] = figure
    return question


def question_payload(q: dict) -> dict:
    """The JSON for POST /api/quizzes/{id}/questions."""
    payload = {"text": q["text"], "choices": q["choices"], "mode": q.get("mode", "twice")}
    for key in ("kind", "settings", "image_url"):
        if key in q:
            payload[key] = q[key]
    return payload


def _resolve_images(text: str, source_dir: Path) -> str:
    """Record which local files need uploading; actual upload happens later.

    Kept as a separate pass (`_local_image_paths` + `_replace_images`) so
    --dry-run can validate file existence without ever opening a network
    connection.
    """
    for _, path, _ in IMAGE_REF.findall(text):
        if _is_local(path) and not (source_dir / path).is_file():
            raise FormatError(f"Referenced image not found: {path}")
    return text


def _is_local(path: str) -> bool:
    return not path.startswith(("http://", "https://", "/api/"))


def _local_image_paths(quiz: dict) -> set[str]:
    paths = set()
    for q in quiz["questions"]:
        for _, path, _ in IMAGE_REF.findall(q["text"]):
            if _is_local(path):
                paths.add(path)
        if q.get("image_url") and _is_local(q["image_url"]):
            paths.add(q["image_url"])
    return paths


def upload_images(client: httpx.Client, quiz: dict, source_dir: Path) -> None:
    """Upload every local figure once, then rewrite all references to it."""
    uploaded: dict[str, str] = {}
    for path in _local_image_paths(quiz):
        with open(source_dir / path, "rb") as f:
            content_type = _guess_content_type(path)
            resp = client.post("/api/images", files={"file": (Path(path).name, f, content_type)})
        if resp.status_code != 201:
            raise FormatError(f"Uploading {path} failed: {resp.status_code} {resp.text[:200]}")
        uploaded[path] = resp.json()["url"]

    def replace(match: re.Match) -> str:
        alt, path, attrs = match.group(1), match.group(2), match.group(3) or ""
        url = uploaded.get(path, path)
        return f"![{alt}]({url}){attrs}"

    for q in quiz["questions"]:
        q["text"] = IMAGE_REF.sub(replace, q["text"])
        if q.get("image_url"):
            q["image_url"] = uploaded.get(q["image_url"], q["image_url"])


def _guess_content_type(path: str) -> str:
    suffix = Path(path).suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }.get(suffix, "application/octet-stream")


def create_quiz(client: httpx.Client, quiz: dict) -> int:
    resp = client.post("/api/quizzes", json={"title": quiz["title"]})
    if resp.status_code != 201:
        raise FormatError(f"Creating the quiz failed: {resp.status_code} {resp.text[:200]}")
    quiz_id = resp.json()["id"]

    for q in quiz["questions"]:
        resp = client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json=question_payload(q),
        )
        if resp.status_code != 201:
            raise FormatError(
                f"Question {q['text'][:40]!r} failed: {resp.status_code} {resp.text[:200]}\n"
                f"Quiz {quiz_id} was already created and now has only the questions "
                "added before this one — quiz deletion is not implemented yet, so "
                "clean this up by hand if it matters."
            )
    return quiz_id


def print_summary(quiz: dict) -> None:
    print(f"Quiz: {quiz['title']}")
    for i, q in enumerate(quiz["questions"], 1):
        first_line = q["text"].splitlines()[0]
        mode = "" if q.get("mode", "twice") == "twice" else f"   (mode: {q['mode']})"
        kind = f"   [{q['kind']}]" if "kind" in q else ""
        print(f"\n  {i}. {first_line}{kind}{mode}")
        if q.get("settings"):
            print("     " + ", ".join(f"{k}: {v}" for k, v in q["settings"].items()))
        if q.get("image_url"):
            print(f"     figure: {q['image_url']}")
        for c in q["choices"]:
            mark = "x" if c["is_correct"] else " "
            print(f"     [{mark}] {c['text']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("markdown_file", type=Path)
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--teacher", help="Username to mock-login as (dev only)")
    parser.add_argument("--cookie", help="Existing quizbinf_session cookie value, instead of mock-login")
    parser.add_argument("--dry-run", action="store_true", help="Parse and validate only; no network calls")
    args = parser.parse_args()

    text = args.markdown_file.read_text()
    source_dir = args.markdown_file.resolve().parent

    try:
        quiz = parse_quiz(text, source_dir)
    except FormatError as e:
        print(f"Format error: {e}", file=sys.stderr)
        sys.exit(1)

    print_summary(quiz)

    if args.dry_run:
        print("\n(dry run — nothing was sent to the server)")
        return

    if not args.teacher and not args.cookie:
        print("\nNeed --teacher (mock login) or --cookie to actually import", file=sys.stderr)
        sys.exit(1)

    with httpx.Client(base_url=args.base_url) as client:
        if args.cookie:
            client.cookies.set("quizbinf_session", args.cookie)
        else:
            resp = client.post("/api/auth/mock-login", json={"username": args.teacher})
            if resp.status_code != 200:
                print(f"Mock login failed: {resp.status_code} {resp.text[:200]}", file=sys.stderr)
                sys.exit(1)

        try:
            upload_images(client, quiz, source_dir)
            quiz_id = create_quiz(client, quiz)
        except FormatError as e:
            print(f"\nImport error: {e}", file=sys.stderr)
            sys.exit(1)

    print(f"\nCreated quiz {quiz_id} with {len(quiz['questions'])} question(s).")


if __name__ == "__main__":
    main()
