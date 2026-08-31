#!/usr/bin/env bash
set -euo pipefail

if rg -n "react-data-grid|src-legacy" src; then
  echo "New src/ code must not depend on react-data-grid or src-legacy/." >&2
  exit 1
fi
