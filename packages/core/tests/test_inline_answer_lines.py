"""`has_inline_answer` (QSRC-01-C06): the printed answer lines the extractor reads."""

from __future__ import annotations

import pytest
from book_core.extractor import has_inline_answer


@pytest.mark.parametrize(
    "text",
    ["정답: ②", "④ 침전\n[정답] ②", "정 답 ③", "(정답) 2", "Answer: B", "보기\n  정답 : 가"],
)
def test_answer_lines(text: str) -> None:
    assert has_inline_answer(text)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "다음 중 정답을 고르시오.",
        "정답은 몇 개인가?",
        "정답이 아닌 것은?",
        "The answer is below",
    ],
)
def test_not_answer_lines(text: str) -> None:
    assert not has_inline_answer(text)
