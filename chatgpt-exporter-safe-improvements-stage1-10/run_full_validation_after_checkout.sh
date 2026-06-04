#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(pwd)}"
cd "$repo_root"

echo "== Environment =="
node --version
corepack --version || true

# The repo declares pnpm@8.14.1 in packageManager. Corepack will use that when available.
corepack enable || true
corepack prepare pnpm@8.14.1 --activate
pnpm --version

echo "== Install =="
pnpm install --frozen-lockfile

echo "== Static contract gates =="
pnpm run test:renderer-gaps
pnpm run test:dom-injection
pnpm run test:screenshot-selector
pnpm run test:storage-fallback

echo "== Project gates =="
pnpm run lint
pnpm run test
pnpm run build
pnpm run check:dist

echo "PASS full dependency-backed validation completed"
