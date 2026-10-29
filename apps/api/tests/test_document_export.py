"""DOC-03-C03 file names and headers of the export route (pure helpers; the route itself runs in
tests/integration/documents/test_document_text_export.py)."""

from __future__ import annotations

from urllib.parse import unquote

from fastapi.testclient import TestClient
from quiz_api.api.document_export import content_disposition, export_filename_title
from quiz_api.middleware import NoStoreMiddleware


def test_filename_title_drops_path_and_control_characters_and_stays_short() -> None:
    title = export_filename_title("../교재/물:순환\\정수\x00\x1f\x7f\u0085 " + "가" * 200)
    assert "/" not in title
    assert "\\" not in title
    assert not any(ord(c) < 0x20 or 0x7F <= ord(c) <= 0x9F for c in title)
    assert title.startswith("교재물:순환정수 가")
    assert len(title) == 120


def test_filename_title_never_empty_or_hidden() -> None:
    assert export_filename_title("  ../\n ") == "document"
    assert export_filename_title(".hidden.") == "hidden"
    assert export_filename_title("a \t  b") == "a b"


def test_content_disposition_has_an_ascii_fallback_and_the_exact_utf8_name() -> None:
    header = content_disposition('물의 "순환"; 100%.md')
    assert header.startswith('attachment; filename="')
    fallback = header.split(";")[1].strip()
    assert fallback.isascii()
    assert fallback.count('"') == 2, "quotes inside the name are replaced"
    star = [p.strip() for p in header.split(";") if p.strip().startswith("filename*=")]
    assert len(star) == 1, "`;` inside the name is percent-encoded"
    assert unquote(star[0].removeprefix("filename*=UTF-8''")) == '물의 "순환"; 100%.md'


def test_route_no_store_survives_the_no_store_middleware() -> None:
    from fastapi import FastAPI, Response

    app = FastAPI()

    @app.get("/api/v1/file")
    def file() -> Response:
        return Response("x", headers={"Cache-Control": "private, no-store"})

    @app.get("/api/v1/cacheable")
    def cacheable() -> Response:
        return Response("x", headers={"Cache-Control": "public, max-age=60"})

    app.add_middleware(NoStoreMiddleware, path_prefix="/api/v1")
    client = TestClient(app)
    assert client.get("/api/v1/file").headers["cache-control"] == "private, no-store"
    assert client.get("/api/v1/cacheable").headers["cache-control"] == "no-store"
