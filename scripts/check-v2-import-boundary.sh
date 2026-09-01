#!/usr/bin/env bash
set -euo pipefail

if rg -n "react-data-grid" src; then
  echo "Native src/ code must not depend on react-data-grid." >&2
  exit 1
fi
