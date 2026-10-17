#!/usr/bin/env bash
# Runs a command against the pinned visual renderer (M7.2, tests/e2e/README.md "Visual baselines").
#
#   scripts/visual-run.sh pnpm exec playwright test --project=visual-desktop --project=visual-ipad
#
# Visual baselines are Linux renders from the official Playwright image whose version equals the
# installed @playwright/test (fonts + rasterizer identical on macOS and CI). This starts
# `playwright run-server` in that image on a loopback port, exports E2E_VISUAL_WS_ENDPOINT for the
# Playwright configs (browser traffic to 127.0.0.1/localhost is tunnelled back to this host, so the
# web/API servers stay on loopback), runs the command, and stops the container.
# Already inside the image (CI job container)? Set E2E_VISUAL=1 and run the command directly.
# An existing E2E_VISUAL_WS_ENDPOINT is reused as is. Needs Docker.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/visual-run.sh <command...>" >&2
  exit 2
fi
if [[ -n "${E2E_VISUAL_WS_ENDPOINT:-}" ]]; then
  exec "$@"
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(cd "$root" && node -p "require('@playwright/test/package.json').version")"
image="mcr.microsoft.com/playwright:v${version}-noble"
port="${E2E_VISUAL_PORT:-3390}"
name="quiz-visual-renderer-${port}"

docker run -d --rm --init --ipc=host --name "$name" -p "127.0.0.1:${port}:3000" "$image" \
  /bin/sh -c "npx -y playwright@${version} run-server --port 3000 --host 0.0.0.0" >/dev/null
trap 'docker stop "$name" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 120); do
  if docker logs "$name" 2>&1 | grep -q 'Listening on'; then break; fi
  if ! docker inspect "$name" >/dev/null 2>&1; then
    echo "visual renderer container exited" >&2
    exit 1
  fi
  sleep 1
done
docker logs "$name" 2>&1 | grep -q 'Listening on' || {
  echo "visual renderer did not start" >&2
  exit 1
}

export E2E_VISUAL_WS_ENDPOINT="ws://127.0.0.1:${port}/"
"$@"
