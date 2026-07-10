#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

tsc \
  --noEmit \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --skipLibCheck \
  $(find src/async-subagents -name '*.ts' -print)
