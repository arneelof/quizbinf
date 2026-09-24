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


def _parse_question(block: list[str], source_dir: Path) -> dict:
    heading = QUESTION_HEADING.match(block[0]).group(1).strip()
    body_lines = [heading]
    choices: list[tuple[bool, str]] = []
    mode = "twice"

    for line in block[1:]:
        mode_match = MODE_LINE.match(line.strip())
        if mode_match:
            mode = mode_match.group(1).lower().replace("-", "_")
            continue
        m = CHOICE_LINE.match(line.strip())
        if m:
            is_correct = m.group(1).lower() == "x"
            choices.append((is_correct, m.group(2).strip()))
        else:
            body_lines.append(line)

    text = "\n".join(body_lines).strip()
    text = _resolve_images(text, source_dir)

    if len(choices) < 2:
        raise FormatError(f"Question {heading!r} has fewer than 2 choices")
    correct_count = sum(1 for c, _ in choices if c)
    if correct_count != 1:
        raise FormatError(
            f"Question {heading!r} has {correct_count} choices marked [x]; needs exactly 1"
        )

    return {
        "text": text,
        "choices": [{"text": t, "is_correct": c} for c, t in choices],
        "mode": mode,
    }


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
            json={"text": q["text"], "choices": q["choices"], "mode": q.get("mode", "twice")},
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
        print(f"\n  {i}. {first_line}{mode}")
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
