#!/usr/bin/env bash
# spec -> PSD（依赖 ag-psd；NODE_PATH 指向安装目录）
set -e
SPEC="$1"; OUT="${2:-${SPEC%.json}.psd}"
NODE_PATH="${NODE_PATH:-$(cd "$(dirname "$0")" && pwd)/workflow/node_modules}" node "$(dirname "$0")/../tooling/spec_to_psd.js" "$SPEC" "$OUT"
echo "psd: $OUT"
