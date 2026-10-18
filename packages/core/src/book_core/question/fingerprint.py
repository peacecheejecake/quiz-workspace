"""Content fingerprint of a question, for duplicate detection (questions.md §5).

Two questions get the same fingerprint when they ask the same thing with the same answer,
regardless of option ids, option labels, option order, spacing, line breaks, Unicode width or
letter case. So an option shuffle of a question is a duplicate of it, while a variant that
changes the stem, an option text or the answer is not.

The fingerprint is a SHA-256 hex digest of a canonical JSON form; it is stable across processes
and can be stored and compared in the database.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence

from book_core.contracts import QuestionOption, QuestionType
from book_core.question.labels import loose_text

FINGERPRINT_VERSION = 1


def normalize_text(text: str) -> str:
    """NFKC, no whitespace, case-folded: what the fingerprint compares."""
    return loose_text(text).casefold()


def question_fingerprint(
    *,
    question_type: QuestionType,
    stem: str,
    options: Sequence[QuestionOption] = (),
    correct_option_ids: Sequence[str] | None = None,
    accepted_answers: Sequence[str] | None = None,
) -> str:
    """Order- and id-independent digest of type, stem, option texts and answer.

    MCQ answers are compared by the *text* of the correct options (ids are local to one
    question); unknown option ids in ``correct_option_ids`` are ignored. ``None`` (answer
    unknown) and an empty answer are distinct.
    """
    text_by_id = {o.id: normalize_text(o.text) for o in options}
    correct: list[str] | None = None
    if correct_option_ids is not None:
        correct = sorted(text_by_id[i] for i in set(correct_option_ids) if i in text_by_id)
    accepted = (
        None if accepted_answers is None else sorted({normalize_text(a) for a in accepted_answers})
    )
    payload = {
        "v": FINGERPRINT_VERSION,
        "type": question_type.value,
        "stem": normalize_text(stem),
        "options": sorted(text_by_id.values()),
        "correct": correct,
        "accepted": accepted,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
