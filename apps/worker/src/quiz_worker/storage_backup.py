"""Supabase Storage objects backup and restore (M7.3, docs/deployment.md §7, DEP-06).

Used by `scripts/backup` / `scripts/restore` next to the Postgres dump; runnable on its own:

    python -m quiz_worker.storage_backup check
    python -m quiz_worker.storage_backup dump    --out <dir>/storage --from-dump <dir>/db/data.sql
    python -m quiz_worker.storage_backup restore --from <dir>/storage [--dry-run]
    python -m quiz_worker.storage_backup verify  --from <dir>/storage

Storage target: `SUPABASE_URL` (or NEXT_PUBLIC_SUPABASE_URL) and `SUPABASE_SECRET_KEY`
(server-only; header only, never in a URL or log line), from the environment or, when unset there,
from `./.env` (the repo-root file the apps read). `check` validates them and probes the Storage
API before anything is written; `scripts/restore` runs it before touching the database.
`dump --from-dump` takes the object inventory from the `storage.objects` COPY block of the DB data
dump, so the inventory is exactly the DB snapshot's; without it `BACKUP_DB_URL` (an admin
connection) is listed live.

Layout (content-addressed, so fork copies of the same PDF are stored once and object names never
become file paths):

    manifest.jsonl          one line per object: bucket, name, size, sha256, content_type
    blobs/<sha[:2]>/<sha>   the object bytes

- `dump` downloads every inventoried object through the Storage API, hashing on the way. An
  object the snapshot references but Storage no longer has (deleted after the snapshot, e.g. a
  fork cleanup) fails the dump (exit status 1 unless `--allow-missing`): take the backup again.
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
from collections.abc import Callable, Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Protocol

import httpx

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


_COPY_ESCAPES = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "\\": "\\"}


def _copy_field(raw: str) -> str | None:
    """One field of PostgreSQL's COPY text format (`\\N` = NULL, backslash escapes)."""
    if raw == "\\N":
        return None
    out: list[str] = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == "\\" and i + 1 < len(raw):
            nxt = raw[i + 1]
            out.append(_COPY_ESCAPES.get(nxt, nxt))
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def inventory_from_dump(data_sql: Path) -> list[Listed]:
    """Objects of the `storage.objects` COPY block in a `pg_dump --data-only` file: the inventory
    of exactly the snapshot the DB dump captured."""
    header: list[str] | None = None
    rows: list[Listed] = []
    with data_sql.open(encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.rstrip("\n")
            if header is None:
                if line.startswith(('COPY "storage"."objects" (', "COPY storage.objects (")):
                    cols = line[line.index("(") + 1 : line.index(")")]
                    header = [c.strip().strip('"') for c in cols.split(",")]
                continue
            if line == "\\.":
                break
            values = dict(zip(header, (_copy_field(v) for v in line.split("\t")), strict=True))
            if values.get("name") is None or values.get("bucket_id") is None:
                continue
            meta = json.loads(values.get("metadata") or "null") or {}
            rows.append(
                Listed(
                    str(values["bucket_id"]),
                    str(values["name"]),
                    int(meta.get("size") or 0),
                    str(meta.get("mimetype") or "application/octet-stream"),
                )
            )
    if header is None:
        raise ValueError("the dump has no storage.objects data block")
    return sorted(rows, key=lambda r: (r.bucket, r.name))


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


def _dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return values


@dataclass(frozen=True)
class StorageConfig:
    url: str
    secret_key: str = field(repr=False)


def storage_config(
    env: Mapping[str, str] | None = None, dotenv: Path | None = Path(".env")
) -> StorageConfig:
    """The Storage target from the environment, falling back to `.env` per variable (like the
    apps). Raises SystemExit naming the problem (never a value)."""
    environ = dict(os.environ if env is None else env)
    fallback = _dotenv(dotenv) if dotenv is not None else {}

    def get(name: str) -> str:
        return (environ.get(name) or fallback.get(name) or "").strip()

    url = get("SUPABASE_URL") or get("NEXT_PUBLIC_SUPABASE_URL")
    key = get("SUPABASE_SECRET_KEY")
    if not url or not key:
        raise SystemExit(
            "storage_backup: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY "
            "are required (environment or .env)"
        )
    if not url.startswith(("http://", "https://")):
        raise SystemExit("storage_backup: SUPABASE_URL must be an http(s) URL")
    return StorageConfig(url.rstrip("/"), key)


def check_storage(config: StorageConfig, transport: httpx.BaseTransport | None = None) -> None:
    """The Storage API answers the bucket listing with this key (SystemExit otherwise)."""
    try:
        with httpx.Client(transport=transport, timeout=15) as client:
            res = client.get(
                f"{config.url}/storage/v1/bucket",
                headers={
                    "apikey": config.secret_key,
                    "Authorization": f"Bearer {config.secret_key}",
                },
            )
    except httpx.HTTPError as exc:
        raise SystemExit(f"storage_backup: Storage unreachable ({type(exc).__name__})") from None
    if res.status_code != 200:
        raise SystemExit(f"storage_backup: Storage rejected the key (HTTP {res.status_code})")


def _storage(config: StorageConfig) -> SupabaseStorage:
    return SupabaseStorage(config.url, config.secret_key, timeout=120)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m quiz_worker.storage_backup")
    sub = parser.add_subparsers(dest="command", required=True)
    p_dump = sub.add_parser("dump", help="download every Storage object into a directory")
    p_dump.add_argument("--out", type=Path, required=True)
    p_dump.add_argument("--allow-missing", action="store_true")
    p_dump.add_argument(
        "--from-dump",
        type=Path,
        help="take the inventory from this data dump's storage.objects block (DB snapshot)",
    )
    sub.add_parser("check", help="validate the Storage target configuration and key")
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
    if args.command == "check":
        check_storage(storage_config())
        print(json.dumps({"command": "check", "ok": True}, separators=(",", ":")))
        return 0
    if args.command == "dump":
        config = storage_config()
        if args.from_dump is not None:
            listed = inventory_from_dump(args.from_dump)
        else:
            db_url = os.environ.get("BACKUP_DB_URL")
            if not db_url:
                raise SystemExit("storage_backup: --from-dump or BACKUP_DB_URL is required")
            listed = list_objects(db_url)
        check_storage(config)
        storage = _storage(config)
        try:
            report, _ = dump(listed, storage, args.out, workers=args.workers)
        finally:
            storage.close()
        ok = not report.failed and (args.allow_missing or not report.missing)
    elif args.command == "verify" or args.dry_run:
        report = verify(args.source, read_manifest(args.source))
        ok = not (report.missing or report.corrupt)
    else:
        config = storage_config()
        check_storage(config)
        storage = _storage(config)
        try:
            report = restore(args.source, read_manifest(args.source), storage, workers=args.workers)
        finally:
            storage.close()
        ok = not (report.missing or report.corrupt or report.failed)
    print(json.dumps({"command": args.command, **report.as_dict()}, separators=(",", ":")))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
