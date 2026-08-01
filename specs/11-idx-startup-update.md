# Spec: Keep idx current at Pix startup

## Type

Change

## Goal

When `indexer-cli` is installed and available on `PATH`, check its version whenever Pix starts and update it when a newer release is available.

## Scope

- Run the official `idx update` flow in the background after the TUI starts.
- Do nothing when `idx` is not installed or is unavailable on `PATH`.
- Notify the user when idx was updated or when the startup update failed.
- Respect the existing offline and version-check opt-out environment variables.

## Non-goals

- Initialize or rebuild a project's `.indexer-cli` index.
- Install idx when it is absent; `/idx-init` remains the explicit installation path.
- Block TUI startup while npm or idx is unavailable.

## Behavior

1. Pix launches `idx update`, which checks the installed version against npm and mutates the global install only when needed.
2. An up-to-date result is silent.
3. A successful update produces a success toast with the old and new versions when idx reports them.
4. A missing executable is silently skipped; a failed update of an installed executable produces a warning toast.
5. `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, and `PIX_SKIP_VERSION_CHECK` skip the idx check.
6. The child process is bounded by a ten-minute timeout and its captured output is bounded in memory.

## Related files

- `src/app/cli/startup-checks.ts`
- `src/app/app.ts`
- `tests/startup-checks.test.ts`

## Verification

- Unit tests cover current, updated, skipped, missing, and failed outcomes.
- `npm run check`

## Risks / unknowns

- `idx update` owns package-manager selection and global-install migration behavior; Pix intentionally does not duplicate it.
- A completed update applies to subsequent idx processes; an idx command already running during the update is unaffected.

## Evidence

- Confirmed by idx CLI help: `idx update` checks npm and updates the global `indexer-cli` install.
- Confirmed by Pix code: existing Pix and Pi update checks already run asynchronously after TUI startup.
