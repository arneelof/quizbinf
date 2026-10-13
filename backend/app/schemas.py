from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator

from .markdown import render as render_markdown
from .models import Phase, QuestionKind, QuestionMode, Role


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    username: str
    display_name: str
    role: Role


class MockLoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    display_name: str = ""


class LoadTestLoginIn(BaseModel):
    """Signing in a throwaway student for a rehearsal against a live app.

    `name` is a label, not an identity: it is prefixed before it becomes a
    username, so nothing here can collide with, or impersonate, a real
    student.
    """

    key: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9-]+$")


class RosterLoginIn(BaseModel):
    """Identification against the course roster.

    `password` is blank for students — they are identified, not
    authenticated — and is the shared teacher password for a teacher.
    """

    email: str = Field(min_length=1, max_length=200)
    password: str = ""


class ChoiceIn(BaseModel):
    text: str = Field(min_length=1)
    is_correct: bool = False


class QuestionSettings(BaseModel):
    """Per-kind settings; see `models.QuestionKind`. Unused ones stay None."""

    model_config = ConfigDict(extra="forbid")
    min: float | None = None
    max: float | None = None
    unit: str | None = Field(default=None, max_length=40)
    answer: float | None = None
    tolerance: float | None = Field(default=None, ge=0)
    min_label: str | None = Field(default=None, max_length=60)
    max_label: str | None = Field(default=None, max_length=60)
    max_words: int | None = Field(default=None, ge=1, le=10)
    max_length: int | None = Field(default=None, ge=20, le=2000)


def check_question(kind: QuestionKind, choices: list, settings: QuestionSettings | None,
                   image_url: str | None) -> None:
    """The rules every kind of question must satisfy, for adding and editing alike."""
    s = settings or QuestionSettings()
    correct = sum(1 for c in choices if c.is_correct)
    if kind.has_choices:
        if len(choices) < 2:
            raise ValueError("A question with choices needs at least two")
        if kind is QuestionKind.choice and correct > 1:
            raise ValueError("A single-choice question can have at most one correct choice")
        if kind is QuestionKind.rank and correct:
            raise ValueError("A ranking question has no correct choice")
    elif choices:
        raise ValueError(f"A {kind.value} question has no choices")
    if s.min is not None and s.max is not None and s.min >= s.max:
        raise ValueError("min must be smaller than max")
    if kind is QuestionKind.scale:
        lo, hi = s.min if s.min is not None else 1, s.max if s.max is not None else 5
        if lo != int(lo) or hi != int(hi) or not 1 <= hi - lo <= 10:
            raise ValueError("A scale runs between two whole numbers, at most 10 apart")
    if kind is QuestionKind.number and s.answer is not None:
        if (s.min is not None and s.answer < s.min) or (s.max is not None and s.answer > s.max):
            raise ValueError("The answer must lie between min and max")
    if kind is QuestionKind.point and not image_url:
        # Its own figure, not one in the text: that is the one students tap.
        raise ValueError("A tap-on-the-figure question needs a figure (image_url)")


class QuestionIn(BaseModel):
    text: str = Field(min_length=1)
    image_url: str | None = None
    kind: QuestionKind = QuestionKind.choice
    choices: list[ChoiceIn] = []
    settings: QuestionSettings | None = None
    mode: QuestionMode = QuestionMode.twice

    @model_validator(mode="after")
    def valid_for_kind(self) -> "QuestionIn":
        check_question(self.kind, self.choices, self.settings, self.image_url)
        return self


class ChoiceEdit(BaseModel):
    """A choice in an edit. `id` identifies one that already exists.

    Sent back so the server can tell "the same choice, reworded" from "a new
    choice" — which matters because answers point at choice ids, and dropping
    one students have answered would strand their answers.
    """

    id: int | None = None
    text: str = Field(min_length=1)
    is_correct: bool = False


class QuestionEdit(BaseModel):
    text: str = Field(min_length=1)
    image_url: str | None = None
    choices: list[ChoiceEdit] = []
    # Absent means "leave it as it is", so a client that predates modes or
    # kinds cannot reset one by saving a typo fix. The kind and settings are
    # checked against the stored question in `service.update_question`.
    mode: QuestionMode | None = None
    kind: QuestionKind | None = None
    settings: QuestionSettings | None = None


class QuestionOrder(BaseModel):
    """The complete running order, as question ids.

    Complete rather than a single move, so the server can reject a stale
    client instead of renumbering from an order that no longer exists.
    """

    question_ids: list[int] = Field(min_length=1)


class QuizIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class ChoiceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    position: int
    text: str


class ChoiceTeacherOut(ChoiceOut):
    is_correct: bool


class QuestionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    id: int
    position: int
    text: str
    image_url: str | None
    choices: list[ChoiceOut]
    mode: QuestionMode = QuestionMode.twice
    kind: QuestionKind = QuestionKind.choice
    # Students get the settings without the answer (`Question.public_config`).
    settings: dict = Field(default_factory=dict, validation_alias="public_config")

    @computed_field
    @property
    def text_html(self) -> str:
        """`text` rendered from Markdown and sanitised, ready to display.

        Sent alongside the source so a client can show either; the authoring
        form edits `text`, everything that displays a question uses this.
        """
        return render_markdown(self.text)


class QuestionTeacherOut(QuestionOut):
    choices: list[ChoiceTeacherOut]
    settings: dict = Field(default_factory=dict, validation_alias="config")
    graded: bool = True


class QuizOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    questions: list[QuestionTeacherOut]


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    quiz_id: int
    created_at: datetime
    is_anonymous: bool = False


class OpenRoundIn(BaseModel):
    question_id: int
    phase: Phase


class AnswerIn(BaseModel):
    """One answer; which field is used depends on the question's kind."""

    choice_id: int | None = None  # choice
    choice_ids: list[int] | None = Field(default=None, max_length=50)  # multi; rank, in order
    number: float | None = None  # number, scale
    words: list[str] | None = Field(default=None, max_length=10)  # word
    text: str | None = Field(default=None, max_length=5000)  # text
    point: list[float] | None = Field(default=None, min_length=2, max_length=2)  # point: x, y


class RoundOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    question_id: int
    phase: Phase
    opened_at: datetime
    closed_at: datetime | None


class SessionState(BaseModel):
    """What every student client needs to render the current moment.

    The correct answer is never included here — students only see choices.
    """

    code: str
    quiz_id: int
    quiz_title: str
    open_round: RoundOut | None
    question: QuestionOut | None  # the open round's question, choices unmarked
    my_choice_id: int | None = None
    # The student's own answer to the open round, in AnswerIn's shape, for
    # every kind (my_choice_id stays for clients that predate kinds).
    my_answer: dict | None = None
    # Students join without logging in and their answers are not linked to
    # them; the student page says so.
    anonymous: bool = False
    # Populated only while no round is open, so a student's own device can
    # show the same bar chart the teacher's Report view reveals once
    # submissions are halted. Cleared the moment a new round opens (a round
    # from earlier in the session never resurfaces here).
    closed_round: RoundOut | None = None
    closed_round_question: QuestionOut | None = None
    closed_round_histogram: dict[int, int] | None = None
    # When the closed round is a post round, the same question's pre
    # distribution, so both can be shown side by side. Never set for a
    # `twice_end` question before its post round is halted, because the
    # point of that mode is that the pre result stays hidden until then.
    closed_round_pre_histogram: dict[int, int] | None = None
    # The same rounds as `service.round_result` payloads, for every kind.
    # Hidden text answers are left out: this is what students see.
    closed_round_result: dict | None = None
    closed_round_pre_result: dict | None = None


class HistogramOut(BaseModel):
    round_id: int
    phase: Phase
    counts: dict[int, int]  # choice_id -> number of answers
    total: int
    result: dict | None = None  # `service.round_result`, for every kind


class ComparisonOut(BaseModel):
    question_id: int
    pre: dict[int, int] | None
    post: dict[int, int] | None
    # `service.round_result` per phase, for every kind; None until it has run.
    pre_result: dict | None = None
    post_result: dict | None = None


class ParticipantsOut(BaseModel):
    """Room size for the projected join screen. Counts only — never names."""

    joined: int
    connected: int


class ParticipantAnswerOut(BaseModel):
    """One student's verdict on one question. None means "did not answer"."""

    question_id: int
    pre: bool | None
    post: bool | None
    # False for a question with no right answer: then True only means "answered".
    graded: bool = True


class ParticipantRowOut(BaseModel):
    """A student's participation. Personal data — teacher-only."""

    username: str
    display_name: str
    answers: list[ParticipantAnswerOut]
    answered: int
    pre_correct: int
    post_correct: int


class ParticipationReportOut(BaseModel):
    questions: list[QuestionTeacherOut]
    rows: list[ParticipantRowOut]


class LiveCountOut(BaseModel):
    """Progress of the open round: how many have answered, not what they chose."""

    open_round: RoundOut | None
    answered: int
