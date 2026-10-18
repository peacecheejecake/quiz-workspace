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
# The full output is saved to .reviews/<timestamp>-<pid>-<slug>.log and its path is printed
# on the last line as `REVIEW_LOG=<path>`. Outside herdr, codex runs in the foreground.
# codex rejects a custom prompt together with a review target, so review guidance lives
# in AGENTS.md ("Review guidelines"), which codex loads automatically.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SELF="$ROOT/scripts/codex-review.sh"
REVIEW_DIR="$ROOT/.reviews"
PANE_FILE="$REVIEW_DIR/.pane-id"
LOCK_DIR="$REVIEW_DIR/.lock"
DONE_MARK="__CODEX_REVIEW_DONE__"
mkdir -p "$REVIEW_DIR"

# Inner mode: executed inside the review pane.
if [[ "${1:-}" == "--inner" ]]; then
  shift
  token="$1" log="$2"; shift 2
  # In pane mode the caller hands lock ownership to this process (see below).
  if [[ "${CODEX_REVIEW_LOCK_HANDOFF:-}" == "1" ]]; then
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
  fi
  clear
  echo "== codex review $* =="
  set +e
  codex review "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  # Persist the status before the lock is released (EXIT trap), so the caller never
  # depends on pane output that a later review could clear.
  echo "$status" > "$log.status"
  echo "${DONE_MARK} ${token} exit=${status}"
  exit "$status"
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
# codex itself exits 0 on an unknown revision, so validate it here.
if [[ ${#target[@]} -eq 2 ]] && ! git rev-parse --verify --quiet "${target[1]}^{commit}" >/dev/null; then
  echo "unknown revision: ${target[1]}" >&2; exit 2
fi

args=("${target[@]}")
[[ -n "$title" ]] && args+=(--title "$title")

slug="$(printf '%s' "${title:-${target[*]}}" | tr -cs 'A-Za-z0-9._-' '-' | cut -c1-60)"
log="$REVIEW_DIR/$(date +%Y%m%d-%H%M%S)-$$-${slug}.log"
token="$(date +%s)-$$"

# mkdir is atomic: only one review (and one pane command) at a time. The caller owns the
# lock until the pane command is dispatched; from then on the pane process releases it, so a
# caller-side timeout never frees the lock while a review is still running.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "a codex review is already running (lock: $LOCK_DIR)" >&2; exit 3
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ "${HERDR_ENV:-}" != "1" ]]; then
  status=0
  "$SELF" --inner "$token" "$log" "${args[@]}" || status=$?
  echo "REVIEW_LOG=$log"
  exit "$status"
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

quoted="CODEX_REVIEW_LOCK_HANDOFF=1 $(printf '%q ' "$SELF" --inner "$token" "$log" "${args[@]}")"
herdr pane run "$pane" "$quoted" >/dev/null
trap - EXIT
deadline=$(( $(date +%s) + ${CODEX_REVIEW_TIMEOUT_S:-1800} ))
until [[ -s "$log.status" ]]; do
  if (( $(date +%s) > deadline )); then
    echo "timed out waiting for codex review; it may still be running in pane $pane" >&2; exit 4
  fi
  sleep 2
done
status="$(cat "$log.status")"
echo "REVIEW_LOG=$log"
[[ "$status" == "0" ]] || { echo "codex review failed (exit=${status:-unknown})" >&2; exit "${status:-1}"; }
