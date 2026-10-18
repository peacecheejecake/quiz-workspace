"""Export the OpenAPI document to `contracts/openapi.json`, or check that it is current.

    uv run python -m quiz_api.openapi_export            # write
    uv run python -m quiz_api.openapi_export --check    # exit 1 if the committed file is stale

Output is deterministic: sorted keys, 2-space indent, trailing newline, and an app built
from default settings so local `.env` values never leak into the contract.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from quiz_api.main import create_app
from quiz_api.settings import Settings

DEFAULT_OUTPUT = Path("contracts/openapi.json")


def build_openapi() -> dict[str, Any]:
    # model_construct skips env/.env loading: the contract must not depend on local config.
    settings = Settings.model_construct()
    app = create_app(settings, readiness_checkers=[])
    return app.openapi()


def render_openapi() -> str:
    return json.dumps(build_openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--check", action="store_true", help="fail if the file differs from the app's schema"
    )
    args = parser.parse_args(argv)
    output: Path = args.output
    rendered = render_openapi()

    if args.check:
        current = output.read_text(encoding="utf-8") if output.exists() else None
        if current != rendered:
            print(
                f"{output} is stale. Run `make contracts` and commit the result.",
                file=sys.stderr,
            )
            return 1
        print(f"{output} is up to date.")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    print(f"Wrote {output}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
