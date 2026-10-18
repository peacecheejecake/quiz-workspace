"""Server-side Supabase Storage client for jobs (M3.2b; docs/deployment.md §2 step 4).

The worker reads originals from the private `source-pdfs` bucket and writes parse artifacts to
the private `parsed-artifacts` bucket with the server-only secret key. The key travels in
headers only, so request URLs (which httpx may log) never carry a credential; errors keep only
the operation name and HTTP status, never a URL or a response body. Object keys come from DB
rows written by the API from server-generated ids, never from job payload text.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import httpx

from quiz_worker.errors import JobError, NonRetryableJobError

logger = logging.getLogger(__name__)

SOURCE_BUCKET = "source-pdfs"
PARSED_BUCKET = "parsed-artifacts"
_STORAGE_PATH = "/storage/v1"


class StorageUnavailableError(JobError):
    """Storage could not be reached or failed unexpectedly (retryable)."""

    code = "storage_unavailable"


class ObjectMissingError(NonRetryableJobError):
    code = "source_missing"


class ObjectTooLargeError(NonRetryableJobError):
    code = "source_too_large"


@dataclass(frozen=True)
class DownloadedObject:
    path: Path
    size: int
    sha256: str


class ObjectStorage(Protocol):
    def download(self, bucket: str, key: str, dest: Path, *, max_bytes: int) -> DownloadedObject:
        """Stream an object into `dest` (SHA-256 computed on the way); raises
        `ObjectMissingError` / `ObjectTooLargeError` / `StorageUnavailableError`."""
        ...

    def upload(self, bucket: str, key: str, data: bytes, *, content_type: str) -> None:
        """Create or replace an object (idempotent)."""
        ...

    def delete(self, bucket: str, key: str) -> None:
        """Remove an object; a missing object is not an error."""
        ...


class ObjectCopier(Protocol):
    """Server-side copies for the fork job (S3a): no bytes pass through the worker."""

    def copy(self, bucket: str, source_key: str, dest_key: str) -> None:
        """Copy an object inside `bucket`, replacing `dest_key` (idempotent); raises
        `ObjectMissingError` when the source does not exist."""
        ...

    def delete(self, bucket: str, key: str) -> None:
        """Remove an object; a missing object is not an error."""
        ...


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
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/") + _STORAGE_PATH,
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

    @staticmethod
    def _check(response: httpx.Response, operation: str) -> None:
        if response.is_success:
            return
        logger.warning("storage %s failed: HTTP %s", operation, response.status_code)
        raise StorageUnavailableError(f"{operation} HTTP {response.status_code}")

    def download(self, bucket: str, key: str, dest: Path, *, max_bytes: int) -> DownloadedObject:
        sha = hashlib.sha256()
        size = 0
        with (
            self._errors("download"),
            self._client.stream("GET", f"/object/{self._path(bucket, key)}") as res,
        ):
            if res.status_code in (400, 404):
                res.read()
                if _is_not_found(res):
                    raise ObjectMissingError("source object not found")
            self._check(res, "download")
            with dest.open("wb") as out:
                for chunk in res.iter_bytes(chunk_size=1 << 20):
                    size += len(chunk)
                    if size > max_bytes:
                        raise ObjectTooLargeError(f"source exceeds {max_bytes} bytes")
                    sha.update(chunk)
                    out.write(chunk)
        return DownloadedObject(path=dest, size=size, sha256=sha.hexdigest())

    def upload(self, bucket: str, key: str, data: bytes, *, content_type: str) -> None:
        with self._errors("upload"):
            res = self._client.post(
                f"/object/{self._path(bucket, key)}",
                content=data,
                headers={"content-type": content_type, "x-upsert": "true"},
            )
        self._check(res, "upload")

    def copy(self, bucket: str, source_key: str, dest_key: str) -> None:
        with self._errors("copy"):
            res = self._client.post(
                "/object/copy",
                json={"bucketId": bucket, "sourceKey": source_key, "destinationKey": dest_key},
                # A retried copy replaces its own earlier result (same immutable source).
                headers={"x-upsert": "true"},
            )
        if _is_not_found(res):
            raise ObjectMissingError("source object not found")
        self._check(res, "copy")

    def delete(self, bucket: str, key: str) -> None:
        with self._errors("delete"):
            res = self._client.delete(f"/object/{self._path(bucket, key)}")
        if not res.is_success and not _is_not_found(res):
            self._check(res, "delete")
