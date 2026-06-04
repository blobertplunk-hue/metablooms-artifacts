#!/usr/bin/env bash
set -euo pipefail
repo_root="${1:-$(pwd)}"
carrier_base="https://raw.githubusercontent.com/blobertplunk-hue/metablooms-artifacts/chatgpt-exporter-safe-improvements-stage1-10/chatgpt-exporter-safe-improvements-stage1-10"
cd "$repo_root"

if [ ! -f package.json ]; then
  echo "ERROR: package.json not found. Run this from a chatgpt-exporter checkout or pass its path." >&2
  exit 2
fi

if ! grep -q '"name": "@pionxzh/chatgpt-exporter"' package.json; then
  echo "ERROR: this does not look like @pionxzh/chatgpt-exporter." >&2
  exit 2
fi

workdir=".metablooms-chatgpt-exporter-stage1-10"
mkdir -p "$workdir"

curl -fsSL "$carrier_base/CUMULATIVE_DELTA_FROM_ORIGINAL.patch.gz.b64" -o "$workdir/CUMULATIVE_DELTA_FROM_ORIGINAL.patch.gz.b64"
base64 -d "$workdir/CUMULATIVE_DELTA_FROM_ORIGINAL.patch.gz.b64" | gzip -d > "$workdir/CUMULATIVE_DELTA_FROM_ORIGINAL.patch"

git checkout -b chatgpt/safe-improvements-stage1-10 2>/dev/null || git checkout chatgpt/safe-improvements-stage1-10

git apply --check "$workdir/CUMULATIVE_DELTA_FROM_ORIGINAL.patch"
git apply "$workdir/CUMULATIVE_DELTA_FROM_ORIGINAL.patch"

curl -fsSL "$carrier_base/run_full_validation_after_checkout.sh" -o "$workdir/run_full_validation_after_checkout.sh"
chmod +x "$workdir/run_full_validation_after_checkout.sh"

echo "Patch applied. Run validation with:"
echo "bash $workdir/run_full_validation_after_checkout.sh ."
