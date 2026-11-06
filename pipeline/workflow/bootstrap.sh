#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ROOT="${GAODING_RUNTIME_HOME:-$ROOT}"
command -v gd-cli >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
if ! command -v ego-browser >/dev/null && [[ ! -x "$HOME/.local/bin/ego-browser" ]]; then
  echo "ego-browser is required; read the installed ego-browser skill" >&2
  exit 1
fi
mkdir -p "$RUNTIME_ROOT/workflow"
if [[ "$RUNTIME_ROOT" != "$ROOT" ]]; then
 cp "$ROOT/workflow/package.json" "$ROOT/workflow/package-lock.json" "$RUNTIME_ROOT/workflow/"
fi
[[ -x "$RUNTIME_ROOT/.venv/bin/python" ]] || python3 -m venv "$RUNTIME_ROOT/.venv"
"$RUNTIME_ROOT/.venv/bin/python" -m pip install Pillow==11.3.0
npm ci --prefix "$RUNTIME_ROOT/workflow" --ignore-scripts
gd-cli --version
node "$ROOT/fixes/test-reference-wire.mjs"
