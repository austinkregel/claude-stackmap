#!/bin/sh
# Wrapper for informational hooks. Usage: hook-open.sh <script.mjs>
#
# Fails open, visibly: every failure prints a `systemMessage` and exits 1 (non-blocking), never 0.
# Contrast guard.sh, which wraps guardrails and fails closed. Do not mix the two.
#
# The script name must match [a-z0-9-]+.mjs, so it can neither escape scripts/ nor break the
# message's JSON quoting.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME="${1:-}"

fail() {
  printf '{"systemMessage":"stackmap hook-open: %s"}\n' "$1"
  echo "stackmap hook-open: $1" >&2
  exit 1
}

case "$NAME" in
  "") fail "no hook script named" ;;
  .mjs | *[!a-z0-9-]*.mjs) fail "invalid hook script name (expected [a-z0-9-]+.mjs)" ;;
  *.mjs) ;;
  *) fail "invalid hook script name (expected [a-z0-9-]+.mjs)" ;;
esac

SCRIPT="$ROOT/scripts/$NAME"
[ -f "$SCRIPT" ] || fail "scripts/$NAME is missing, so that hook did not run"
. "$ROOT/scripts/find-node.sh" 2>/dev/null || fail "cannot load node resolution, so $NAME did not run"
NODE=$(find_node) || fail "no usable node binary (need Node 18.17+), so $NAME did not run"
exec "$NODE" "$SCRIPT"
