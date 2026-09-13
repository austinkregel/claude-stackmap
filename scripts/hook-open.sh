#!/bin/sh
# Wrapper for INFORMATIONAL hooks. Usage: hook-open.sh <script.mjs>
#
# These fail OPEN: a missing node, a missing script, or a parse error must not block a session
# start, a prompt, a tool result, or the end of a turn. Contrast guard.sh, which fails CLOSED
# because it wraps guardrails. Do not mix the two.
#
# Failing open is not the same as failing silently. This wrapper used to `exit 0` on every failure,
# which hid it completely: a hook that cannot start would otherwise at least show a "hook error"
# notice. Every failure now prints a `systemMessage` (shown to the user) and exits 1 (non-blocking).
#
# The script name is checked against [a-z0-9-]+.mjs before it touches a path or the JSON below, so
# it can neither escape scripts/ nor break the message's quoting.
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
