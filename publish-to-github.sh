#!/usr/bin/env bash
set -euo pipefail

: "${REPOSITORY:=peacecheejecake/quiz-workspace}"
if ! command -v git >/dev/null; then echo "git required" >&2; exit 1; fi

git status --short
echo "Repository: ${REPOSITORY}"
echo "Commit your verified documentation and E2E files with git add/commit, then push to the configured remote."
echo "No credentials or private PDF assets should be committed."
