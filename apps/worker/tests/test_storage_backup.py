"""Storage backup/restore (quiz_worker.storage_backup, M7.3) on an in-memory Storage, plus the
real `SupabaseStorage` client against an httpx mock transport (upsert upload, header-only key)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import httpx
import pytest
from quiz_worker import storage_backup
from quiz_worker.storage import ObjectMissingError, SupabaseStorage
from quiz_worker.storage_backup import Listed, blob_path, dump, read_manifest, restore, verify


class MemoryStorage:
    def __init__(self, objects: dict[tuple[str, str], bytes] | None = None) -> None:
        self.objects = dict(objects or {})
        self.uploads: list[tuple[str, str, str]] = []

    def download(self, bucket: str, key: str, dest: Path, *, max_bytes: int) -> object:
        data = self.objects.get((bucket, key))
        if data is None:
            raise ObjectMissingError("gone")
        dest.write_bytes(data)
        return None

    def upload(self, bucket: str, key: str, data: bytes, *, content_type: str) -> None:
        self.objects[(bucket, key)] = data
        self.uploads.append((bucket, key, content_type))


PDF = b"%PDF-1.7 synthetic"
JSON_DOC = b'{"pages": []}'
SOURCE = {
    ("source-pdfs", "workspaces/a/documents/1/revisions/1/source.pdf"): PDF,
    # A fork copy: same bytes under another key -> one blob.
    ("source-pdfs", "workspaces/b/documents/2/revisions/2/source.pdf"): PDF,
    ("parsed-artifacts", "workspaces/a/documents/1/revisions/1/parsed_document.json"): JSON_DOC,
}


def _listed(objects: dict[tuple[str, str], bytes]) -> list[Listed]:
    return [
        Listed(b, n, len(d), "application/pdf" if b == "source-pdfs" else "application/json")
        for (b, n), d in objects.items()
    ]


def test_dump_verify_restore_round_trip(tmp_path: Path) -> None:
    report, entries = dump(_listed(SOURCE), MemoryStorage(SOURCE), tmp_path, workers=2)

    assert (report.objects, report.bytes, report.missing, report.failed) == (
        3,
        2 * len(PDF) + len(JSON_DOC),
        0,
        0,
    )
    blobs = [p for p in (tmp_path / "blobs").rglob("*") if p.is_file()]
    assert len(blobs) == 2, "identical objects share one blob"
    manifest = read_manifest(tmp_path)
    assert manifest == entries
    assert [(e.bucket, e.name) for e in manifest] == sorted(SOURCE)
    assert {e.sha256 for e in manifest} == {
        hashlib.sha256(PDF).hexdigest(),
        hashlib.sha256(JSON_DOC).hexdigest(),
    }
    assert verify(tmp_path, manifest).objects == 3

    target = MemoryStorage()
    restored = restore(tmp_path, manifest, target, workers=2)

    assert (restored.objects, restored.failed) == (3, 0)
    assert target.objects == SOURCE
    assert {(b, ct) for b, _, ct in target.uploads} == {
        ("source-pdfs", "application/pdf"),
        ("parsed-artifacts", "application/json"),
    }
    # Idempotent: restoring again replaces with identical bytes.
    assert restore(tmp_path, manifest, target).objects == 3
    assert target.objects == SOURCE


def test_object_deleted_after_listing_is_counted_missing(tmp_path: Path) -> None:
    listed = _listed(SOURCE)
    present = dict(SOURCE)
    present.pop(next(iter(SOURCE)))

    report, entries = dump(listed, MemoryStorage(present), tmp_path)

    assert (report.objects, report.missing) == (2, 1)
    assert len(entries) == 2


def test_restore_refuses_a_corrupt_or_incomplete_dump(tmp_path: Path) -> None:
    _, entries = dump(_listed(SOURCE), MemoryStorage(SOURCE), tmp_path)
    blob_path(tmp_path, entries[0].sha256).write_bytes(b"tampered")
    target = MemoryStorage()

    report = restore(tmp_path, entries, target)

    assert report.corrupt >= 1
    assert target.uploads == [], "nothing is uploaded unless every blob verifies"
    blob_path(tmp_path, entries[-1].sha256).unlink()
    assert verify(tmp_path, entries).missing >= 1


def test_supabase_client_upserts_with_the_key_in_headers_only(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"Key": "x"})

    storage = SupabaseStorage(
        "http://storage.test", "sb_secret_unit", transport=httpx.MockTransport(handler)
    )
    _, entries = dump(_listed(SOURCE), MemoryStorage(SOURCE), tmp_path)

    report = restore(tmp_path, entries, storage, workers=1)

    assert report.objects == 3
    assert {r.headers["x-upsert"] for r in seen} == {"true"}
    assert all("sb_secret_unit" not in str(r.url) for r in seen)
    assert {r.url.path for r in seen} == {
        f"/storage/v1/object/{bucket}/{name}" for bucket, name in SOURCE
    }


def test_cli_verify_and_dry_run_print_counts_only(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    dump(_listed(SOURCE), MemoryStorage(SOURCE), tmp_path)

    assert storage_backup.main(["verify", "--from", str(tmp_path)]) == 0
    assert storage_backup.main(["restore", "--from", str(tmp_path), "--dry-run"]) == 0

    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [line["objects"] for line in lines] == [3, 3]
    assert "workspaces/" not in json.dumps(lines)


def test_cli_dump_requires_an_admin_db_url(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("BACKUP_DB_URL", raising=False)
    with pytest.raises(SystemExit, match="BACKUP_DB_URL"):
        storage_backup.main(["dump", "--out", str(tmp_path)])
