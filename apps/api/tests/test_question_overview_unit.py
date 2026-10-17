"""Pure helpers of the questions overview (M5.1): chapter number and stem preview."""

from __future__ import annotations

import pytest
from quiz_api.api.question_overview import PREVIEW_CHARS, chapter_number, preview_text


@pytest.mark.parametrize(
    ("titles", "expected"),
    [
        (["Chapter 3 Attention"], 3),
        (["CHAPTER 12: Transformers"], 12),
        (["Ch. 4 Optimisation"], 4),
        (["제3장 어텐션"], 3),
        (["3장 어텐션"], 3),
        (["3. Attention"], 3),
        (["3 Attention"], 3),
        (["3.2 Scaled dot-product"], 3),
        (["7"], 7),
        (["Chapter 5", "1 Introduction"], 5),  # the top-level ancestor wins
        (["Part I", "Chapter 2 Basics", "2.1 Setup"], 2),
        (["Preface"], None),
        (["3D graphics"], None),
        (["Attention is all you need"], None),
        ([], None),
    ],
)
def test_chapter_number(titles: list[str], expected: int | None) -> None:
    assert chapter_number(titles) == expected


def test_preview_keeps_the_first_three_non_blank_lines() -> None:
    stem = "\n  첫 줄  \n\n둘째 줄\n셋째 줄\n넷째 줄"
    assert preview_text(stem) == "첫 줄\n둘째 줄\n셋째 줄"


def test_preview_is_bounded() -> None:
    out = preview_text("가" * 5000)
    assert len(out) == PREVIEW_CHARS
    assert out.endswith("…")
