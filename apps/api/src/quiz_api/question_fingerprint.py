"""Duplicate-question fingerprint (UX7-DEDUP, docs/questions.md §10.1).

One pure function decides "the same question" for both duplicate paths: the 중복 문제 정리 scan
of confirmed questions and the import review's duplicate flag. Exact content after normalising
only what does not change the question a learner sees:

1. option labels (options only): a leading circled/parenthesised number, letter or Korean
   jamo/syllable (`①`, `⑴`, `⒜`, `Ⓐ`, `㉠`, `❶`, `➀`) and the `1)`, `1.`, `(1)`, `A.`, `A)`,
   `(A)`, `ㄱ.`, `ㄱ)`, `(ㄱ)`, `가.`, `가)`, `(가)` forms. Stripped before NFKC (NFKC turns `①`
   into `1`); never strips an option to nothing.
2. (nothing else of the stem: a leading question number such as `12.` or `문제 12.` is part of
   it — user decision 2026-11-01, "do not ignore anything"; fingerprint/2 stripped it).
3. NFKC (full-width and compatibility characters).
4. empty answer marks: brackets holding only blanks or underscores (`( )`, `[ ]`, `(____)`).
5. quoting/terminal/separator punctuation (`.,;:!?…·、。` and quotes and angle quotes; a `.` or `,`
   between digits stays, `1.5` is not `15`). Brackets
   and math symbols (`- + = / %` …) stay, so `2+(-3)` never equals `2+3`.
6. every whitespace character (spacing differences). Case is kept.

`fingerprint(question_type, stem, options, model_answer)` hashes the type, the normalised stem,
the sorted normalised option texts (order and ids do not matter) and the model answer
(`model_answer_of`, user decision 2026-11-01): none for an MCQ (its answer is not part of what
makes it the same question), the accepted answers of a short answer, the rubric/model answer of
an essay, each normalised with steps 3-6. Explanations, chapters and numbers are never part of
it. `answer_key` gives the normalised MCQ/short answer so a group can warn when answers differ.

Not `book_core.question.question_fingerprint` (M6.1): that one includes the answer and folds
case, because it tells whether a generated variant changed anything at all; this one asks
whether two bank questions are the same question to a learner.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Iterable, Sequence

VERSION = "fingerprint/3"

# Enclosed alphanumerics and circled Korean, stripped before NFKC (which turns them into plain
# digits/letters): U+2460-U+24FF (① ⑴ ⒈ ⒜ Ⓐ ⓪), U+3260-U+327B (㉠ ㉮), U+2776-U+2793 (❶ ➀).
_LEADING_ENCLOSED = re.compile("^\\s*[①-⓿㉠-㉻❶-➓]\\s*")
# After NFKC (full-width brackets and dots are ASCII by then): `1)` `1.` `(1)` `A.` `A)` `(A)`
# `ㄱ.` `ㄱ)` `(ㄱ)` `가.` `가)` `(가)`. NFKC maps compatibility jamo (ㄱ U+3131) to
# conjoining jamo (U+1100), so both ranges are listed.
_JAMO = "\u3131-\u314e\u1100-\u1112"
_LABEL = rf"(?:\d{{1,2}}|[A-Za-z]|[{_JAMO}]|[가나다라마바사아자차카타파하])"
# A label ends with `)` or with a `.` that does not start a decimal (`1.5` is not label `1.`).
_LABEL_END = r"(?:\)|\.(?!\d))"
_LEADING_LABEL = re.compile(rf"^\s*(?:\(\s*{_LABEL}\s*\)|{_LABEL}\s*{_LABEL_END})\s*")
_EMPTY_MARK = re.compile(r"[(\[{]\s*_*\s*[)\]}]")
# Quoting, terminal and separator marks (U+2018/2019/201C/201D are the curly quotes).
_PUNCTUATION = re.compile("[;:!?…·・、。'\"\u2018\u2019\u201c\u201d«»「」『』〈〉《》<>]")
# `.` and `,` go too, except between digits (`1.5`, `1,000` keep theirs: `1.5` is not `15`).
_DOTS = re.compile(r"(?<!\d)[.,]|[.,](?!\d)")
_SPACE = re.compile(r"\s+")


def _nfkc(text: str) -> str:
    return unicodedata.normalize("NFKC", text)


def _finish(text: str) -> str:
    """Steps 4-6 on NFKC text."""
    text = _EMPTY_MARK.sub("", text)
    text = _PUNCTUATION.sub("", text)
    text = _DOTS.sub("", text)
    return _SPACE.sub("", text)


def normalize_stem(stem: str) -> str:
    """A stem without punctuation, blanks and empty answer marks (its number, if it has one,
    stays: it is part of the question asked)."""
    return _finish(_nfkc(stem))


def normalize_option(text: str) -> str:
    """An option text without its label (`①`, `1)`, `(A)`, `ㄱ.` …), punctuation and blanks."""
    unenclosed = _LEADING_ENCLOSED.sub("", text, count=1)
    if unenclosed != text:
        out = _finish(_nfkc(unenclosed))
    else:
        out = _finish(_LEADING_LABEL.sub("", _nfkc(text), count=1))
    return out if out else _finish(_nfkc(text))


def model_answer_of(
    question_type: str, accepted_answers: Iterable[str] | None, rubric: str | None
) -> list[str]:
    """What a question's model answer contributes to its fingerprint, normalised and sorted:
    nothing for an MCQ, the distinct accepted answers of a short answer, the rubric of an essay
    (empty when it has none)."""
    if question_type == "SHORT_ANSWER":
        return sorted({_finish(_nfkc(a)) for a in accepted_answers or ()} - {""})
    if question_type == "ESSAY":
        text = _finish(_nfkc(rubric or ""))
        return [text] if text else []
    return []


def fingerprint(
    question_type: str, stem: str, options: Iterable[str], model_answer: Iterable[str] = ()
) -> str:
    """The duplicate key of a question: same type, same normalised stem, same normalised options
    in any order (a multiset: an option listed twice counts twice), same model answer (pass
    `model_answer_of(...)`)."""
    payload = [
        VERSION,
        question_type,
        normalize_stem(stem),
        sorted(normalize_option(o) for o in options),
        sorted(model_answer),
    ]
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def answer_key(
    options: Sequence[tuple[str, str]],
    correct_option_ids: Sequence[str] | None,
    accepted_answers: Sequence[str] | None,
) -> tuple[str, ...] | None:
    """The normalised answer (MCQ: the correct options' texts; short answer: the accepted
    answers), sorted; None when the question has no answer to compare (unknown, essay)."""
    if correct_option_ids:
        text_of = dict(options)
        return tuple(sorted(normalize_option(text_of.get(i, "")) for i in correct_option_ids))
    if accepted_answers:
        return tuple(sorted({_finish(_nfkc(a)) for a in accepted_answers}))
    return None
