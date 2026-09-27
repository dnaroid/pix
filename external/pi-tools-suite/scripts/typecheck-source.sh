#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Explicit file lists require --ignoreConfig under TypeScript 6 (TS5112).
tsc \
  --ignoreConfig \
  --noEmit \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --skipLibCheck \
  $(find src/async-subagents -name '*.ts' -print)
