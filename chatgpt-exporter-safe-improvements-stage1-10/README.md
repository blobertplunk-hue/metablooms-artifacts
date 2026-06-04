# ChatGPT Exporter safe improvements Stage 1-10

This is a GitHub carrier for the patched ChatGPT Exporter work produced in ChatGPT/MetaBlooms.

## Canonical upstream repo

`pionxzh/chatgpt-exporter`

Upstream permissions observed through the connector:

- `pull: true`
- `push: false`
- default branch: `master`
- upstream head probed: `e579f4f6766f5eb6bad4bad858ffc13e1c683fff`

Because the connector has no push permission to upstream and no installed writable fork was found, this carrier is published in `blobertplunk-hue/metablooms-artifacts` so a local checkout can update using the patch/artifact workflow.

## Authoritative patch bundle

Local sandbox artifact:

- `/mnt/data/chatgpt_exporter_safe_improvements_stage1_10_20260604T1832Z.zip`
- SHA-256: `1256185b97c725fea4f115f7617d9c2f1653b4c9607e4caeb077223c2b3fc7d7`
- ZIP members: 116

Original uploaded source ZIP:

- `/mnt/data/chatgpt-exporter-master (2).zip`
- SHA-256: `678e5922f3fa4fd96832fbaaeb6a6982e315ac47a8c0e49f6b353f39e0a72924`

## What changed

The patch series includes:

1. CI supply-chain hardening
2. dist parity gate
3. safer API diagnostics
4. export truncation visibility
5. renderer-gap contract gate
6. `tether_browsing_code` export preservation
7. MutationObserver DOM injection hardening
8. screenshot selector fallback hardening
9. storage fallback hardening
10. release qualification bundle and validation script

## Local update path

From a local checkout of `pionxzh/chatgpt-exporter`:

```bash
# save/apply the cumulative patch from this carrier when available
git checkout -b chatgpt/safe-improvements-stage1-10
git apply CUMULATIVE_DELTA_FROM_ORIGINAL.patch
bash run_full_validation_after_checkout.sh .
```

If the patch file is not present in this carrier because the GitHub connector blocked large payload replay, download the authoritative ZIP from the ChatGPT artifact and use its `CUMULATIVE_DELTA_FROM_ORIGINAL.patch` plus `run_full_validation_after_checkout.sh`.

## Validation status from sandbox

Static validation: PASS.

Dependency-backed validation was not run in the sandbox because pnpm/node_modules/registry resolution were unavailable. Run the included validation script in a network-enabled checkout.
