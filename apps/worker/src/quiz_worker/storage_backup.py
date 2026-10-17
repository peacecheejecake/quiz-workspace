"""Supabase Storage objects backup and restore (M7.3, docs/deployment.md §7, DEP-06).

Used by `scripts/backup` / `scripts/restore` next to the Postgres dump; runnable on its own:

    python -m quiz_worker.storage_backup dump    --out <dir>/storage
    python -m quiz_worker.storage_backup restore --from <dir>/storage [--dry-run]
    python -m quiz_worker.storage_backup verify  --from <dir>/storage

Environment: `BACKUP_DB_URL` (an admin connection that can read `storage.objects`, e.g. the local
`postgres` superuser or a hosted project's `postgres` user), `SUPABASE_URL` (or
NEXT_PUBLIC_SUPABASE_URL) and `SUPABASE_SECRET_KEY` (server-only; header only, never in a URL or
log line).

Layout (content-addressed, so fork copies of the same PDF are stored once and object names never
become file paths):

    manifest.jsonl          one line per object: bucket, name, size, sha256, content_type
    blobs/<sha[:2]>/<sha>   the object bytes

- `dump` lists objects from `storage.objects` (the same snapshot the DB dump records) and
  downloads each through the Storage API, hashing on the way. An object deleted between listing
  and download is reported and skipped (exit status 1 unless `--allow-missing`).
- `restore` checks every blob's SHA-256 first, then uploads with upsert (idempotent: a re-run or
  an object restored by the DB dump's metadata rows is replaced with identical bytes). Buckets
  come from supabase/migrations, not from here.
- Output is counts only; object names are server-generated ids, still never printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import tempfile
import threading
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from quiz_worker.storage import ObjectMissingError, SupabaseStorage

logger = logging.getLogger(__name__)

MANIFEST = "manifest.jsonl"
BLOBS = "blobs"
MAX_OBJECT_BYTES = 1 << 31  # far above the 50 MiB bucket limit; a sanity bound only
_LIST_OBJECTS = """
    select bucket_id, name, coalesce((metadata->>'size')::bigint, 0) as size,
           coalesce(metadata->>'mimetype', 'application/octet-stream') as content_type
      from storage.objects
     where name is not null
     order by bucket_id, name
"""


@dataclass(frozen=True)
class Entry:
    bucket: str
    name: str
    size: int
    sha256: str
    content_type: str


@dataclass(frozen=True)
class Listed:
    bucket: str
    name: str
    size: int
    content_type: str


class Storage(Protocol):
    def download(self, bucket: str, key: str, dest: Path, *, max_bytes: int) -> object: ...

    def upload(self, bucket: str, key: str, data: bytes, *, content_type: str) -> None: ...


def blob_path(root: Path, sha256: str) -> Path:
    return root / BLOBS / sha256[:2] / sha256


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def list_objects(db_url: str) -> list[Listed]:
    import psycopg

    with psycopg.connect(db_url, connect_timeout=10) as conn:
        rows = conn.execute(_LIST_OBJECTS).fetchall()
    return [Listed(str(b), str(n), int(s), str(c)) for b, n, s, c in rows]


def read_manifest(root: Path) -> list[Entry]:
    entries = []
    with (root / MANIFEST).open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                entries.append(Entry(**json.loads(line)))
    return entries


@dataclass
class Report:
    objects: int = 0
    bytes: int = 0
    missing: int = 0
    corrupt: int = 0
    failed: int = 0

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def _parallel[T](items: Iterable[T], work: Callable[[T], None], workers: int) -> None:
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for future in [pool.submit(work, item) for item in items]:
            future.result()


def dump(
    objects: Sequence[Listed], storage: Storage, out: Path, *, workers: int = 8
) -> tuple[Report, list[Entry]]:
    """Download every listed object into `out` and write the manifest (sorted, deterministic)."""
    (out / BLOBS).mkdir(parents=True, exist_ok=True)
    report = Report()
    entries: list[Entry] = []
    lock = threading.Lock()

    def one(item: Listed) -> None:
        with tempfile.NamedTemporaryFile(dir=out / BLOBS, delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            try:
                storage.download(item.bucket, item.name, tmp_path, max_bytes=MAX_OBJECT_BYTES)
            except ObjectMissingError:
                with lock:
                    report.missing += 1
                return
            except Exception as exc:
                logger.warning("storage backup: download failed (%s)", type(exc).__name__)
                with lock:
                    report.failed += 1
                return
            sha = sha256_file(tmp_path)
            size = tmp_path.stat().st_size
            target = blob_path(out, sha)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(tmp_path, target)
            with lock:
                entries.append(Entry(item.bucket, item.name, size, sha, item.content_type))
                report.objects += 1
                report.bytes += size
        finally:
            tmp_path.unlink(missing_ok=True)

    _parallel(objects, one, workers)
    entries.sort(key=lambda e: (e.bucket, e.name))
    with (out / MANIFEST).open("w", encoding="utf-8") as fh:
        for entry in entries:
            fh.write(json.dumps(asdict(entry), separators=(",", ":"), ensure_ascii=False) + "\n")
    return report, entries


def verify(root: Path, entries: Sequence[Entry]) -> Report:
    """Every manifest entry has a blob of the recorded size and SHA-256."""
    report = Report()
    for entry in entries:
        path = blob_path(root, entry.sha256)
        if not path.is_file():
            report.missing += 1
        elif path.stat().st_size != entry.size or sha256_file(path) != entry.sha256:
            report.corrupt += 1
        else:
            report.objects += 1
            report.bytes += entry.size
    return report


def restore(root: Path, entries: Sequence[Entry], storage: Storage, *, workers: int = 8) -> Report:
    """Upload every entry (upsert). Refuses to start unless every blob verifies."""
    checked = verify(root, entries)
    if checked.missing or checked.corrupt:
        return checked
    report = Report()
    lock = threading.Lock()

    def one(entry: Entry) -> None:
        data = blob_path(root, entry.sha256).read_bytes()
        try:
            storage.upload(entry.bucket, entry.name, data, content_type=entry.content_type)
        except Exception as exc:
            logger.warning("storage restore: upload failed (%s)", type(exc).__name__)
            with lock:
                report.failed += 1
            return
        with lock:
            report.objects += 1
            report.bytes += entry.size

    _parallel(entries, one, workers)
    return report


# --------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------


def _storage_from_env() -> SupabaseStorage:
    url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not url or not key:
        raise SystemExit("storage_backup: SUPABASE_URL and SUPABASE_SECRET_KEY are required")
    return SupabaseStorage(url, key, timeout=120)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m quiz_worker.storage_backup")
    sub = parser.add_subparsers(dest="command", required=True)
    p_dump = sub.add_parser("dump", help="download every Storage object into a directory")
    p_dump.add_argument("--out", type=Path, required=True)
    p_dump.add_argument("--allow-missing", action="store_true")
    p_restore = sub.add_parser("restore", help="upload a dump back (upsert)")
    p_restore.add_argument("--from", dest="source", type=Path, required=True)
    p_restore.add_argument(
        "--dry-run", action="store_true", help="verify the blobs only, upload nothing"
    )
    p_verify = sub.add_parser("verify", help="check a dump's blobs against its manifest")
    p_verify.add_argument("--from", dest="source", type=Path, required=True)
    for p in (p_dump, p_restore):
        p.add_argument("--workers", type=int, default=8)
    args = parser.parse_args(argv)

    from quiz_worker.logging_config import configure_logging

    configure_logging(os.environ.get("LOG_LEVEL", "INFO"))
    # httpx logs every request URL (bucket + object name) at INFO.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if args.command == "dump":
        db_url = os.environ.get("BACKUP_DB_URL")
        if not db_url:
            raise SystemExit("storage_backup: BACKUP_DB_URL is required")
        listed = list_objects(db_url)
        storage = _storage_from_env()
        try:
            report, _ = dump(listed, storage, args.out, workers=args.workers)
        finally:
            storage.close()
        ok = not report.failed and (args.allow_missing or not report.missing)
    elif args.command == "verify" or args.dry_run:
        report = verify(args.source, read_manifest(args.source))
        ok = not (report.missing or report.corrupt)
    else:
        storage = _storage_from_env()
        try:
            report = restore(args.source, read_manifest(args.source), storage, workers=args.workers)
        finally:
            storage.close()
        ok = not (report.missing or report.corrupt or report.failed)
    print(json.dumps({"command": args.command, **report.as_dict()}, separators=(",", ":")))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
