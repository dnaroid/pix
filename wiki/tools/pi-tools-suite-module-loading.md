---
kind: spec
status: active
---

# Fault-tolerant pi-tools-suite module loading

## Behavior

Enabled modules load sequentially in catalog order; disabled and incompatible
host-only modules are not imported. An import error (including invalid TypeScript),
missing factory or rejected factory skips that module and continues with the next.
The startup log identifies each skipped module and its error. A session-start
warning lists skipped modules; successfully loaded capabilities remain available.

Each factory receives a module-scoped API. Registrations and event-bus
subscriptions/emissions are staged until the factory succeeds. A rejected factory
does not leave tools, commands, providers or handlers registered. Its retained API
rejects later calls. Successful modules retain normal dynamic registration and
unsubscribe behavior after initialization.

## Constraints and failure cases

- This is error containment, not a sandbox, protocol validation or a guarantee
  that an unfinished feature is correct. It does not undo arbitrary factory
  side effects, stop hung imports/factories, prevent process termination or catch
  errors in later handlers. Factories must own resource cleanup and defer lasting
  side effects to lifecycle handlers.
- The public SDK cannot roll back a partially applied registration batch. If the
  SDK rejects a commit, the suite factory fails and SDK extension isolation skips
  the whole suite rather than retaining a partially registered suite. Other
  extensions and the host remain available. Configuration and suite-entrypoint
  errors likewise remain whole-extension failures.
- Registration staging covers SDK `on`, `register*`, `unregister*` and event-bus
  `on`/`emit`. Reads during initialization observe already committed registrations,
  not the pending batch. New SDK registration APIs need a compatibility review.
- A skipped module may remove capabilities required by another module; loading
  protection does not repair those dependencies. Retry requires reload/restart
  after fixing the cause, not an automatic retry loop.

## Compiled runtime

The suite entrypoint validates `build/runtime/manifest.json` before each factory
load/reload. The manifest fingerprints the runtime's source inputs and lists its
outputs; missing, stale or invalid metadata falls back to importing TypeScript
source and emits a warning. The shared esbuild ESM runtime is emitted as `.mts`
chunks and imported through the SDK's Jiti loader, preserving SDK aliases,
module isolation and shared singletons. Bundled `import.meta.url` references are
rewritten to resolve assets and workers relative to their original source files.
Content-hashed outputs are retained so in-flight lazy imports remain valid.
Builds reject changed source snapshots and publish immutable chunks before
atomically replacing the manifest; existing hashed chunks are never truncated.
Build with `npm run build:tools-suite`; normal source-to-live sync rebuilds
before mirroring, while `--check` is read-only.
Release preparation prunes obsolete hashed outputs and crash-temporary files
only in the extracted staging payload, retaining the manifest's listed outputs
and manifest itself. It rejects an invalid manifest; live development runtime
generations are not pruned.

Decision: [0012 — Isolate suite module loading](../decisions/0012-isolate-suite-module-loading.md).

## Implementation

- `scripts/build-pi-tools-suite.mjs`
- `scripts/release/prune.mjs` (staged release payload cleanup)
- `external/pi-tools-suite/index.ts`
- `external/pi-tools-suite/runtime-loader.mjs`
- `external/pi-tools-suite/src/index.ts`
- `external/pi-tools-suite/src/module-loader.ts`

## Tests

- `tests/pi-tools-suite-runtime.test.ts` (SDK identity, reload, source fallback,
  packaging, staged runtime pruning and invalid manifests)
- `external/pi-tools-suite/test/module-loader.test.ts`

## Verification

Run suite typecheck and `bun test test/module-loader.test.ts`. Deterministic tests
exercise a real parsing failure, rejected asynchronous factories, discarded
registrations and bus events, stale APIs, unsubscribe, dynamic registration and
SDK whole-extension isolation. These tests do not certify brainstorm skill
behavior or replace real UI startup verification.

From the repository root, run `node --import tsx --test
tests/pi-tools-suite-runtime.test.ts` for compiled-runtime and release-staging
regressions.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"cd341ab03d5fc8c0cb0ec0095de99bf572e60bdfeddf8fe6a5f747aeb62e323e","checkedAt":"2026-10-30T23:09:14.526Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":67,"reportLanguage":"ru"} -->
