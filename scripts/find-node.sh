# Shared node resolution for the POSIX launchers, sourced by bin/sm, scripts/launch, scripts/guard, and
# scripts/hook-open. scripts/find-node.cmd does the same for their Windows twins.
# PATH may be minimal, and a version-manager shim fails when its manager is off PATH, so every
# candidate is verified by running it, and real installs are tried before shims.
#
# The minimum is Node 22.13, where `node:sqlite` stopped needing --experimental-sqlite (nodejs.org/api/
# sqlite.html: "v23.4.0, v22.13.0 — SQLite is no longer behind --experimental-sqlite"). It must equal
# `engines.node` in package.json and MIN_MAJOR/MIN_MINOR in find-node.cmd; plugin-test checks all three.
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13

# A node that runs and is new enough. An older one is not usable: there is no fallback path.
usable() {
  [ -n "${1:-}" ] && [ -x "$1" ] || return 1
  version=$("$1" --version 2>/dev/null) || return 1
  case "$version" in
    v*) version=${version#v} ;;
    *) return 1 ;;
  esac
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  case "$major:$minor" in
    *[!0-9:]* | :* | *:) return 1 ;;
  esac
  [ "$major" -gt "$NODE_MIN_MAJOR" ] && return 0
  [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]
}

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
