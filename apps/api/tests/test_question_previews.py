"""CHNOTE-02-C01/C02 schema half: both preview routes answer the one closed QuestionPreview DTO
(stem and options only), checked on the OpenAPI document. The response keys of real calls are
checked in tests/integration/questions/chapter_notes/test_chapter_note_previews_contract.py."""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from quiz_api.main import create_app
from quiz_api.settings import Settings

PREVIEW_FIELDS = {
    "question_id",
    "number_label",
    "chapter_title",
    "question_type",
    "stem",
    "stem_tables",
    "options",
}
OPTION_FIELDS = {"id", "text"}
PATHS = (
    "/api/v1/questions/{question_id}/preview",
    "/api/v1/shared/{share_id}/questions/{question_id}/preview",
)


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    app = create_app(Settings(APP_ENV="test"), readiness_checkers=[])  # type: ignore[call-arg]
    out: dict[str, Any] = app.openapi()
    return out


def test_both_preview_routes_answer_the_closed_preview_dto(spec: dict[str, Any]) -> None:
    schemas = spec["components"]["schemas"]
    for path in PATHS:
        ok = spec["paths"][path]["get"]["responses"]["200"]
        refs = re.findall(r'"\$ref": "#/components/schemas/([^"]+)"', json.dumps(ok))
        assert refs == ["QuestionPreview"], path
    preview = schemas["QuestionPreview"]
    assert set(preview["properties"]) == PREVIEW_FIELDS
    assert preview.get("additionalProperties") is False
    option_ref = preview["properties"]["options"]["items"]["$ref"].rsplit("/", 1)[-1]
    assert set(schemas[option_ref]["properties"]) == OPTION_FIELDS
    assert schemas[option_ref].get("additionalProperties") is False
