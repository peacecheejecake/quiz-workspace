"""The explainer's line-tagged output (``book_core.explain.prompts``): streaming display text, the
early answer check, the structured body and its validation (AIEXPL-01-C04).

``ExplanationStream`` takes the provider's text deltas and returns display text in whole lines:
tag lines become readable labels (``[[OPTION opt-2]]`` → ``**2. <option text>**``), the
``[[ANSWER]]`` line is never shown. For a multiple-choice question nothing is released before the
answer line was read and matched the server's correct option ids, so a mismatching answer
(``AnswerMismatchError``) never reaches a screen — not even while streaming.

``finish_explanation`` parses the whole output into the body
``{correct_option_ids, summary_md, options: [{option_id, why_md}], concepts_md, points_md}``,
checks it (``explanation_answer_mismatch``; every option id exactly once, else
``missing_option_ids`` for the one re-request) and renumbers the citations with the ASK rules
(``book_core.ask.validate_citations``: unknown tags dropped, ``[1]``… by first appearance over
the sections in display order).
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from book_core.ask.citations import validate_citations
from book_core.explain.models import ExplainQuestion

ANSWER_MISMATCH = "explanation_answer_mismatch"
INCOMPLETE = "explanation_incomplete"
TRUNCATED_SUFFIX = "(해설이 길어 잘렸습니다)"

_TAG = re.compile(
    r"^\s*\[\[\s*(ANSWER|SUMMARY|OPTION|POINTS|CONCEPTS)\b\s*([^\]]*?)\s*\]\]\s*(.*)$"
)
_IDS = re.compile(r"[,\s]+")
_SEPARATOR = "\n\n␞␞␞\n\n"
_SPLIT = re.compile(r"\n*␞␞␞\n*")
LABELS = {
    "SUMMARY": "**정답과 이유**",
    "POINTS": "**채점 기준과 흔한 오답**",
    "CONCEPTS": "**관련 개념**",
}


class AnswerMismatchError(Exception):
    """The answer line names other options than the question's correct ones."""


def _tag(line: str) -> tuple[str, str, str] | None:
    match = _TAG.match(line)
    if match is None:
        return None
    return match.group(1), match.group(2).strip(), match.group(3).strip()


def answer_ids(value: str) -> tuple[str, ...]:
    return tuple(p for p in _IDS.split(value.strip().strip("[]")) if p)


def _label(question: ExplainQuestion, name: str, arg: str) -> str:
    if name == "OPTION":
        option = question.option(arg)
        return f"**{option.number}. {option.text}**" if option is not None else "**보기**"
    return LABELS.get(name, "")


class ExplanationStream:
    """Raw provider text in, display text out (see the module docstring)."""

    def __init__(self, question: ExplainQuestion) -> None:
        self._question = question
        self._raw: list[str] = []
        self._partial = ""
        self._held: list[str] = []
        self._open = not question.is_mcq

    @property
    def raw(self) -> str:
        return "".join(self._raw)

    def _display(self, line: str) -> str | None:
        tagged = _tag(line)
        if tagged is None:
            return line
        name, arg, rest = tagged
        if name == "ANSWER":
            if self._open:  # only the first answer line counts (as in parse_output)
                return None
            ids = answer_ids(" ".join(p for p in (arg, rest) if p))
            if set(ids) != set(self._question.correct_option_ids):
                raise AnswerMismatchError()
            self._open = True
            return None
        label = _label(self._question, name, arg)
        return f"{label}\n{rest}" if rest else label

    def _lines(self, lines: Sequence[str]) -> str:
        out: list[str] = []
        for line in lines:
            shown = self._display(line)
            if shown is None:
                continue
            if self._open:
                out.extend(self._held)
                self._held = []
                out.append(shown)
            else:
                self._held.append(shown)
        if self._open and self._held:
            out = [*self._held, *out]
            self._held = []
        return "".join(f"{line}\n" for line in out)

    def feed(self, text: str) -> str:
        """Display text of the lines `text` completed ('' while none is ready)."""
        self._raw.append(text)
        buffered = self._partial + text
        *complete, self._partial = buffered.split("\n")
        return self._lines(complete)

    def finish(self) -> str:
        """The rest at the end of the output (a last line without a newline). Lines held back
        because no answer line came are dropped: the output fails validation anyway."""
        rest, self._partial = self._partial, ""
        shown = self._lines([rest]) if rest.strip() else ""
        return shown if self._open else ""


@dataclass(frozen=True)
class ParsedExplanation:
    correct_option_ids: tuple[str, ...] | None
    summary: str
    options: tuple[tuple[str, str], ...]
    points: str
    concepts: str


def parse_output(raw: str) -> ParsedExplanation:
    sections: dict[str, list[str]] = {"SUMMARY": [], "POINTS": [], "CONCEPTS": []}
    options: list[tuple[str, list[str]]] = []
    answer: tuple[str, ...] | None = None
    current: list[str] | None = None
    for line in raw.splitlines():
        tagged = _tag(line)
        if tagged is None:
            if current is not None:
                current.append(line)
            continue
        name, arg, rest = tagged
        if name == "ANSWER":
            if answer is None:
                answer = answer_ids(" ".join(p for p in (arg, rest) if p))
            current = None
            continue
        if name == "OPTION":
            options.append((arg, []))
            current = options[-1][1]
        else:
            current = sections[name]
        if rest:
            current.append(rest)

    def joined(lines: list[str]) -> str:
        return "\n".join(lines).strip()

    return ParsedExplanation(
        correct_option_ids=answer,
        summary=joined(sections["SUMMARY"]),
        options=tuple((option_id, joined(lines)) for option_id, lines in options),
        points=joined(sections["POINTS"]),
        concepts=joined(sections["CONCEPTS"]),
    )


@dataclass(frozen=True)
class FinishedExplanation:
    """`body` when valid; else `error_code` (and `missing_option_ids` worth one re-request)."""

    body: dict[str, Any] | None
    error_code: str | None = None
    missing_option_ids: tuple[str, ...] = ()
    cited_tags: tuple[str, ...] = ()
    dropped_citations: int = 0
    truncated: bool = False
    extra: dict[str, int] = field(default_factory=dict)


def finish_explanation(
    raw: str,
    question: ExplainQuestion,
    known_tags: Sequence[str],
    *,
    truncated: bool = False,
) -> FinishedExplanation:
    parsed = parse_output(raw)
    if question.is_mcq:
        if parsed.correct_option_ids is not None and set(parsed.correct_option_ids) != set(
            question.correct_option_ids
        ):
            return FinishedExplanation(None, ANSWER_MISMATCH)
        expected = question.option_ids
        # Every section counts, empty ones included: a second (even empty) section of an option
        # is a duplicate, and an option whose only section is empty is missing.
        seen = [option_id for option_id, _why in parsed.options]
        filled = {option_id for option_id, why in parsed.options if why.strip()}
        missing = tuple(o for o in expected if seen.count(o) != 1 or o not in filled)
        unknown = [o for o in seen if o not in expected]
        if parsed.correct_option_ids is None or missing or unknown or not parsed.summary:
            return FinishedExplanation(
                None, INCOMPLETE, missing_option_ids=missing or tuple(expected)
            )
        whys = dict(parsed.options)
        option_texts = [whys[o] for o in expected]
    else:
        if not parsed.summary:
            return FinishedExplanation(None, INCOMPLETE)
        option_texts = []
    texts = [parsed.summary, *option_texts, parsed.points, parsed.concepts]
    checked = validate_citations(_SEPARATOR.join(t or "-" for t in texts), known_tags)
    parts = [p.strip() for p in _SPLIT.split(checked.text)]
    if len(parts) != len(texts):  # pragma: no cover - the separator never occurs in model text
        return FinishedExplanation(None, INCOMPLETE)
    parts = [p if t else "" for p, t in zip(parts, texts, strict=True)]
    if truncated:
        last = max(i for i, p in enumerate(parts) if p or i == 0)
        parts[last] = f"{parts[last]}\n\n{TRUNCATED_SUFFIX}".strip()
    summary, rest = parts[0], parts[1:]
    whys_out, (points, concepts) = rest[: len(option_texts)], rest[len(option_texts) :]
    body: dict[str, Any] = {
        "correct_option_ids": list(question.correct_option_ids) if question.is_mcq else [],
        "summary_md": summary,
        "options": [
            {"option_id": o, "why_md": why}
            for o, why in zip(question.option_ids if question.is_mcq else (), whys_out, strict=True)
        ],
        "points_md": points or None,
        "concepts_md": concepts,
    }
    return FinishedExplanation(
        body,
        cited_tags=checked.cited_tags,
        dropped_citations=checked.dropped,
        truncated=truncated,
    )
