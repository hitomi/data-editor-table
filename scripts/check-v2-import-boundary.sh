#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)

node "$repo_root/scripts/check-controller-boundaries.mjs" --self-test

if ! node "$repo_root/scripts/assert-text-absent.mjs" "react-data-grid" "$repo_root/src"; then
  echo "Native src/ code must not depend on react-data-grid." >&2
  exit 1
fi
