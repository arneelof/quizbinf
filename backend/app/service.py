"""Round lifecycle and answering rules.

This module is the heart of the app: it enforces when rounds may open/close
and when answers are accepted. The server is the single source of truth for
whether a round is open — clients never decide based on their own clock.
"""

import json
import math
import random
import re
import statistics
from collections import Counter
from collections.abc import Iterable
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import access
from .config import get_settings
from .db import insert_ignoring_conflict, write_path, writing
from .models import (
    Answer,
    Choice,
    DeviceClaim,
    Phase,
    QuestionKind,
    QuestionMode,
    Question,
    Quiz,
    QuizSession,
    RosterEntry,
    Round,
    SessionParticipant,
    User,
    utcnow,
)


class RuleViolation(Exception):
    """A domain rule was violated; maps to HTTP 409 at the API layer."""


class InvalidQuestion(RuleViolation):
    """An edit that breaks the rules for its kind of question; HTTP 422, the
    same as when the request itself fails validation."""


@write_path
def open_round(db: Session, session: QuizSession, question: Question, phase: Phase) -> Round:
    """Open a round for `question` in `session`.

    Rules:
    - Only one round may be open per session at a time.
    - A round (question x phase) can be opened only once — no reopening.
    - The post round requires the pre round of the same question to be closed.
    """
    if question.quiz_id != session.quiz_id:
        raise RuleViolation("Question does not belong to this session's quiz")
    # Lock the session for the length of this decision. Without the write gate
    # two clicks a moment apart — a teacher's double tap, or the projected view
    # and the phone remote — could both read "nothing open" and open a round
    # each. Two open rounds is worse than a refused click: `get_open_round`
    # expects at most one and would raise for everyone in the session, mid
    # question. Postgres holds the lock until this transaction ends; SQLite
    # ignores it and has the gate.
    db.execute(select(QuizSession.id).where(QuizSession.id == session.id).with_for_update())
    if get_open_round(db, session) is not None:
        raise RuleViolation("Another round is already open in this session")
    existing = db.scalar(
        select(Round).where(
            Round.session_id == session.id,
            Round.question_id == question.id,
            Round.phase == phase,
        )
    )
    if existing is not None:
        raise RuleViolation(f"The {phase.value} round for this question was already run")
    if phase not in question.mode.phases:
        raise RuleViolation("This question is asked only once")
    if phase == Phase.post:
        pre = db.scalar(
            select(Round).where(
                Round.session_id == session.id,
                Round.question_id == question.id,
                Round.phase == Phase.pre,
            )
        )
        if pre is None or pre.is_open:
            raise RuleViolation("The post round requires a closed pre round first")
    round_ = Round(session_id=session.id, question_id=question.id, phase=phase)
    db.add(round_)
    db.commit()
    db.refresh(round_)
    return round_


@write_path
def close_round(db: Session, round_: Round) -> Round:
    if not round_.is_open:
        raise RuleViolation("Round is already closed")
    round_.closed_at = utcnow()
    db.commit()
    db.refresh(round_)
    return round_


def get_open_round(db: Session, session: QuizSession) -> Round | None:
    return db.scalar(
        select(Round).where(Round.session_id == session.id, Round.closed_at.is_(None))
    )


def get_round(db: Session, session: QuizSession, question_id: int, phase: Phase) -> Round | None:
    return db.scalar(
        select(Round).where(
            Round.session_id == session.id,
            Round.question_id == question_id,
            Round.phase == phase,
        )
    )


def get_last_closed_round(db: Session, session: QuizSession) -> Round | None:
    """Most recently closed round in this session, for showing students the

    result on their own device once the teacher halts submissions. Callers
    should only use this when `get_open_round` is None — a closed round from
    earlier in the session should not resurface once a new one has opened.
    """
    return db.scalar(
        select(Round)
        .where(Round.session_id == session.id, Round.closed_at.is_not(None))
        .order_by(Round.closed_at.desc())
        .limit(1)
    )


#: Longest word or phrase kept from a `word` answer.
WORD_LENGTH = 40
#: Default number of words per `word` answer and characters per `text` answer.
DEFAULT_MAX_WORDS = 3
DEFAULT_MAX_LENGTH = 500


def normalise_word(word: str) -> str:
    """One entry of a word answer, tidied: trimmed, inner whitespace collapsed,
    surrounding punctuation dropped, cut to WORD_LENGTH."""
    word = re.sub(r"\s+", " ", word).strip().strip(".,;:!?\"'()[]")
    return word[:WORD_LENGTH].strip()


def answer_value(question: Question, body) -> tuple[int | None, object]:
    """Check an `AnswerIn` against the question's kind.

    Returns what is stored: (choice id, None) for a `choice` question and
    (None, value) for every other kind. Raises RuleViolation for an answer
    that does not fit the question, which the API turns into a 409 the
    student's phone shows.
    """
    kind = question.kind
    cfg = question.config
    choice_ids = {c.id for c in question.choices}
    if kind is QuestionKind.choice:
        if body.choice_id not in choice_ids:
            raise RuleViolation("Choice does not belong to the round's question")
        return body.choice_id, None
    if kind in (QuestionKind.multi, QuestionKind.rank):
        picked = list(body.choice_ids or [])
        if len(set(picked)) != len(picked) or not set(picked) <= choice_ids:
            raise RuleViolation("Choice does not belong to the round's question")
        if kind is QuestionKind.rank and set(picked) != choice_ids:
            raise RuleViolation("Put every choice in order")
        if kind is QuestionKind.multi and not picked:
            raise RuleViolation("Tick at least one choice")
        return None, picked
    if kind in (QuestionKind.number, QuestionKind.scale):
        x = body.number
        if x is None or not math.isfinite(x):
            raise RuleViolation("Give a number")
        lo, hi = cfg.get("min"), cfg.get("max")
        if kind is QuestionKind.scale:
            lo, hi = lo if lo is not None else 1, hi if hi is not None else 5
            if x != int(x):
                raise RuleViolation("Pick a value on the scale")
            x = int(x)
        if (lo is not None and x < lo) or (hi is not None and x > hi):
            raise RuleViolation(f"Give a number between {lo:g} and {hi:g}" if lo is not None
                                and hi is not None else "That number is out of range")
        return None, x
    if kind is QuestionKind.word:
        words = [normalise_word(w) for w in (body.words or [])]
        # One of each, ignoring case: "Magic" and "magic" are one vote.
        seen: set[str] = set()
        words = [w for w in words if w and not (w.lower() in seen or seen.add(w.lower()))]
        if not words:
            raise RuleViolation("Write at least one word")
        if len(words) > cfg.get("max_words", DEFAULT_MAX_WORDS):
            raise RuleViolation(f"At most {cfg.get('max_words', DEFAULT_MAX_WORDS)} words")
        return None, words
    if kind is QuestionKind.text:
        text = (body.text or "").strip()
        if not text:
            raise RuleViolation("Write an answer")
        if len(text) > cfg.get("max_length", DEFAULT_MAX_LENGTH):
            raise RuleViolation(
                f"At most {cfg.get('max_length', DEFAULT_MAX_LENGTH)} characters")
        return None, text
    if kind is QuestionKind.point:
        if not body.point or not all(math.isfinite(v) and 0 <= v <= 1 for v in body.point):
            raise RuleViolation("Tap on the figure")
        return None, [round(body.point[0], 4), round(body.point[1], 4)]
    raise RuleViolation("Unknown question kind")  # pragma: no cover


def answer_out(answer: Answer | None) -> dict | None:
    """A stored answer in `AnswerIn`'s shape, for the student's own phone."""
    if answer is None:
        return None
    kind = answer.round.question.kind
    if kind is QuestionKind.choice:
        return {"choice_id": answer.choice_id}
    key = {QuestionKind.multi: "choice_ids", QuestionKind.rank: "choice_ids",
           QuestionKind.number: "number", QuestionKind.scale: "number",
           QuestionKind.word: "words", QuestionKind.text: "text",
           QuestionKind.point: "point"}[kind]
    return {key: answer.data}


def is_correct(question: Question, answer: Answer) -> bool | None:
    """Whether an answer is right; None for a question without a right answer."""
    if not question.graded:
        return None
    if question.kind is QuestionKind.choice:
        return any(c.is_correct and c.id == answer.choice_id for c in question.choices)
    if question.kind is QuestionKind.multi:
        return set(answer.data or []) == {c.id for c in question.choices if c.is_correct}
    if question.kind is QuestionKind.number:
        cfg = question.config
        return abs(float(answer.data) - cfg["answer"]) <= cfg.get("tolerance", 0) + 1e-9
    return None


@write_path
def submit_answer(
    db: Session, round_: Round, user: User, choice: Choice | None = None, value: object = None
) -> Answer:
    """Record `user`'s answer; one answer per user per round, last write wins
    while the round is open.

    `choice` for a `choice` question; `value` (from `answer_value`) for every
    other kind.

    On Postgres this runs alongside every other answer in the room, so the two
    things the write gate used to guarantee are arranged here instead:

    * **The round cannot close underneath it.** The round is re-read holding a
      share lock on its row, which `close_round` must update and therefore
      waits for; an answer arriving after the close has committed re-reads it
      as closed and is refused. The submission window is the attendance guard,
      so it has to hold to the commit and not merely to the check. The re-read
      matters on SQLite too: the caller loaded `round_` before this queued for
      the gate, and it may have closed in between.
    * **The same student may arrive twice at once** — a phone re-sending after
      a 502 while the first attempt is still in flight. Both find no row and
      both insert; the unique constraint refuses one, and that one runs again
      and updates the row the winner wrote.
    """
    if choice is not None and choice.question_id != round_.question_id:
        raise RuleViolation("Choice does not belong to the round's question")
    if choice is None and value is None:
        raise RuleViolation("No answer given")
    choice_id = choice.id if choice is not None else None
    stored = json.dumps(value) if value is not None else None
    for attempt in range(2):
        db.refresh(round_, with_for_update={"read": True})
        if not round_.is_open:
            raise RuleViolation("This round is closed")
        answer = db.scalar(
            select(Answer).where(Answer.round_id == round_.id, Answer.user_id == user.id)
        )
        if answer is None:
            answer = Answer(round_id=round_.id, user_id=user.id, choice_id=choice_id, value=stored)
            db.add(answer)
        else:
            answer.choice_id = choice_id
            answer.value = stored
            answer.hidden = False
            answer.submitted_at = utcnow()
        try:
            db.commit()
        except IntegrityError:
            # Lost to the student's own other request. Start again: the second
            # pass finds the row and updates it.
            db.rollback()
            if attempt:
                raise
            continue
        db.refresh(answer)
        return answer


@write_path
def set_answer_hidden(db: Session, session: QuizSession, answer_id: int, hidden: bool) -> Answer:
    """Take a text answer off the projected results, or put it back."""
    answer = db.get(Answer, answer_id)
    if answer is None or answer.round.session_id != session.id:
        raise RuleViolation("No such answer in this session")
    answer.hidden = hidden
    db.commit()
    return answer


#: How stale `last_seen_at` may get before it is worth a write.
#:
#: Nothing in the app reads it — `joined` is a row count and `connected` comes
#: from the SSE broadcaster — so refreshing it on every call bought nothing
#: and cost a write transaction each time. That matters because a student
#: arriving already causes three of them (login, `/state`, the SSE connect),
#: every reconnect causes another, and writes serialise: a rehearsal against
#: the deployment logged a single login holding its slot for 25 seconds while
#: two hundred arrived at once, on a mounted volume far slower than a local
#: disk. The value keeps its meaning to the minute in case something reads it
#: later; what it stops being is a write per request.
PARTICIPANT_TOUCH_SECONDS = 60


def _participant_is_current(participant: SessionParticipant | None) -> bool:
    if participant is None:
        return False
    seen = participant.last_seen_at
    if seen.tzinfo is None:  # SQLite hands back naive datetimes
        seen = seen.replace(tzinfo=timezone.utc)
    return (utcnow() - seen).total_seconds() < PARTICIPANT_TOUCH_SECONDS


def record_participant(db: Session, session: QuizSession, user: User) -> None:
    """Note that `user` has the session open. Idempotent; safe to call often.

    Deliberately *not* a `@write_path`, and this is the one place in the app
    where that distinction is worth spelling out. It is called from `/state`
    and from the SSE connect, so it runs on every request a student makes,
    while the throttle above means it actually writes on almost none of them.
    Declaring the whole function a writer would take the process-wide write
    lock for every one of those reads and serialise the entire application
    behind them — which is precisely the failure the split in `db.py` exists
    to avoid, reintroduced from the busiest path in the app.

    So the read happens first, concurrently, outside the lock; only the rare
    case that has something to write asks for it, and re-reads inside the
    write transaction because the row may have appeared in between.
    """
    look_up = select(SessionParticipant).where(
        SessionParticipant.session_id == session.id,
        SessionParticipant.user_id == user.id,
    )
    participant = db.scalar(look_up)
    if _participant_is_current(participant):
        # End the transaction the SELECT opened: a Session holding one keeps a
        # pooled connection checked out, and skipping the write must not turn
        # into holding a connection instead.
        db.commit()
        return

    db.commit()  # a deferred transaction cannot be promoted; close it first
    with writing(db):
        participant = db.scalar(look_up)
        if participant is not None:
            if not _participant_is_current(participant):
                participant.last_seen_at = utcnow()
            db.commit()
            return
        # A student's first load fetches the state and opens the SSE stream at
        # almost the same moment, so two requests reach this line together and
        # one of them loses. Losing is not an error — the row exists, which is
        # all this function wanted — so the insert is written to do nothing on
        # conflict rather than to be refused and rolled back. Under the write
        # gate the race could not happen inside one process; on Postgres,
        # where the gate is off, the deployment logged one refusal per student
        # joining a lecture.
        insert_ignoring_conflict(
            db,
            SessionParticipant,
            session_id=session.id,
            user_id=user.id,
            joined_at=utcnow(),
            last_seen_at=utcnow(),
        )
        db.commit()


#: Mirrors `routers.auth.LOADTEST_PREFIX`. Defined here rather than imported
#: to keep the service layer free of router imports; the test below pins the
#: two together so they cannot drift.
LOADTEST_PREFIX = "loadtest-"


@write_path
def delete_loadtest_session(db: Session, session: QuizSession) -> dict:
    """Delete a rehearsal, its answers, and the throwaway students it created.

    Callers must have established that this is a load-test session — the
    router does, and refuses otherwise. Nothing else in the app deletes a
    session, deliberately.

    Written as a handful of set-based statements rather than a loop over two
    hundred ORM objects. The loop was correct and unusable: it issued roughly
    six hundred statements, and this runs against a deployment where a single
    indexed query has been measured at thirty seconds with nothing else in
    flight. Cleaning up after a rehearsal must not itself need a healthy
    server — it is most needed when the server is not.
    """
    round_ids = list(db.scalars(select(Round.id).where(Round.session_id == session.id)))
    answers = (
        db.scalar(
            select(func.count()).select_from(Answer).where(Answer.round_id.in_(round_ids))
        )
        or 0
        if round_ids
        else 0
    )

    # The throwaway students to remove: those with no answer left anywhere
    # once this session's are gone. A rehearsal account cannot appear in a
    # real lecture, but this costs one statement and removes the need for
    # that to stay true.
    doomed = list(
        db.scalars(
            select(User.id).where(
                User.username.startswith(LOADTEST_PREFIX),
                ~User.id.in_(
                    select(Answer.user_id)
                    .join(Round, Round.id == Answer.round_id)
                    .where(Round.session_id != session.id)
                ),
            )
        )
    )
    participants = (
        db.scalar(
            select(func.count())
            .select_from(SessionParticipant)
            .where(SessionParticipant.session_id == session.id)
        )
        or 0
    )

    if round_ids:
        db.execute(delete(Answer).where(Answer.round_id.in_(round_ids)))
        db.execute(delete(Round).where(Round.id.in_(round_ids)))
    db.execute(
        delete(SessionParticipant).where(SessionParticipant.session_id == session.id)
    )
    if doomed:
        # Every participant row these users have, not merely this session's: a
        # rehearsal that crashed and was re-run leaves the same names in more
        # than one session, and deleting the user while a row still pointed at
        # them left a participant belonging to nobody — the shape of the bug
        # where a deleted question's rounds outlived it and made the
        # participation report raise instead of render.
        db.execute(delete(SessionParticipant).where(SessionParticipant.user_id.in_(doomed)))
        db.execute(
            delete(DeviceClaim).where(
                DeviceClaim.username.in_(select(User.username).where(User.id.in_(doomed)))
            )
        )
        db.execute(delete(User).where(User.id.in_(doomed)))
    db.execute(delete(QuizSession).where(QuizSession.id == session.id))
    db.commit()

    return {
        "rounds": len(round_ids),
        "answers": answers,
        "participants": participants,
        "users": len(doomed),
    }


def participant_count(db: Session, session: QuizSession) -> int:
    """How many distinct people have opened this session."""
    return (
        db.scalar(
            select(func.count())
            .select_from(SessionParticipant)
            .where(SessionParticipant.session_id == session.id)
        )
        or 0
    )


def participation_report(db: Session, session: QuizSession) -> list[dict]:
    """Per-student answers for a session, for the teacher only.

    This is personal data, unlike every other view in the app: it says who
    answered what. It exists because the quiz is formative — the teacher wants
    to see who is following along — so it reports correctness per question and
    nothing else about the student beyond their username and name.

    Rows are sorted by name so the table is stable between reloads.
    """
    # A round whose question no longer exists cannot be scored, and must not
    # take the whole report down with it: earlier builds allowed a used
    # question to be deleted, so this data exists in the wild.
    rounds = sorted(
        (r for r in session.rounds if r.question is not None),
        key=lambda r: (r.question_id, r.phase.value),
    )
    # user_id -> question_id -> phase -> right (True/False), or True for a
    # question without a right answer, where it means only "answered"
    chosen: dict[int, dict[int, dict[str, bool]]] = {}
    users: dict[int, User] = {}
    for round_ in rounds:
        for answer in round_.answers:
            users[answer.user_id] = answer.user
            right = is_correct(round_.question, answer)
            chosen.setdefault(answer.user_id, {}).setdefault(round_.question_id, {})[
                round_.phase.value
            ] = True if right is None else right

    # Anyone who opened the session counts, even if they never answered:
    # "joined but silent" is exactly what a teacher wants to notice.
    for participant in db.scalars(
        select(SessionParticipant).where(SessionParticipant.session_id == session.id)
    ):
        users.setdefault(participant.user_id, participant.user)

    question_ids = [q.id for q in session.quiz.questions]
    graded = {q.id: q.graded for q in session.quiz.questions}

    rows: list[dict] = []
    for user_id, user in users.items():
        per_question = []
        pre_correct = post_correct = answered = 0
        for question_id in question_ids:
            picks = chosen.get(user_id, {}).get(question_id, {})
            pre, post = picks.get("pre"), picks.get("post")
            answered += sum(1 for v in (pre, post) if v is not None)
            if graded[question_id]:
                pre_correct += 1 if pre else 0
                post_correct += 1 if post else 0
            per_question.append({"question_id": question_id, "pre": pre, "post": post,
                                 "graded": graded[question_id]})
        rows.append(
            {
                "username": user.username,
                "display_name": user.display_name,
                "answers": per_question,
                "answered": answered,
                "pre_correct": pre_correct,
                "post_correct": post_correct,
            }
        )
    rows.sort(key=lambda r: (r["display_name"].lower(), r["username"]))
    return rows


def sessions_in_range(
    db: Session,
    teacher: User,
    start: date | None = None,
    end: date | None = None,
) -> list[QuizSession]:
    """The teacher's own *lectures*, oldest first, within an optional date range.

    Shared by both end-of-term reports so they cannot disagree about which
    lectures are in scope — including the end date being inclusive, which is
    what a person means by "to the 12th".

    Load-test sessions are excluded here, in the one place both reports go
    through. A rehearsal run against the live app is a session that ran rounds
    like any other, so leaving it in would put it in the Canvas gradebook
    denominator and mark every real student absent from a lecture that never
    happened — and nothing in the app deletes a session, so the damage would
    stand. Filtering at the source means a report added later inherits the
    exclusion instead of having to remember it.
    """
    query = (
        select(QuizSession)
        .join(Quiz, QuizSession.quiz_id == Quiz.id)
        .where(QuizSession.is_loadtest.is_(False), QuizSession.is_anonymous.is_(False))
        .order_by(QuizSession.created_at, QuizSession.id)
    )
    # With shared quizzes every teacher reports on every lecture; otherwise a
    # teacher sees only the lectures of their own quizzes.
    if not get_settings().shared_quizzes:
        query = query.where(Quiz.owner_id == teacher.id)
    if start is not None:
        query = query.where(QuizSession.created_at >= datetime.combine(start, time.min))
    if end is not None:
        query = query.where(QuizSession.created_at <= datetime.combine(end, time.max))
    return list(db.scalars(query))


def semester_participation(
    db: Session,
    teacher: User,
    start: date | None = None,
    end: date | None = None,
) -> dict:
    """Attendance across every session a teacher ran, for end-of-term reporting.

    Answers one question per student per session: did they take part in both
    bouts? Correctness is deliberately absent — this is the attendance record,
    not a mark.

    "Took part" means the student answered every round of every question that
    was fully asked in that session: both the pre and the post round, or just
    the one round of a question whose mode is `once`. A question that never
    got its second bout is not counted against anyone, and a session where no
    question was fully asked has nothing to attend, reported as None rather
    than a failure.

    `pairs` is carried alongside the yes/no so a partial attendance is still
    visible: a strict all-or-nothing verdict would otherwise hide a student
    who answered three of four questions.
    """
    sessions = sessions_in_range(db, teacher, start, end)

    users: dict[int, User] = {}
    # user_id -> session_id -> (pairs_completed, pairs_asked)
    tally: dict[int, dict[int, tuple[int, int]]] = {}

    for session in sessions:
        # question_id -> phase -> round
        by_question: dict[int, dict[str, Round]] = {}
        for round_ in session.rounds:
            if round_.question is None:
                continue  # stranded by a question deleted under an older build
            by_question.setdefault(round_.question_id, {})[round_.phase.value] = round_
        # Each fully asked question, as the rounds a student had to answer.
        both_bouts = []
        for phases in by_question.values():
            needed = [phase.value for phase in next(iter(phases.values())).question.mode.phases]
            if all(p in phases for p in needed):
                both_bouts.append([phases[p] for p in needed])

        answered_in: dict[int, set[int]] = {}  # round_id -> user ids
        for phases in by_question.values():
            for round_ in phases.values():
                answered_in[round_.id] = {a.user_id for a in round_.answers}
                for answer in round_.answers:
                    users[answer.user_id] = answer.user

        for participant in db.scalars(
            select(SessionParticipant).where(SessionParticipant.session_id == session.id)
        ):
            users.setdefault(participant.user_id, participant.user)

        for user_id in users:
            completed = sum(
                1
                for needed in both_bouts
                if all(user_id in answered_in[r.id] for r in needed)
            )
            tally.setdefault(user_id, {})[session.id] = (completed, len(both_bouts))

    rows = []
    for user_id, user in sorted(users.items(), key=lambda kv: kv[1].username):
        per_session = []
        attended = 0
        for session in sessions:
            completed, asked = tally.get(user_id, {}).get(session.id, (0, 0))
            took_part = None if asked == 0 else completed == asked
            if took_part:
                attended += 1
            per_session.append(
                {"completed": completed, "asked": asked, "took_part": took_part}
            )
        rows.append(
            {
                "username": user.username,
                "display_name": user.display_name,
                "sessions": per_session,
                "attended": attended,
            }
        )

    return {
        "sessions": [
            {"code": s.code, "title": s.quiz.title, "date": s.created_at.date().isoformat()}
            for s in sessions
        ],
        "students": rows,
    }


#: How much of a lecture's answering a student must do to be counted present.
#: Not all of it: somebody always misses a window by seconds, loses signal, or
#: arrives during the first question, and none of that is absence. Four
#: questions asked twice is eight chances, of which six must be taken.
DEFAULT_ANSWER_THRESHOLD = 0.75


def session_answering(
    db: Session, session: QuizSession
) -> tuple[dict[int, User], dict[int, int], int]:
    """Who was in this lecture, how many bouts each answered, and how many ran.

    One definition of a "chance" and of who counts, shared by the per-session
    and end-of-term Canvas files so the two cannot disagree about the same
    lecture. Every round is one chance; a round whose question was deleted
    under an older build is not counted as a chance nobody took.

    A student who joined and answered nothing is in `users` with no entry in
    the counts — listed with a zero rather than left out, since they are
    exactly who the teacher wants to see.
    """
    rounds = [r for r in session.rounds if r.question is not None]
    users: dict[int, User] = {}
    answered: dict[int, int] = {}

    def note(user: User) -> bool:
        # The teacher runs the lecture rather than sitting it, and may well
        # have answered while testing the student view. A guest is nobody.
        if access.is_staff(session, user) or user.is_guest:
            return False
        users[user.id] = user
        return True

    for round_ in rounds:
        for answer in round_.answers:
            if note(answer.user):
                answered[answer.user_id] = answered.get(answer.user_id, 0) + 1
    for participant in db.scalars(
        select(SessionParticipant).where(SessionParticipant.session_id == session.id)
    ):
        note(participant.user)

    return users, answered, len(rounds)


def canvas_match_summary(db: Session, session: QuizSession, course_id: int) -> dict:
    """Whether the Canvas file for this lecture can actually be imported.

    A row with no Canvas id is skipped by Canvas silently, and the file still
    looks right: 114 rows, every mark filled in. That is how a lecture's
    attendance went missing — the teacher imported a correct-looking file and
    found a handful of marks in the gradebook, with nothing anywhere saying
    which rows Canvas had thrown away.

    So the same counting the export does is available before the download, and
    the unmatched are named. `synced_at` is the roster's age, the other half of
    the question: a roster from before the term filled up matches the students
    who registered early and nobody else.
    """
    users, _taken, _chances = session_answering(db, session)
    roster = {
        entry.username: entry
        for entry in db.scalars(
            select(RosterEntry).where(RosterEntry.course_id == course_id)
        )
    }
    unmatched = sorted(u.username for u in users.values() if u.username not in roster)
    synced_at = db.scalar(
        select(func.max(RosterEntry.synced_at)).where(RosterEntry.course_id == course_id)
    )
    return {
        "course_id": course_id,
        "students": len(users),
        "matched": len(users) - len(unmatched),
        "unmatched": unmatched,
        "roster_students": len(roster),
        "synced_at": synced_at,
    }


def canvas_participation(
    db: Session,
    teacher: User,
    course_id: int,
    start: date | None = None,
    end: date | None = None,
    threshold: float = DEFAULT_ANSWER_THRESHOLD,
) -> dict:
    """Attendance for the gradebook: one point per lecture the student worked.

    Worked, not attended. The bar is answering at least `threshold` of the
    bouts the lecture actually ran — every round counts as one chance, so four
    questions asked twice is eight chances and six of them must be taken.

    The bar is answering rather than logging in because a login proves nothing
    about being in the room: a student can sign in from anywhere. Answering
    most of the bouts means being present while each submission window was
    open, which is as close to attendance as this app can get. It is
    deliberately not *every* bout — someone always misses a window by seconds
    — which is what the threshold buys.

    A session that ran no rounds is dropped rather than scored: there was
    nothing to answer, so it can neither be attended nor missed, and leaving it
    in the denominator would mark the whole class down for a lecture that never
    asked anything.

    Canvas matches an imported row on an identifier it already holds, so the
    figures are useless on their own: they are keyed by KTH username, which
    Canvas does not store as such. The roster is what bridges the two, and it
    carries both identifiers Canvas will match on — the Canvas user id it tries
    first, and `kthid` (Canvas `sis_user_id`) behind it. Emitting both means an
    import does not depend on the course having SIS ids, which a manually
    created course may not.

    A student with no roster row is still reported, with no identifier and
    flagged as unmatched. Canvas will skip that row on import, but dropping it
    here would hide the mismatch from the teacher, and "why is this student
    missing a mark" is a worse problem to debug in the gradebook than in the
    file.
    """
    users: dict[int, User] = {}
    # user_id -> session_id -> bouts answered
    answered: dict[int, dict[int, int]] = {}
    # session_id -> bouts run
    chances: dict[int, int] = {}
    scored: list[QuizSession] = []

    for session in sessions_in_range(db, teacher, start, end):
        seen, taken, ran = session_answering(db, session)
        if not ran:
            continue
        scored.append(session)
        chances[session.id] = ran
        users.update(seen)
        for user_id, count in taken.items():
            answered.setdefault(user_id, {})[session.id] = count

    roster = {
        entry.username: entry
        for entry in db.scalars(
            select(RosterEntry).where(RosterEntry.course_id == course_id)
        )
    }

    rows = []
    for user_id, user in sorted(users.items(), key=lambda kv: kv[1].username):
        met = 0
        for session in scored:
            taken = answered.get(user_id, {}).get(session.id, 0)
            if taken / chances[session.id] >= threshold:
                met += 1
        entry = roster.get(user.username)
        rows.append(
            {
                "name": entry.display_name if entry else user.display_name,
                "username": user.username,
                "canvas_user_id": entry.canvas_user_id if entry else "",
                "sis_user_id": (entry.kthid if entry else None) or "",
                "attended": met,
                "matched": entry is not None,
            }
        )

    return {
        "threshold": threshold,
        "sessions": [
            {"code": s.code, "title": s.quiz.title, "date": s.created_at.date().isoformat()}
            for s in scored
        ],
        "students": rows,
    }


def session_canvas_participation(
    db: Session,
    session: QuizSession,
    course_id: int,
    threshold: float = DEFAULT_ANSWER_THRESHOLD,
) -> dict:
    """The Canvas gradebook file for a single lecture.

    Same bar as the end-of-term file, applied to one session: the student
    scores the point if they answered at least `threshold` of the bouts that
    ran. Out of one rather than out of a term's lectures, so it goes in as its
    own Canvas assignment for that lecture.

    Scored through the same `session_answering` as the term file, so the two
    cannot disagree about a lecture they both cover.
    """
    users, taken, chances = session_answering(db, session)
    roster = {
        entry.username: entry
        for entry in db.scalars(
            select(RosterEntry).where(RosterEntry.course_id == course_id)
        )
    }

    rows = []
    for user_id, user in sorted(users.items(), key=lambda kv: kv[1].username):
        # No rounds ran, so nothing could be answered or missed: score nobody
        # rather than mark the whole class down for a lecture that asked
        # nothing.
        met = bool(chances) and taken.get(user_id, 0) / chances >= threshold
        entry = roster.get(user.username)
        rows.append(
            {
                "name": entry.display_name if entry else user.display_name,
                "username": user.username,
                "canvas_user_id": entry.canvas_user_id if entry else "",
                "sis_user_id": (entry.kthid if entry else None) or "",
                "answered": taken.get(user_id, 0),
                "attended": 1 if met else 0,
                "matched": entry is not None,
            }
        )

    return {
        "threshold": threshold,
        "bouts": chances,
        "date": session.created_at.date().isoformat(),
        "title": session.quiz.title,
        "students": rows,
    }


@write_path
def sync_roster(db: Session, teacher: User, course_id: int, students: list[dict]) -> dict:
    """Replace the stored roster for a course with what Canvas just reported.

    A sync is a mirror, not an append: students who have dropped the course
    disappear, which is the point of syncing rather than uploading a
    spreadsheet once. Removing a roster entry removes nothing else — answers
    live in their own table and are untouched, so a student who drops still
    appears in the participation record for the sessions they attended.
    """
    existing = {
        entry.canvas_user_id: entry
        for entry in db.scalars(
            select(RosterEntry).where(RosterEntry.course_id == course_id)
        )
    }
    seen: set[int] = set()
    added = updated = 0
    now = utcnow()

    for student in students:
        canvas_user_id = student["canvas_user_id"]
        seen.add(canvas_user_id)
        entry = existing.get(canvas_user_id)
        if entry is None:
            db.add(
                RosterEntry(
                    course_id=course_id,
                    owner_id=teacher.id,
                    canvas_user_id=canvas_user_id,
                    kthid=student.get("kthid"),
                    username=student["username"],
                    display_name=student["display_name"],
                    synced_at=now,
                )
            )
            added += 1
        else:
            changed = (
                entry.kthid != student.get("kthid")
                or entry.username != student["username"]
                or entry.display_name != student["display_name"]
            )
            entry.kthid = student.get("kthid")
            entry.username = student["username"]
            entry.display_name = student["display_name"]
            entry.synced_at = now
            entry.owner_id = teacher.id
            if changed:
                updated += 1

    removed = 0
    for canvas_user_id, entry in existing.items():
        if canvas_user_id not in seen:
            db.delete(entry)
            removed += 1

    db.commit()
    return {
        "course_id": course_id,
        "total": len(students),
        "added": added,
        "updated": updated,
        "removed": removed,
    }


# A suggestion list is a way to read the roster, so it is deliberately a poor
# one: nothing is offered until enough has been typed to be near-specific, and
# only a handful of matches come back.
SUGGEST_MIN_CHARS = 3
SUGGEST_LIMIT = 8


def roster_suggestions(db: Session, course_id: int, prefix: str) -> list[str]:
    """Addresses on the course roster starting with `prefix`.

    Prefix rather than substring, and capped: this endpoint is reachable
    without logging in, so it must not become a way to page through the class.
    Someone determined can still enumerate it by trying many prefixes, which
    is why it is rate-limited at the router — a smaller hole than a dropdown
    that hands over the whole roster on page load, but a hole.
    """
    prefix = (prefix or "").strip().lower()
    # Typing the domain is natural; match on the part before it.
    prefix = prefix.split("@", 1)[0]
    if len(prefix) < SUGGEST_MIN_CHARS:
        return []
    entries = db.scalars(
        select(RosterEntry)
        .where(
            RosterEntry.course_id == course_id,
            RosterEntry.username.startswith(prefix),
        )
        .order_by(RosterEntry.username)
        .limit(SUGGEST_LIMIT)
    )
    return [e.username for e in entries]


def _as_utc(moment: datetime) -> datetime:
    """Stored timestamps come back naive from SQLite even for a timezone=True
    column, and comparing one against an aware `utcnow()` raises. Everything
    written here is UTC, so labelling it is enough."""
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def device_claim_conflict(
    db: Session, device_id: str, username: str, window_hours: int
) -> str | None:
    """The identity this device is already held to, if it is a different one.

    Returns None when the device is free, or is claiming the same identity
    again — signing in twice as yourself is not the thing being prevented.
    """
    if not device_id or window_hours <= 0:
        return None
    claim = db.scalar(select(DeviceClaim).where(DeviceClaim.device_id == device_id))
    if claim is None:
        return None
    if utcnow() - _as_utc(claim.claimed_at) > timedelta(hours=window_hours):
        return None  # expired; the device is free again
    return None if claim.username == username else claim.username


@write_path
def record_device_claim(db: Session, device_id: str, username: str) -> None:
    """Bind a device to an identity, refreshing the window on each sign-in."""
    if not device_id:
        return
    claim = db.scalar(select(DeviceClaim).where(DeviceClaim.device_id == device_id))
    if claim is None:
        db.add(DeviceClaim(device_id=device_id, username=username))
    else:
        claim.username = username
        claim.claimed_at = utcnow()
    try:
        db.commit()
    except IntegrityError:
        # Two tabs signing in at once; the row exists either way.
        db.rollback()


def roster_entry_for(db: Session, username: str) -> RosterEntry | None:
    """Find a student by KTH username in any synced roster.

    Any roster, not one named course: the teacher decides what is synced, and
    a student taking two of their courses should not have to pick which one
    they are logging in for. Sync only current courses — a stale roster keeps
    letting last year's students in.
    """
    return db.scalar(
        select(RosterEntry).where(RosterEntry.username == username.strip().lower()).limit(1)
    )


def roster_entry_for_canvas_user(db: Session, canvas_user_id: int) -> RosterEntry | None:
    """Find a student by Canvas user id in any synced roster.

    What Canvas login authenticates is a Canvas account, not a username — this
    is the other half of the mapping `RosterEntry` exists for. Any roster, for
    the same reason as `roster_entry_for`: which course a student is logging
    in for is not something they should have to choose.
    """
    return db.scalar(
        select(RosterEntry).where(RosterEntry.canvas_user_id == canvas_user_id).limit(1)
    )


def course_roster(db: Session, course_id: int) -> list[RosterEntry]:
    return list(
        db.scalars(
            select(RosterEntry)
            .where(RosterEntry.course_id == course_id)
            .order_by(RosterEntry.display_name)
        )
    )


def roster_courses(db: Session, teacher: User) -> list[dict]:
    """Courses this teacher has synced, with how many students each holds."""
    rows = db.execute(
        select(
            RosterEntry.course_id,
            func.count(RosterEntry.id),
            func.max(RosterEntry.synced_at),
        )
        .where(RosterEntry.owner_id == teacher.id)
        .group_by(RosterEntry.course_id)
        .order_by(RosterEntry.course_id)
    ).all()
    return [
        {"course_id": course_id, "students": count, "synced_at": synced_at}
        for course_id, count, synced_at in rows
    ]


@write_path
def update_question(
    db: Session,
    question: Question,
    text: str,
    image_url: str | None,
    choices: list,
    mode: QuestionMode | None = None,
    kind: QuestionKind | None = None,
    settings=None,
) -> Question:
    """Edit a question in place, keeping recorded answers readable.

    Choices carrying an `id` are the ones already stored: they are reworded,
    re-ordered or re-marked. A choice with no id is new. One that is left out
    is removed — and that is the only move which can destroy data, because an
    answer points at a choice id. Removing a choice students have picked would
    leave their answers pointing at nothing and the histogram unable to name
    what they chose, so it is refused.

    Everything else is allowed even after the question has been asked, typos
    being the main reason to edit at all. Changing which choice is correct is
    included on purpose: marking the wrong one is exactly the mistake a
    teacher needs to fix, and the per-session report then reads correctly.
    """
    from .schemas import check_question  # schemas imports models; avoid a cycle

    existing = {c.id: c for c in question.choices}
    incoming_ids = {c.id for c in choices if c.id is not None}

    unknown = incoming_ids - existing.keys()
    if unknown:
        raise RuleViolation("A choice being edited does not belong to this question")

    new_kind = kind if kind is not None else question.kind
    try:
        from .schemas import QuestionSettings

        check_question(new_kind, choices,
                       settings if settings is not None else QuestionSettings(**question.config),
                       image_url)
    except ValueError as e:
        raise InvalidQuestion(str(e))
    asked = db.scalar(
        select(func.count()).select_from(Answer).join(Round).where(Round.question_id == question.id)
    )
    if new_kind is not question.kind and asked:
        raise RuleViolation(
            "Students have already answered this question, so its kind cannot change. "
            "Reset the question first to discard those answers."
        )

    for choice_id, choice in existing.items():
        if choice_id in incoming_ids:
            continue
        if question.kind is QuestionKind.choice:
            answered = db.scalar(
                select(func.count()).select_from(Answer).where(Answer.choice_id == choice_id)
            )
        else:
            # Several-choice and ranking answers keep their choice ids in `value`.
            answered = asked
        if answered:
            raise RuleViolation(
                f"“{choice.text}” has already been chosen by students. Reword it "
                "instead of removing it, or reset the question first to discard "
                "those answers."
            )

    question.text = text
    question.image_url = image_url
    question.kind = new_kind
    if settings is not None:
        question.config = settings.model_dump()
    if mode is not None:
        # Allowed at any time: it governs rounds not yet run and what is
        # shown, never what was recorded.
        question.mode = mode

    kept: list[Choice] = []
    for position, incoming in enumerate(choices):
        if incoming.id is not None:
            choice = existing[incoming.id]
            choice.text = incoming.text
            choice.is_correct = incoming.is_correct
            choice.position = position
        else:
            choice = Choice(
                question_id=question.id,
                position=position,
                text=incoming.text,
                is_correct=incoming.is_correct,
            )
            db.add(choice)
        kept.append(choice)

    for choice_id, choice in existing.items():
        if choice_id not in incoming_ids:
            db.delete(choice)

    db.commit()
    db.refresh(question)
    return question


@write_path
def reorder_questions(db: Session, quiz: Quiz, question_ids: list[int]) -> list[Question]:
    """Put a quiz's questions in the given order.

    Takes the complete order rather than a "move this one up", so the result
    does not depend on what the client thought the order was: two teachers
    editing the same quiz cannot interleave two moves into a shuffle. The list
    must therefore be exactly this quiz's questions, each once — anything else
    is a stale client, and renumbering from it would silently drop or duplicate
    a question.

    Safe after a question has been asked: rounds point at question ids, never
    at positions, so reordering moves nothing but the running order.
    """
    current = {q.id: q for q in quiz.questions}
    if len(question_ids) != len(set(question_ids)) or set(question_ids) != current.keys():
        raise RuleViolation(
            "The new order must list each of this quiz's questions exactly once"
        )

    for position, question_id in enumerate(question_ids):
        current[question_id].position = position
    db.commit()
    db.refresh(quiz)
    return list(quiz.questions)


@write_path
def delete_question(db: Session, question: Question) -> None:
    """Remove a question, unless doing so would destroy recorded answers.

    A question carries no answers itself — they hang off the rounds that asked
    it — and nothing cascades from a question to its rounds. Deleting one that
    has been asked therefore leaves the answers in place but strands them:
    `Round.question` becomes None, and the participation report for *every*
    session that used the question raises instead of rendering. The answers
    are the only irreplaceable data here, so refuse.

    Reset the question first if the intent really is to discard its answers.
    """
    used_in = db.scalar(
        select(func.count()).select_from(Round).where(Round.question_id == question.id)
    )
    if used_in:
        raise RuleViolation(
            "This question has already been asked and has answers recorded. "
            "Reset it in the session's Control view first if you want to "
            "discard them."
        )
    db.delete(question)
    db.commit()


def draw_discussants(
    db: Session, session: QuizSession, question: Question, count: int = 2
) -> list[User]:
    """Pick students at random from those who answered this question.

    For the peer-instruction step: two people say how they reasoned, then the
    room discusses. Drawn only from those who actually answered, so nobody is
    asked to defend a position they never took.

    Returns *who*, never *what* — the caller shows names beside the whole
    distribution, not beside a bar, so being drawn does not disclose which
    choice a student picked.
    """
    answered = {
        answer.user_id: answer.user
        for round_ in session.rounds
        if round_.question_id == question.id
        for answer in round_.answers
    }
    # Exclude the teacher, who may have answered while testing the view.
    pool = [user for user in answered.values() if not access.is_staff(session, user)]
    if len(pool) <= count:
        return sorted(pool, key=lambda u: u.display_name)
    return random.sample(pool, count)


#: How many names the reel gets. Enough for a spin that does not visibly loop,
#: small enough that a 150-student lecture does not ship a name list per draw.
REEL_LIMIT = 40


def reel_names(
    db: Session,
    session: QuizSession,
    include: Iterable[str] = (),
    limit: int = REEL_LIMIT,
) -> list[str]:
    """Names for the draw to spin through before it settles.

    Deliberately taken from everyone who **joined** the session, not from those
    who answered this question. The reel is projected, so every name in it is
    read out to the room: taking it from the joined set means a name flashing
    past says only "this person is in the lecture", which everyone present can
    see anyway. Taking it from the answerers would instead publish who answered
    and, by omission, who did not.

    `include` is the names actually drawn. They are about to be shown in any
    case, so putting them on the reel discloses nothing further — and it makes
    the reel a superset of the draw by construction, which is what lets the
    spin come to rest on the right name. It matters because joining is recorded
    when a client fetches the state, and a student who somehow answered without
    that row existing would otherwise be drawn but never appear on the reel.

    Shuffled, so the order says nothing about who joined first.
    """
    users = db.scalars(
        select(User)
        .join(SessionParticipant, SessionParticipant.user_id == User.id)
        .where(SessionParticipant.session_id == session.id)
    ).all()
    drawn = list(dict.fromkeys(include))
    others = [
        u.display_name
        for u in users
        if not access.is_staff(session, u) and u.display_name not in drawn
    ]
    random.shuffle(others)
    names = drawn + others[: max(0, limit - len(drawn))]
    random.shuffle(names)
    return names


@write_path
def reset_question(db: Session, session: QuizSession, question: Question) -> int:
    """Discard both rounds of `question` so it can be asked again.

    Destructive: the rounds carry the answers, so resetting throws away what
    students submitted for this question in this session. Intended for
    rehearsing and debugging, not for use mid-lecture — a question can
    otherwise be run only once per session by design.

    Returns how many rounds were removed.
    """
    doomed = [r for r in session.rounds if r.question_id == question.id]
    for round_ in doomed:
        db.delete(round_)  # cascades to that round's answers
    db.commit()
    db.refresh(session)
    return len(doomed)


def round_histogram(db: Session, round_: Round) -> dict[int, int]:
    """Aggregate answer counts per choice id. Never exposes who answered what.

    For a `multi` question each ticked choice counts once; for `rank`, the
    choice put first; for `scale`, the counts are per value. Every other kind
    has no bars to count, and `round_result` carries its result.
    """
    question = round_.question
    if question.kind is QuestionKind.scale:
        cfg = question.config
        lo, hi = int(cfg.get("min", 1)), int(cfg.get("max", 5))
        counts = {v: 0 for v in range(lo, hi + 1)}
        for answer in round_.answers:
            counts[int(answer.data)] = counts.get(int(answer.data), 0) + 1
        return counts
    if not question.kind.has_choices:
        return {}
    counts = {choice.id: 0 for choice in question.choices}
    for answer in round_.answers:
        if question.kind is QuestionKind.choice:
            picked = [answer.choice_id]
        elif question.kind is QuestionKind.multi:
            picked = answer.data or []
        else:
            picked = (answer.data or [])[:1]
        for choice_id in picked:
            counts[choice_id] = counts.get(choice_id, 0) + 1
    return counts


def round_result(db: Session, round_: Round, include_hidden: bool = False) -> dict:
    """Everything needed to draw one round's result, for every kind.

    Aggregated or anonymous only: counts, a list of numbers, words with their
    counts, the taps, or the text answers without names. `total` is how many
    answered. Text answers are in a fixed shuffled order, so the order says
    nothing about who answered first; hidden ones are left out unless
    `include_hidden` (the teacher's own view, which marks them).
    """
    question = round_.question
    kind = question.kind
    answers = list(round_.answers)
    result: dict = {"kind": kind.value, "total": len(answers)}
    if kind.has_choices or kind is QuestionKind.scale:
        result["counts"] = round_histogram(db, round_)
    if kind is QuestionKind.rank:
        n = len(question.choices)
        rank_counts = {c.id: [0] * n for c in question.choices}
        for answer in answers:
            for position, choice_id in enumerate(answer.data or []):
                if choice_id in rank_counts and position < n:
                    rank_counts[choice_id][position] += 1
        result["rank_counts"] = rank_counts
        result["mean_rank"] = {
            cid: (sum((i + 1) * k for i, k in enumerate(row)) / sum(row)) if sum(row) else None
            for cid, row in rank_counts.items()
        }
    if kind in (QuestionKind.number, QuestionKind.scale):
        values = sorted(float(a.data) for a in answers)
        result["values"] = values
        result["mean"] = statistics.fmean(values) if values else None
        result["median"] = statistics.median(values) if values else None
    if kind is QuestionKind.word:
        # Counted case-insensitively, shown in the spelling most people used.
        spellings: dict[str, Counter] = {}
        for answer in answers:
            for word in answer.data or []:
                spellings.setdefault(word.lower(), Counter())[word] += 1
        result["words"] = sorted(
            ({"word": c.most_common(1)[0][0], "count": sum(c.values())}
             for c in spellings.values()),
            key=lambda w: (-w["count"], w["word"].lower()),
        )
    if kind is QuestionKind.text:
        texts = [
            {"id": a.id, "text": a.data, **({"hidden": a.hidden} if include_hidden else {})}
            for a in answers
            if include_hidden or not a.hidden
        ]
        random.Random(round_.id).shuffle(texts)
        result["texts"] = texts
    if kind is QuestionKind.point:
        result["points"] = [a.data for a in answers if a.data]
    return result


def pre_post_comparison(db: Session, session: QuizSession, question: Question) -> dict:
    """Pre vs post answer distributions for one question in a session."""
    result: dict = {"question_id": question.id, "pre": None, "post": None,
                    "pre_result": None, "post_result": None}
    for round_ in session.rounds:
        if round_.question_id == question.id:
            result[round_.phase.value] = round_histogram(db, round_)
            result[f"{round_.phase.value}_result"] = round_result(db, round_, include_hidden=True)
    return result
