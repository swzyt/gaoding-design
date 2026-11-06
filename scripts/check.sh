#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
./workflow.sh doctor
"$ROOT/pipeline/.venv/bin/python" -m unittest discover -s pipeline/workflow -p 'test_*.py'
node pipeline/workflow/test-layer-audit.cjs
node pipeline/workflow/test-copyright.cjs
node --test pipeline/workflow/test-publish-resume.cjs dsh-plugin-gaoding-publisher/test-plugin.mjs
node --check dsh-plugin-gaoding-publisher/client.js
node scripts/prepare-plugin.mjs
