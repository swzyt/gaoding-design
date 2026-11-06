#!/usr/bin/env bash
set -euo pipefail
WORKFLOW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_ROOT="$WORKFLOW_ROOT/pipeline"
RUNTIME_ROOT="${GAODING_RUNTIME_HOME:-$PIPELINE_ROOT}"
export NODE_PATH="${NODE_PATH:-$RUNTIME_ROOT/workflow/node_modules}"
if [[ "${1:-}" == bootstrap ]]; then
 exec bash "$PIPELINE_ROOT/workflow/bootstrap.sh"
fi
if [[ ! -x "$RUNTIME_ROOT/.venv/bin/python" ]]; then
 echo "Dependencies missing. Run this workflow.sh with bootstrap (same GAODING_RUNTIME_HOME)." >&2
 exit 1
fi
exec "$RUNTIME_ROOT/.venv/bin/python" "$PIPELINE_ROOT/workflow/run.py" "$@"
