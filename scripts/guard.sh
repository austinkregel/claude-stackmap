#!/bin/sh
# PreToolUse guard wrapper.
#
# Hooks fail OPEN by default: a crash, timeout, or bad JSON lets the tool call proceed,
# so a broken guardrail silently permits what it exists to prevent. Exit code 2 is the only
# code that blocks unconditionally, so every internal failure here exits 2 — the guard fails
# CLOSED. A guard that cannot run must not be a guard that waves things through.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)

if ! . "$ROOT/scripts/find-node.sh" 2>/dev/null; then
  echo "stackmap guard: cannot load node resolution — blocking rather than failing open." >&2
  exit 2
fi
if ! NODE=$(find_node); then
  echo "stackmap guard: no usable node binary — blocking rather than failing open. Install Node 18+." >&2
  exit 2
fi
GUARD="$ROOT/scripts/guard.mjs"
if [ ! -f "$GUARD" ]; then
  echo "stackmap guard: $GUARD missing — blocking rather than failing open." >&2
  exit 2
fi
exec "$NODE" "$GUARD"
