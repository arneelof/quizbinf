# Authoring quizzes in Markdown

Quizzes can be authored by hand in the teacher UI, or written as a plain
Markdown file and loaded with `backend/scripts/import_quiz.py`. This is the
format that script expects, and the source of truth for it — a copy adapted
for a specific course's own repository should point back here rather than
duplicate the rules.

## Format

```markdown
# Quiz title

## What does the perceptron's activation function compute?

Optional further paragraphs of question text — it is all rendered as
Markdown, sanitised on the server, exactly like a question typed into the
authoring UI. A figure can go here too:

![](rosenblatt-perceptron.png){width=60%}

- [ ] The sigmoid of the weighted sum
- [x] The sign of the weighted sum
- [ ] The softmax over all inputs
- [ ] The mean of the inputs

## Which gate did the two-input example (w0=0.9, w1=-0.6, w2=-0.5) implement?

- [ ] AND
- [ ] OR
- [x] NAND
- [ ] XOR
```

Rules, matching what `app/schemas.py` enforces server-side:

- One `# Title` heading, anywhere before the first question — that becomes
  the quiz title.
- One `## Heading` per question. Everything between one `##` and the next is
  that question's body: as many lines and paragraphs as needed, itself
  Markdown, rendered and sanitised the same way the authoring UI's questions
  are (`app/markdown.py`).
- Choices are `- [ ]` / `- [x]` lines anywhere in the question's block
  (conventionally at the end, after the body text). **Exactly one** must be
  `[x]` — the importer refuses a question with zero or more than one, the
  same rule `QuestionIn` enforces on the API.
- At least two choices per question.
- A figure reference whose path is not `http(s)://` or `/api/...` is treated
  as local: resolved relative to the Markdown file's own directory, uploaded
  through `POST /api/images` and rewritten to the URL the server returns.
  `{width=NN%}` / `{width=NN}` after the image — the general attrs syntax
  `app/markdown.py` already supports — carries through unchanged.
- Anything before the `#` title is ignored, so a chapter's own notes or a
  changelog above the quiz content do not need to be stripped out first.

## Running the importer

```bash
cd backend && . .venv/bin/activate

# Check the file parses and see what would be created — no network calls
# except confirming local image files exist.
python scripts/import_quiz.py --dry-run path/to/quiz.md

# Against a local dev server (mock login, teacher username from
# TEACHER_USERNAMES in .env):
python scripts/import_quiz.py --base-url http://localhost:8000 --teacher arne path/to/quiz.md

# Against a real deployment: mock login is unavailable there, so pass an
# existing teacher session cookie instead (copy the `quizbinf_session`
# cookie value from a logged-in browser tab — same approach loadtest/lecture.py
# uses for QUIZBINF_TEACHER_COOKIE).
python scripts/import_quiz.py --base-url https://quizbinf.example.edu --cookie <value> path/to/quiz.md
```

**Quiz deletion is not implemented yet** (see the repo's `CLAUDE.md`), so a
bad import cannot be undone by re-running the script — it only adds another
quiz. Always `--dry-run` first; questions can still be fixed individually
afterwards through the authoring UI (editing is safe at any time, including
after a question has been asked), but a whole quiz cannot currently be
deleted and recreated.

## Writing good peer-instruction questions

This app exists for the Mazur-style pre/post pattern documented in the
repo's `CLAUDE.md`: a question is answered once, discussed with a neighbour,
then answered again. That shapes what makes a question worth importing:

- Test a concept, not recall of a fact stated verbatim on a slide — a
  question every student gets right without discussion wastes the two
  rounds.
- Wrong choices should be *plausible* — a common misconception or a nearby
  concept, not a choice nobody would pick. A question where the wrong
  choices are obviously wrong does not produce a distribution worth
  discussing.
- One question tests one idea. If a question needs two paragraphs of setup
  to state unambiguously, it is probably two questions.
- Prefer 4 choices; 3 is acceptable for a genuinely binary distinction, more
  than 5 tends to bury the plausible distractors among throwaway ones.
