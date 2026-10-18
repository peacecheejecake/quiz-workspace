"""Validate a deployed service's environment against infra/deploy/env-manifest.toml (M7.4a).

    uv run python scripts/check_env.py --env staging --check api=api.staging.env
    uv run python scripts/check_env.py --env production --check web=- --check api=api.env
    uv run python scripts/check_env.py --env staging --template worker > worker.staging.env
    uv run python scripts/check_env.py --list [--service api]

`--check SERVICE=FILE` reads a dotenv file (`KEY=VALUE`, `export` and quotes allowed, `#`
comments); `FILE` = `-` reads the process environment. Several `--check` options are validated
together, so variables marked `same` (e.g. RELAY_CLIENT_SECRET on web and api) are compared
across services — by SHA-256 digest, in memory.

Output names variables and rules only: a value never appears on stdout/stderr, in exceptions or in
exit messages (docs/deployment.md §6). Exit status: 0 = no errors (warnings allowed), 1 = at least
one error, 2 = usage error.

Stdlib only (Python 3.12), so it also runs outside the uv environment.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "infra/deploy/env-manifest.toml"
KINDS = ("public", "config", "secret")


# --- value rules ---------------------------------------------------------------------------------
# Each returns None when the value passes, else a reason that never contains the value.

Rule = Callable[[str], "str | None"]


def _https_url(value: str) -> str | None:
    parts = urlsplit(value.strip())
    if parts.scheme != "https" or not parts.hostname:
        return "must be an https:// URL"
    if parts.username or parts.password:
        return "must not carry credentials"
    return None


def _https_origin(value: str) -> str | None:
    raw = value.strip()
    problem = _https_url(raw)
    if problem:
        return "must be an https:// origin"
    parts = urlsplit(raw)
    if parts.path not in ("", "/") or parts.query or parts.fragment or "*" in raw:
        return "must be exactly https://host[:port] (no path, wildcard or query)"
    if not raw.isascii() or raw != raw.lower():
        return "must be the browser's ASCII serialization (lowercase, punycode)"
    return None


def _origin_list(value: str) -> str | None:
    items = [item.strip() for item in value.split(",") if item.strip()]
    if not items:
        return "must list at least one origin"
    for item in items:
        if _https_origin(item):
            return "every entry must be an https://host[:port] origin (ASCII, no wildcard/path)"
    return None


def _scheme_url(*schemes: str) -> Rule:
    def rule(value: str) -> str | None:
        parts = urlsplit(value.strip())
        if parts.scheme not in schemes or not parts.hostname:
            return f"must be a {'/'.join(schemes)}:// URL"
        return None

    return rule


def _min_chars(n: int) -> Rule:
    def rule(value: str) -> str | None:
        return None if len(value) >= n else f"must have at least {n} characters"

    return rule


def _matches(pattern: str, reason: str) -> Rule:
    compiled = re.compile(pattern)

    def rule(value: str) -> str | None:
        return None if compiled.fullmatch(value.strip()) else reason

    return rule


def _number(value: str) -> str | None:
    try:
        float(value)
    except ValueError:
        return "must be a number"
    return None


def _not_fake(value: str) -> str | None:
    return "fake adapters are for local/test only" if value.strip().lower() == "fake" else None


def _publishable_key(value: str) -> str | None:
    if value.startswith("sb_secret_"):
        return "is a SECRET key; use the publishable key (sb_publishable_…)"
    return None if value.strip() else "must not be empty"


def _secret_key(value: str) -> str | None:
    if value.startswith("sb_publishable_"):
        return "is the publishable key; use the secret key (sb_secret_…)"
    return None if value.strip() else "must not be empty"


CHECKS: dict[str, Rule] = {
    "https_url": _https_url,
    "https_origin": _https_origin,
    "origin_list": _origin_list,
    "postgres_url": _scheme_url("postgresql", "postgres"),
    "redis_url": _scheme_url("redis", "rediss"),
    "min12": _min_chars(12),
    "min32": _min_chars(32),
    "nonempty": _min_chars(1),
    "number": _number,
    "bool": _matches(r"(?i)true|false|1|0|yes|no", "must be true or false"),
    "not_fake": _not_fake,
    "log_level": _matches(r"(?i)DEBUG|INFO|WARNING|ERROR|CRITICAL", "must be a log level"),
    "header_name": _matches(r"[a-z0-9-]+", "must be a lowercase header name"),
    "collection_prefix": _matches(r"[A-Za-z0-9_-]*", "only letters, digits, _ and -"),
    "publishable_key": _publishable_key,
    "secret_key": _secret_key,
    "email": _matches(r"[^@\s]+@[^@\s]+\.[^@\s]+", "must be an email address"),
    "hostname": _matches(r"[A-Za-z0-9.-]+", "must be a host name"),
    "uuid": _matches(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        "must be a UUID",
    ),
    "semver": _matches(r"\d+\.\d+\.\d+", "must be an exact version (x.y.z)"),
    "smoke_target": _matches(r"local|staging|production", "must be local, staging or production"),
    # Context-dependent rules (APP_ENV, auth callback) are handled in `check_service`.
    "app_env": lambda _value: None,
    "auth_callback": lambda _value: None,
}


# --- manifest ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Var:
    name: str
    services: tuple[str, ...]
    kind: str
    required: tuple[str, ...]
    forbidden: bool
    check: str | None
    same: bool
    requires: str | None
    provider: str
    note: str


@dataclass(frozen=True)
class Manifest:
    environments: tuple[str, ...]
    app_env: Mapping[str, str]
    platform_prefixes: tuple[str, ...]
    services: Mapping[str, str]
    vars: tuple[Var, ...]

    def for_service(self, service: str) -> list[Var]:
        return [v for v in self.vars if service in v.services]


class ManifestError(ValueError):
    pass


def load_manifest(path: Path = MANIFEST) -> Manifest:
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    meta = data["meta"]
    environments = tuple(meta["environments"])
    services = dict(data["services"])
    out: list[Var] = []
    seen: set[str] = set()
    for raw in data["var"]:
        name = raw["name"]
        if name in seen:
            raise ManifestError(f"{name} is listed twice")
        seen.add(name)
        unknown_services = set(raw["services"]) - services.keys()
        if unknown_services:
            raise ManifestError(f"{name}: unknown service(s) {sorted(unknown_services)}")
        if raw["kind"] not in KINDS:
            raise ManifestError(f"{name}: kind must be one of {KINDS}")
        check = raw.get("check")
        if check is not None and check not in CHECKS:
            raise ManifestError(f"{name}: unknown check {check}")
        required_raw = raw.get("required", False)
        required = (
            environments
            if required_raw is True
            else ()
            if required_raw is False
            else tuple(required_raw)
        )
        if set(required) - set(environments):
            raise ManifestError(f"{name}: required lists an unknown environment")
        out.append(
            Var(
                name=name,
                services=tuple(raw["services"]),
                kind=raw["kind"],
                required=required,
                forbidden=bool(raw.get("forbidden", False)),
                check=check,
                same=bool(raw.get("same", False)),
                requires=raw.get("requires"),
                provider=raw.get("provider", ""),
                note=raw.get("note", ""),
            )
        )
    names = {v.name for v in out}
    for var in out:
        if var.requires and var.requires not in names:
            raise ManifestError(f"{var.name}: requires unknown {var.requires}")
        if var.kind == "secret" and var.name.startswith("NEXT_PUBLIC_"):
            raise ManifestError(f"{var.name}: a secret must never use the NEXT_PUBLIC_ prefix")
        if var.name.startswith("NEXT_PUBLIC_") and var.kind != "public":
            raise ManifestError(f"{var.name}: NEXT_PUBLIC_ variables are public by definition")
        if var.forbidden and var.required:
            raise ManifestError(f"{var.name}: cannot be both required and forbidden")
    return Manifest(
        environments=environments,
        app_env=dict(meta["app_env"]),
        platform_prefixes=tuple(meta.get("platform_prefixes", ())),
        services=services,
        vars=tuple(out),
    )


# --- environment sources -------------------------------------------------------------------------

_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def parse_dotenv(text: str) -> dict[str, str]:
    """Minimal dotenv: KEY=VALUE per line, optional `export`, matching quotes stripped, `#`
    comments on their own line or after an unquoted value. Malformed lines are ignored (their
    content is never echoed)."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = _LINE.match(line)
        if not match:
            continue
        key, value = match.group(1), match.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        elif value.startswith("#"):
            value = ""
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        values[key] = value
    return values


# --- checking ------------------------------------------------------------------------------------


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    ok: list[str] = field(default_factory=list)


def _is_set(env: Mapping[str, str], name: str) -> bool:
    return bool(env.get(name, "").strip())


def check_service(
    manifest: Manifest, service: str, environment: str, env: Mapping[str, str], report: Report
) -> None:
    if service not in manifest.services:
        raise ManifestError(f"unknown service {service}")
    if environment not in manifest.environments:
        raise ManifestError(f"unknown environment {environment}")
    known = manifest.for_service(service)
    known_names = {v.name for v in known}
    all_forbidden = {v.name for v in manifest.vars if v.forbidden}

    for var in known:
        label = f"{service} {var.name}"
        present = _is_set(env, var.name)
        if var.forbidden:
            if var.name in env:
                report.errors.append(f"{label}: must not be set in {environment} ({var.note})")
            continue
        if not present:
            if environment in var.required:
                report.errors.append(f"{label}: missing (required in {environment})")
            elif var.requires and _is_set(env, var.requires):
                report.errors.append(f"{label}: missing (required when {var.requires} is set)")
            continue
        value = env[var.name]
        problem = CHECKS[var.check](value) if var.check else None
        if var.check == "app_env" and value.strip() != manifest.app_env[environment]:
            problem = f"must be {manifest.app_env[environment]} in {environment}"
        if var.check == "auth_callback":
            site = env.get("SUPABASE_AUTH_SITE_URL", "").strip().rstrip("/")
            if value.strip() != f"{site}/auth/callback" or _https_url(value):
                problem = "must be exactly <SUPABASE_AUTH_SITE_URL>/auth/callback"
        if problem:
            report.errors.append(f"{label}: {problem}")
        else:
            report.ok.append(label)

    for name in sorted(env):
        if name in known_names:
            continue
        if name in all_forbidden:
            report.errors.append(f"{service} {name}: must not be set in {environment}")
        elif name.startswith("NEXT_PUBLIC_"):
            # Anything NEXT_PUBLIC_ ships to every browser: only the listed public values may.
            report.errors.append(f"{service} {name}: NEXT_PUBLIC_ variable not in the manifest")
        elif not name.startswith(manifest.platform_prefixes):
            report.warnings.append(f"{service} {name}: not in the manifest (ignored by the app?)")


def check_same(
    manifest: Manifest, sources: Mapping[str, Mapping[str, str]], report: Report
) -> None:
    for var in manifest.vars:
        if not var.same:
            continue
        digests = {
            service: hashlib.sha256(env[var.name].encode()).hexdigest()
            for service, env in sources.items()
            if service in var.services and _is_set(env, var.name)
        }
        if len(set(digests.values())) > 1:
            services = " and ".join(sorted(digests))
            report.errors.append(f"{var.name}: differs between {services} (must be identical)")


def run_checks(
    manifest: Manifest, environment: str, sources: Mapping[str, Mapping[str, str]]
) -> Report:
    report = Report()
    for service, env in sources.items():
        check_service(manifest, service, environment, env, report)
    check_same(manifest, sources, report)
    return report


def template(manifest: Manifest, service: str, environment: str) -> str:
    """A fill-in env file: required variables uncommented and empty, optional ones commented."""
    lines = [f"# {service} — {environment} ({manifest.services[service]})"]
    for var in manifest.for_service(service):
        if var.forbidden:
            continue
        hint = f"# {var.kind}; {var.provider}" + (f"; {var.note}" if var.note else "")
        value = manifest.app_env[environment] if var.check == "app_env" else ""
        prefix = "" if environment in var.required else "# "
        lines += [hint, f"{prefix}{var.name}={value}"]
    return "\n".join(lines) + "\n"


def listing(manifest: Manifest, service: str | None) -> str:
    rows = []
    for var in manifest.vars:
        if service and service not in var.services:
            continue
        status = (
            "forbidden"
            if var.forbidden
            else "required"
            if var.required == manifest.environments
            else f"required: {','.join(var.required)}"
            if var.required
            else "optional"
        )
        rows.append(f"{var.name:44} {var.kind:7} {status:20} {','.join(var.services)}")
    return "\n".join(rows) + "\n"


def _source(spec: str) -> tuple[str, dict[str, str]]:
    if "=" not in spec:
        raise ValueError("--check expects SERVICE=FILE (FILE '-' = process environment)")
    service, path = spec.split("=", 1)
    if path == "-":
        return service, dict(os.environ)
    return service, parse_dotenv(Path(path).read_text(encoding="utf-8"))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--env", dest="environment", help="staging | production")
    parser.add_argument("--check", action="append", default=[], metavar="SERVICE=FILE")
    parser.add_argument("--template", metavar="SERVICE")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--service", help="with --list: only this service")
    args = parser.parse_args(argv)

    try:
        manifest = load_manifest(args.manifest)
        if args.list:
            sys.stdout.write(listing(manifest, args.service))
            return 0
        if not args.environment or args.environment not in manifest.environments:
            parser.error(f"--env must be one of {', '.join(manifest.environments)}")
        if args.template:
            sys.stdout.write(template(manifest, args.template, args.environment))
            return 0
        if not args.check:
            parser.error("nothing to do: pass --check SERVICE=FILE, --template or --list")
        sources = dict(_source(spec) for spec in args.check)
        report = run_checks(manifest, args.environment, sources)
    except (ManifestError, ValueError, OSError, KeyError) as exc:
        # Messages name services/variables/paths only.
        print(f"check_env: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    for line in report.warnings:
        print(f"warning  {line}")
    for line in report.errors:
        print(f"ERROR    {line}")
    print(
        f"check_env: {args.environment}: {len(report.ok)} ok, {len(report.warnings)} warning(s), "
        f"{len(report.errors)} error(s) [{', '.join(sources)}]"
    )
    return 1 if report.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
