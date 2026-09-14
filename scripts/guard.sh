#!/bin/sh
# Wrapper for guardrail hooks. Usage: guard.sh <script.mjs>
#
# Fails closed: every internal failure exits 2, the only code that blocks unconditionally.
# Contrast hook-open.sh, which wraps informational hooks and fails open.
#
# The script name must match [a-z0-9-]+.mjs, so it cannot reach a file outside scripts/.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME="${1:-}"

block() {
  echo "stackmap guard: $1 — blocking rather than failing open." >&2
  exit 2
}

case "$NAME" in
  "") block "no hook script named" ;;
  .mjs | *[!a-z0-9-]*.mjs) block "invalid hook script name (expected [a-z0-9-]+.mjs)" ;;
  *.mjs) ;;
  *) block "invalid hook script name (expected [a-z0-9-]+.mjs)" ;;
esac

SCRIPT="$ROOT/scripts/$NAME"
[ -f "$SCRIPT" ] || block "$SCRIPT missing"
. "$ROOT/scripts/find-node.sh" 2>/dev/null || block "cannot load node resolution"
NODE=$(find_node) || block "no usable node binary; install Node 18.17+"
exec "$NODE" "$SCRIPT"
