"""SupabaseStorage against a mocked Storage REST API (request shapes, error mapping, no leaks)."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable

import httpx
import pytest
from pydantic import SecretStr
from quiz_api.settings import Settings
from quiz_api.storage import (
    StorageUnavailableError,
    SupabaseStorage,
    build_storage,
    object_key,
)

KEY = "sb_secret_TEST"
TOKEN = "UPLOAD-TOKEN-SECRET"  # noqa: S105 - fake
OBJ = "workspaces/w/documents/d/revisions/r/source.pdf"

Handler = Callable[[httpx.Request], httpx.Response]


def _storage(handler: Handler, public_url: str | None = None) -> SupabaseStorage:
    return SupabaseStorage(
        "http://internal:54321",
        KEY,
        public_url=public_url,
        transport=httpx.MockTransport(handler),
    )


def test_object_key_scheme() -> None:
    assert object_key("w", "d", "r") == OBJ


def test_signed_upload_uses_the_secret_key_and_public_origin() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={"url": f"/object/upload/sign/source-pdfs/{OBJ}?token={TOKEN}", "token": TOKEN},
        )

    signed = _storage(handler, public_url="https://files.example").create_signed_upload(
        "source-pdfs", OBJ
    )
    [request] = seen
    assert request.method == "POST"
    assert (
        str(request.url) == f"http://internal:54321/storage/v1/object/upload/sign/source-pdfs/{OBJ}"
    )
    assert request.headers["apikey"] == KEY
    assert request.headers["authorization"] == f"Bearer {KEY}"
    # The credential travels in headers, never in the request URL.
    assert KEY not in str(request.url)
    assert signed.url == (
        f"https://files.example/storage/v1/object/upload/sign/source-pdfs/{OBJ}?token={TOKEN}"
    )
    assert signed.token == TOKEN
    assert signed.resumable_endpoint == "https://files.example/storage/v1/upload/resumable/sign"


def test_digest_streams_and_hashes() -> None:
    data = b"%PDF-1.7 " + b"x" * 3_000_000

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/storage/v1/object/source-pdfs/{OBJ}"
        return httpx.Response(200, content=data)

    digest = _storage(handler).digest("source-pdfs", OBJ, max_bytes=len(data))
    assert digest is not None
    assert digest.size == len(data)
    assert digest.sha256 == hashlib.sha256(data).hexdigest()
    assert digest.head == b"%PDF-"


def test_digest_stops_past_the_limit() -> None:
    data = b"%PDF-" + b"y" * (3 << 20)
    digest = _storage(lambda _: httpx.Response(200, content=data)).digest(
        "source-pdfs", OBJ, max_bytes=1 << 20
    )
    assert digest is not None
    assert digest.size > 1 << 20
    assert digest.size < len(data)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(404),
        httpx.Response(
            400, json={"statusCode": "404", "error": "not_found", "message": "Object not found"}
        ),
    ],
)
def test_digest_of_a_missing_object_is_none(response: httpx.Response) -> None:
    assert _storage(lambda _: response).digest("source-pdfs", OBJ, max_bytes=10) is None


def test_errors_map_to_unavailable_without_leaking(caplog: pytest.LogCaptureFixture) -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {request.url}", request=request)

    storage = _storage(broken)
    with caplog.at_level(logging.DEBUG):
        for call in (
            lambda: storage.create_signed_upload("source-pdfs", OBJ),
            lambda: storage.digest("source-pdfs", OBJ, max_bytes=10),
            lambda: storage.create_signed_read_url("source-pdfs", OBJ, 60),
            lambda: storage.delete("source-pdfs", OBJ),
        ):
            with pytest.raises(StorageUnavailableError):
                call()
    assert "ConnectError" in caplog.text
    assert OBJ not in caplog.text
    assert KEY not in caplog.text

    server_error = _storage(lambda _: httpx.Response(500, json={"message": "boom"}))
    with pytest.raises(StorageUnavailableError):
        server_error.create_signed_upload("source-pdfs", OBJ)
    with pytest.raises(StorageUnavailableError):
        server_error.digest("source-pdfs", OBJ, max_bytes=10)


def test_signed_read_url_and_delete() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            assert json.loads(request.content) == {"expiresIn": 120}
            return httpx.Response(200, json={"signedURL": f"/object/sign/source-pdfs/{OBJ}?t=1"})
        return httpx.Response(
            400, json={"statusCode": "404", "error": "not_found", "message": "Object not found"}
        )

    storage = _storage(handler)
    url = storage.create_signed_read_url("source-pdfs", OBJ, 120)
    assert url == f"http://internal:54321/storage/v1/object/sign/source-pdfs/{OBJ}?t=1"
    storage.delete("source-pdfs", OBJ)  # already gone is fine
    assert [r.method for r in seen] == ["POST", "DELETE"]


def test_malformed_sign_responses_are_unavailable() -> None:
    storage = _storage(lambda _: httpx.Response(200, json={"url": "https://evil.example/x"}))
    with pytest.raises(StorageUnavailableError):
        storage.create_signed_upload("source-pdfs", OBJ)
    with pytest.raises(StorageUnavailableError):
        storage.create_signed_read_url("source-pdfs", OBJ, 60)


def test_build_storage_needs_url_and_secret_key() -> None:
    assert build_storage(Settings.model_construct()) is None
    assert build_storage(Settings.model_construct(supabase_url="http://127.0.0.1:54321")) is None
    assert (
        build_storage(
            Settings.model_construct(
                supabase_url="http://127.0.0.1:54321", supabase_secret_key=SecretStr("")
            )
        )
        is None
    )
    configured = build_storage(
        Settings.model_construct(
            supabase_url="http://127.0.0.1:54321",
            supabase_secret_key=SecretStr(KEY),
            storage_timeout_seconds=5.0,
        )
    )
    assert isinstance(configured, SupabaseStorage)
    configured.close()
