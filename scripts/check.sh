#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
./workflow.sh doctor
"$ROOT/pipeline/.venv/bin/python" -m unittest discover -s pipeline/workflow -p 'test_*.py'
node pipeline/workflow/test-layer-audit.cjs
node pipeline/workflow/test-copyright.cjs
node --test pipeline/workflow/test-browser-sequence.cjs pipeline/workflow/test-publish-resume.cjs pipeline/workflow/test-copyright-evidence.cjs pipeline/workflow/test-dam-browser.cjs pipeline/workflow/test-form-policy.cjs pipeline/workflow/test-non-original.cjs pipeline/workflow/test-gaoding-policy.cjs dsh-plugin-gaoding-publisher/test-plugin.mjs dsh-plugin-gaoding-publisher/test-catalog.mjs dsh-plugin-gaoding-publisher/test-spec-catalog.mjs dsh-plugin-gaoding-publisher/test-jobs-store.mjs dsh-plugin-gaoding-publisher/test-publish-check.mjs dsh-plugin-gaoding-publisher/test-prompt-writer.mjs dsh-plugin-gaoding-publisher/test-creator.mjs dsh-plugin-gaoding-publisher/test-published.mjs dsh-plugin-gaoding-publisher/test-template-recipe.mjs dsh-plugin-gaoding-publisher/test-template-publish.mjs dsh-plugin-gaoding-publisher/test-publication-safety.mjs dsh-plugin-gaoding-publisher/test-editor-import.mjs dsh-plugin-gaoding-publisher/test-browser-space.mjs dsh-plugin-gaoding-publisher/test-publish-queue.mjs dsh-plugin-gaoding-publisher/test-image-client.mjs dsh-plugin-gaoding-publisher/test-preflight.mjs dsh-plugin-gaoding-publisher/test-usage-doc.mjs dsh-plugin-gaoding-publisher/test-auto-publish.mjs
node --check dsh-plugin-gaoding-publisher/client.js
node scripts/prepare-plugin.mjs
