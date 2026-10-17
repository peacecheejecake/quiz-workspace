"""Real LLM provider round trip (M4.3). Marked ``llm``: opt-in, billed, excluded from ``make test``.

Run with ``make test-llm`` and ``LLM_API_KEY`` / ``LLM_MODEL`` set; fails (never skips) without
them. Sends only the hand-written synthetic question below, never fixture or book text.
"""

from __future__ import annotations

import pytest
from book_core.extractor import LLMQuestion, build_request
from book_core.llm import LLMConfig, create_llm_client

pytestmark = pytest.mark.llm

SYNTHETIC_QUESTION = ["7. 2 + 3 의 값은?", "① 4", "② 5", "③ 6"]


def test_real_provider_returns_schema_valid_question() -> None:
    config = LLMConfig.from_env()
    assert config is not None, "set LLM_API_KEY and LLM_MODEL to run llm-marked tests"
    client = create_llm_client(config)

    result = client.complete(build_request(SYNTHETIC_QUESTION, []), LLMQuestion)

    output = result.output
    assert output.question_type == "MCQ"
    assert [o.label for o in output.options] == ["①", "②", "③"]
    assert result.info.usage.input_tokens > 0
    assert result.info.model
    # Whether the model answers is not asserted: the extractor discards any answer that the
    # printed answer key does not state (test_extractor.py covers that path deterministically).
