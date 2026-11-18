#!/usr/bin/env bash
set -euo pipefail
LEGACY_CLI=false
for arg in "$@"; do
  case "$arg" in
    --legacy-cli) LEGACY_CLI=true ;;
    *) echo "Unknown bootstrap argument: $arg. Usage: bootstrap [--legacy-cli]" >&2; exit 2 ;;
  esac
done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ROOT="${GAODING_RUNTIME_HOME:-$ROOT}"
require_command() {
  if ! command -v "$1" >/dev/null; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}
require_command node
require_command npm
if [[ "$LEGACY_CLI" == true ]]; then
  require_command gd-cli
fi
if ! command -v ego-browser >/dev/null && [[ ! -x "$HOME/.local/bin/ego-browser" ]]; then
  echo "ego-browser is required; read the installed ego-browser skill" >&2
  exit 1
fi
mkdir -p "$RUNTIME_ROOT/workflow"
if [[ "$RUNTIME_ROOT" != "$ROOT" ]]; then
 cp "$ROOT/workflow/package.json" "$ROOT/workflow/package-lock.json" "$RUNTIME_ROOT/workflow/"
fi
if [[ ! -x "$RUNTIME_ROOT/.venv/bin/python" ]]; then
  require_command python3
  python3 -m venv "$RUNTIME_ROOT/.venv"
fi
"$RUNTIME_ROOT/.venv/bin/python" -m pip install Pillow==11.3.0
npm ci --prefix "$RUNTIME_ROOT/workflow" --ignore-scripts
if [[ "$LEGACY_CLI" == true ]]; then
  gd-cli --version
  node "$ROOT/fixes/test-reference-wire.mjs"
fi
