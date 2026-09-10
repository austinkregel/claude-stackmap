#!/bin/sh
# Wrapper for INFORMATIONAL hooks (freshness, fetch sanity).
# These fail OPEN by design: a missing node or a parse error must not block a session or a
# tool result. Contrast scripts/guard.sh, which fails CLOSED because it is a guardrail.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/scripts/${1:-}"
[ -f "$SCRIPT" ] || exit 0
. "$ROOT/scripts/find-node.sh" 2>/dev/null || exit 0
NODE=$(find_node) || exit 0
exec "$NODE" "$SCRIPT"
