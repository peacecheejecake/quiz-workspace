"""Server-side Supabase Storage client (M3.2a; docs/deployment.md §2, docs/auth.md §4).

All buckets are private. The API calls the Storage REST API with the server-only secret key
(never sent to a browser) and hands clients only short-lived signed URLs, issued after the route
has checked membership. Signed URLs and upload tokens are secrets: they are returned to the one
caller that asked for them and never logged, stored or put in an error message. Requests made
here carry the key in headers only, so their URLs (which httpx may log) hold no credential.

Bucket and object names come from server-generated ids only (`object_key`), never from client
input.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import quote

import httpx

from quiz_api.settings import Settings

logger = logging.getLogger(__name__)

SOURCE_BUCKET = "source-pdfs"
PARSED_BUCKET = "parsed-artifacts"
_STORAGE_PATH = "/storage/v1"
PDF_MAGIC = b"%PDF-"


def object_key(workspace_id: object, document_id: object, revision_id: object) -> str:
    """The only object key scheme for an original PDF (docs/deployment.md §4)."""
    return f"workspaces/{workspace_id}/documents/{document_id}/revisions/{revision_id}/source.pdf"


class StorageUnavailableError(Exception):
    """Storage could not be reached or answered with an unexpected error."""


@dataclass(frozen=True)
class SignedUpload:
    """A one-object upload capability. `url` and `token` are secrets."""

    url: str
    token: str
    resumable_endpoint: str


@dataclass(frozen=True)
class ObjectDigest:
    size: int
    sha256: str
    # First bytes of the object (file signature check).
    head: bytes


class Storage(Protocol):
    def create_signed_upload(self, bucket: str, key: str) -> SignedUpload: ...

    def digest(self, bucket: str, key: str, *, max_bytes: int) -> ObjectDigest | None:
        """SHA-256 and size of an object (streamed), `None` if it does not exist.

        Stops reading after `max_bytes + 1` bytes (the reported size then exceeds the limit).
        """
        ...

    def create_signed_read_url(self, bucket: str, key: str, expires_in: int) -> str: ...

    def delete(self, bucket: str, key: str) -> None: ...


def _is_not_found(response: httpx.Response) -> bool:
    # Storage reports a missing object as HTTP 400 with `statusCode: "404"` in the body.
    if response.status_code == 404:
        return True
    if response.status_code != 400:
        return False
    try:
        body = response.json()
    except ValueError:
        return False
    return isinstance(body, dict) and str(body.get("statusCode")) == "404"


class SupabaseStorage:
    def __init__(
        self,
        base_url: str,
        secret_key: str,
        *,
        public_url: str | None = None,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._api = base_url.rstrip("/") + _STORAGE_PATH
        self._public = (public_url or base_url).rstrip("/") + _STORAGE_PATH
        self._client = httpx.Client(
            base_url=self._api,
            headers={"apikey": secret_key, "Authorization": f"Bearer {secret_key}"},
            timeout=timeout,
            transport=transport,
            follow_redirects=False,
        )

    def close(self) -> None:
        self._client.close()

    @staticmethod
    def _path(bucket: str, key: str) -> str:
        return f"{quote(bucket, safe='')}/{quote(key, safe='/')}"

    @contextmanager
    def _errors(self, operation: str) -> Iterator[None]:
        try:
            yield
        except httpx.HTTPError as exc:
            # Only the exception class: messages can carry URLs.
            logger.warning("storage %s failed: %s", operation, type(exc).__name__)
            raise StorageUnavailableError(operation) from None

    def _check(self, response: httpx.Response, operation: str) -> None:
        if response.is_success:
            return
        logger.warning("storage %s failed: HTTP %s", operation, response.status_code)
        raise StorageUnavailableError(operation)

    def create_signed_upload(self, bucket: str, key: str) -> SignedUpload:
        with self._errors("sign-upload"):
            res = self._client.post(f"/object/upload/sign/{self._path(bucket, key)}")
        self._check(res, "sign-upload")
        body = res.json()
        url, token = body.get("url"), body.get("token")
        if not isinstance(url, str) or not isinstance(token, str) or not url.startswith("/"):
            raise StorageUnavailableError("sign-upload")
        return SignedUpload(
            url=self._public + url,
            token=token,
            resumable_endpoint=f"{self._public}/upload/resumable/sign",
        )

    def digest(self, bucket: str, key: str, *, max_bytes: int) -> ObjectDigest | None:
        sha = hashlib.sha256()
        size = 0
        head = b""
        with (
            self._errors("download"),
            self._client.stream("GET", f"/object/{self._path(bucket, key)}") as res,
        ):
            if res.status_code in (400, 404):
                res.read()
                if _is_not_found(res):
                    return None
            self._check(res, "download")
            for chunk in res.iter_bytes(chunk_size=1 << 20):
                if len(head) < len(PDF_MAGIC):
                    head = (head + chunk)[: len(PDF_MAGIC)]
                size += len(chunk)
                if size > max_bytes:
                    break
                sha.update(chunk)
        return ObjectDigest(size=size, sha256=sha.hexdigest(), head=head)

    def create_signed_read_url(self, bucket: str, key: str, expires_in: int) -> str:
        with self._errors("sign-read"):
            res = self._client.post(
                f"/object/sign/{self._path(bucket, key)}", json={"expiresIn": expires_in}
            )
        self._check(res, "sign-read")
        signed = res.json().get("signedURL")
        if not isinstance(signed, str) or not signed.startswith("/"):
            raise StorageUnavailableError("sign-read")
        return self._public + signed

    def delete(self, bucket: str, key: str) -> None:
        with self._errors("delete"):
            res = self._client.delete(f"/object/{self._path(bucket, key)}")
        if not res.is_success and not _is_not_found(res):
            self._check(res, "delete")


def build_storage(settings: Settings) -> SupabaseStorage | None:
    """`None` (routes answer 503) unless both the Storage URL and the secret key are set."""
    secret = settings.supabase_secret_key
    if not settings.supabase_url or secret is None or not secret.get_secret_value():
        return None
    return SupabaseStorage(
        settings.supabase_url,
        secret.get_secret_value(),
        public_url=settings.storage_public_url,
        timeout=settings.storage_timeout_seconds,
    )
