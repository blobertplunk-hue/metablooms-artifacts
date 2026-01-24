# MetaBlooms System Indexer

This folder contains a deterministic index builder that produces `SYSTEM_INDEX.json`.

Why this exists:
- MetaBlooms work often involves scanning many artifacts and nested bundles.
- Re-scanning repeatedly is slow and increases the chance of "I didn't see it" errors.
- `SYSTEM_INDEX.json` is the fast lookup map: entrypoints, registries, doctrine docs, modules, and file hashes.

Operational policy:
- Index building is **build-time / maintenance-time**, not runtime.
- Your boot remains fail-closed and minimal; indexing does not change execution order.
