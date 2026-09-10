# Shared node resolution, sourced by launch.sh and guard.sh.
# VS Code launched from the Dock inherits a minimal PATH without version-manager shims,
# and a shim is itself a script that fails to exec when its manager is off PATH — so every
# candidate is verified by actually running it.
usable() { [ -n "${1:-}" ] && [ -x "$1" ] && "$1" --version >/dev/null 2>&1; }

find_node() {
  if command -v node >/dev/null 2>&1; then
    candidate=$(command -v node)
    usable "$candidate" && { printf '%s\n' "$candidate"; return 0; }
  fi
  for glob in \
    "$HOME"/.asdf/installs/nodejs/*/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/mise/installs/node/*/bin/node
  do
    for candidate in $(ls -1d $glob 2>/dev/null | sort -Vr); do
      usable "$candidate" && { printf '%s\n' "$candidate"; return 0; }
    done
  done
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    usable "$candidate" && { printf '%s\n' "$candidate"; return 0; }
  done
  for candidate in "$HOME/.asdf/shims/node" "$HOME/.local/share/mise/shims/node"; do
    usable "$candidate" && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
