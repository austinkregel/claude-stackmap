#!/bin/sh
# Wrapper for GUARDRAIL hooks. Usage: guard.sh <script.mjs>
#
# Hooks fail OPEN by default: a crash, a timeout, or a script that cannot start lets the tool call
# proceed, so a broken guardrail silently permits what it exists to prevent. Exit code 2 is the only
# code that blocks unconditionally, so every internal failure here exits 2 — this wrapper fails
# CLOSED. A guard that cannot run must not be a guard that waves things through.
#
# Contrast hook-open.sh, which fails open (visibly) because it wraps informational hooks.
#
# The script name is checked against [a-z0-9-]+.mjs before it touches a path, so an argument like
# ../../elsewhere.mjs cannot run a file outside scripts/.
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
