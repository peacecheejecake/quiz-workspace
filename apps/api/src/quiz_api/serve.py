"""The only supported way to run the API server (local `make api-dev` and deployments).

    uv run python -m quiz_api.serve [--host 127.0.0.1] [--port 8000] [--reload]

It disables uvicorn's access log (which records query strings) and routes uvicorn's own
loggers through the app's redacting handler; see `quiz_api.logging_config`.
"""

from __future__ import annotations

import argparse

import uvicorn

from quiz_api.logging_config import UVICORN_LOG_CONFIG, configure_logging

APP_FACTORY = "quiz_api.main:create_app"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run the Quiz Workspace API.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args(argv)

    # Installed before uvicorn starts so its startup lines are redacted and formatted too.
    configure_logging()
    uvicorn.run(
        APP_FACTORY,
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
        access_log=False,
        # No `Server: uvicorn` banner (docs/auth.md §5); SecurityHeadersMiddleware sets the rest.
        server_header=False,
        # Never take the client address or scheme from X-Forwarded-For/-Proto (uvicorn trusts
        # them from 127.0.0.1 by default, or from anyone with FORWARDED_ALLOW_IPS=*): the
        # per-client rate limits key on the socket peer or the signed relay identity only
        # (implementation-plan §7, quiz_api.relay_client). HSTS uses `is_deployed`.
        proxy_headers=False,
        log_config=UVICORN_LOG_CONFIG,
    )


if __name__ == "__main__":
    main()
