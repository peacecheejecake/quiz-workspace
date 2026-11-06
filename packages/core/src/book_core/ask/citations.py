"""Citation validation of a finished answer (ASK-01-C04).

The model cites the tags it was given (``[S1]``, ``[S2, S3]``). ``validate_citations``:

- drops every tag the answer was not given (counted in ``dropped``), from the text too;
- renumbers the rest ``[1]``, ``[2]``… in order of first appearance (``cited_tags[n - 1]`` is the
  tag behind ``[n]``);
- detects ``[NO_ANSWER]`` at the start (``no_answer``; the caller replaces the answer by the
  "not found" text and lists the searched passages);
- flags an answer that had passages but cites none (``uncited``).
"""

from __future__ import annotations

import re
from collections.abc import Collection
from dataclasses import dataclass

from book_core.ask.prompts import NO_ANSWER_MARK

NOT_FOUND_TEXT = (
    "올린 문서에서 관련 내용을 찾지 못했습니다. 질문을 바꾸거나 질문 범위를 넓혀 보세요."
)
TRUNCATED_SUFFIX = "(답이 길어 잘렸습니다)"

_GROUP = re.compile(r"\[\s*(S\d{1,3}(?:\s*[,\uff0c]\s*S\d{1,3})*)\s*\]")
_TAG = re.compile(r"S\d{1,3}")
_NO_ANSWER = re.compile(re.escape(NO_ANSWER_MARK))
_SPACE_BEFORE_PUNCT = re.compile(r"[ \t]+([.,;:!?。])")
_DOUBLE_SPACE = re.compile(r"[ \t]{2,}")
_FENCE = re.compile(r" {0,3}(`{3,}|~{3,})")


@dataclass(frozen=True, slots=True)
class CitationResult:
    text: str
    cited_tags: tuple[str, ...]
    dropped: int
    no_answer: bool
    uncited: bool


def validate_citations(raw: str, known_tags: Collection[str]) -> CitationResult:
    known = set(known_tags)
    stripped = raw.lstrip()
    no_answer = stripped.startswith(NO_ANSWER_MARK)
    text = _NO_ANSWER.sub("", raw)
    order: list[str] = []
    dropped = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal dropped
        out: list[str] = []
        for tag in _TAG.findall(match.group(1)):
            if tag not in known:
                dropped += 1
                continue
            if tag not in order:
                order.append(tag)
            out.append(f"[{order.index(tag) + 1}]")
        return "".join(dict.fromkeys(out))

    text = _GROUP.sub(replace, text)
    return CitationResult(
        text=_tidy_spaces(text),
        cited_tags=tuple(order),
        dropped=dropped,
        no_answer=no_answer,
        uncited=bool(known) and not order and not no_answer,
    )


def _tidy_line(line: str) -> str:
    """Spaces a dropped tag left behind; a Markdown indent and hard break stay (UX12-ASKMD)."""
    body = line.lstrip(" \t")
    indent = line[: len(line) - len(body)]
    tidy = _DOUBLE_SPACE.sub(" ", _SPACE_BEFORE_PUNCT.sub(r"\1", body)).rstrip()
    return f"{indent}{tidy}{'  ' if tidy and line.endswith('  ') else ''}"


def _tidy_spaces(text: str) -> str:
    lines: list[str] = []
    fence: str | None = None
    for line in text.splitlines():
        marker = _FENCE.match(line)
        if fence is not None:
            lines.append(line)
            if marker and marker.group(1).startswith(fence) and not line[marker.end() :].strip():
                fence = None
        elif marker:
            fence = marker.group(1)
            lines.append(line)
        else:
            lines.append(_tidy_line(line))
    return "\n".join(lines).strip()


def display_tags(text: str) -> str:
    """While streaming: ``[S1]`` shown as ``[1]`` (the final text is renumbered on ``done``)."""
    return _GROUP.sub(lambda m: "".join(f"[{t[1:]}]" for t in _TAG.findall(m.group(1))), text)
