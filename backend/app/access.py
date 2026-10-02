"""Who may run which quiz, and who counts as a member of a lecture.

One place for the rule, because it is checked in a dozen endpoints and in the
reports, and two answers to "may this teacher run this quiz?" would be worse
than either answer on its own.

By default a quiz belongs to the teacher who created it, and only they see it,
run it and read its reports. `SHARED_QUIZZES=true` is for a course taught by
several teachers together: every teacher then sees and runs every quiz, and
reads every report. That includes who answered what, so it is a course-level
decision, made once in configuration, not something a teacher switches on for
themselves.
"""
from .config import get_settings
from .models import QuizSession, Quiz, Role, User


def can_manage(quiz: Quiz, user: User) -> bool:
    """May `user` see, edit and run `quiz` and read its reports?"""
    if user.role != Role.teacher:
        return False
    return quiz.owner_id == user.id or get_settings().shared_quizzes


def is_staff(session: QuizSession, user: User | None) -> bool:
    """Is `user` running this lecture rather than sitting it?

    Staff are left out of the room: their views poll the student endpoints, and
    they may answer while testing the student view, so counting them would
    put a teacher in the join count, the attendance file and the name draw.
    """
    return user is not None and can_manage(session.quiz, user)
