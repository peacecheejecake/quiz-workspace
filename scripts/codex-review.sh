#!/usr/bin/env bash
# Run `codex review` (default model) in a reusable herdr side pane and wait for it.
#
# Usage:
#   scripts/codex-review.sh --commit <sha> [--title "<task id>: <summary>"]
#   scripts/codex-review.sh --base <ref>   [--title ...]
#   scripts/codex-review.sh --uncommitted  [--title ...]
#
# The review runs in a herdr pane labelled "codex-review" (split to the right of the
# caller on first use, reused afterwards; id cached in .reviews/.pane-id).
# The full output is saved to .reviews/<timestamp>-<slug>.log and its path is printed
# on the last line as `REVIEW_LOG=<path>`. Outside herdr, codex runs in the foreground.
# codex rejects a custom prompt together with a review target, so review guidance lives
# in AGENTS.md ("Review guidelines"), which codex loads automatically.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SELF="$ROOT/scripts/codex-review.sh"
REVIEW_DIR="$ROOT/.reviews"
PANE_FILE="$REVIEW_DIR/.pane-id"
LOCK_FILE="$REVIEW_DIR/.lock"
DONE_MARK="__CODEX_REVIEW_DONE__"
mkdir -p "$REVIEW_DIR"

# Inner mode: executed inside the review pane.
if [[ "${1:-}" == "--inner" ]]; then
  shift
  token="$1" log="$2"; shift 2
  trap 'rm -f "$LOCK_FILE"' EXIT
  clear
  echo "== codex review $* =="
  set +e
  codex review "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  echo "${DONE_MARK} ${token} exit=${status}"
  exit 0
fi

target=() title=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit|--base) target=("$1" "$2"); shift 2 ;;
    --uncommitted)   target=("$1"); shift ;;
    --title)         title="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ ${#target[@]} -gt 0 ]] || { echo "one of --commit/--base/--uncommitted is required" >&2; exit 2; }

args=("${target[@]}")
[[ -n "$title" ]] && args+=(--title "$title")

slug="$(printf '%s' "${title:-${target[*]}}" | tr -cs 'A-Za-z0-9._-' '-' | cut -c1-60)"
log="$REVIEW_DIR/$(date +%Y%m%d-%H%M%S)-${slug}.log"
token="$(date +%s)-$$"

if [[ "${HERDR_ENV:-}" != "1" ]]; then
  "$SELF" --inner "$token" "$log" "${args[@]}"
  echo "REVIEW_LOG=$log"
  exit 0
fi

if [[ -e "$LOCK_FILE" ]]; then
  echo "a codex review is already running (lock: $LOCK_FILE)" >&2; exit 3
fi

pane=""
if [[ -s "$PANE_FILE" ]]; then
  pane="$(cat "$PANE_FILE")"
  herdr pane get "$pane" >/dev/null 2>&1 || pane=""
fi
if [[ -z "$pane" ]]; then
  pane="$(herdr pane split --current --direction right --ratio 0.45 --cwd "$ROOT" --no-focus \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')"
  herdr pane rename "$pane" codex-review >/dev/null
  echo "$pane" > "$PANE_FILE"
  herdr pane wait-output "$pane" --regex '[%$#>❯] ?$' --source visible --timeout 15000 >/dev/null 2>&1 || true
fi

touch "$LOCK_FILE"
quoted="$(printf '%q ' "$SELF" --inner "$token" "$log" "${args[@]}")"
herdr pane run "$pane" "$quoted" >/dev/null
herdr pane wait-output "$pane" --match "${DONE_MARK} ${token}" --source recent-unwrapped \
  --timeout "${CODEX_REVIEW_TIMEOUT_MS:-1800000}" >/dev/null
echo "REVIEW_LOG=$log"
