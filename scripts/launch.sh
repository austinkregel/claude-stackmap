#!/bin/sh
# Launch the stackmap MCP server. Fails loudly — a silent exit would look to Claude Code
# like a server that started and returned nothing.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/scripts/find-node.sh"

if ! NODE=$(find_node); then
  echo "stackmap: no usable node binary found. Install Node 18+, or hardcode its path in scripts/find-node.sh." >&2
  exit 1
fi
ENTRY="$ROOT/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  echo "stackmap: $ENTRY is missing. Run 'npm install && npm run build' in $ROOT." >&2
  exit 1
fi
exec "$NODE" "$ENTRY" "$@"
