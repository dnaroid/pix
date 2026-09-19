# Desktop first-run bootstrap

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make a packaged Pix Desktop usable on a clean computer without requiring a system Node.js/npm/Pi install, while offering explicit, non-destructive migration of compatible provider credentials and an optional IDX install.

## Runtime boundary

- A release Desktop already contains the pinned Node runtime, Pi coding agent, ACP backend, Pix extensions, and pi-tools-suite source/skills needed by sessions. Desktop passes the bundled pi-tools-suite extension explicitly to both ACP draft model discovery and materialized Pi sessions when no agent-installed copy exists, so providers such as Antigravity do not depend on a prior global tools-suite install. If an agent-installed copy exists, Desktop respects that discovered extension and does not load the packaged suite a second time. First-run verifies that packaged boundary; it does not install Pi or the tools suite globally.
- The release payload also contains bootstrap.mjs plus npm from the same checksum-verified official Node archive as the bundled Node executable. npm is an implementation detail for explicit managed-tool installation and is not added to the user's system PATH.
- Development builds resolve the same bootstrap helper from the checkout and keep their existing source/runtime overrides.
- Missing packaged runtime/bootstrap files fail with the existing reinstall diagnostic rather than falling back to build-machine files or silently installing global prerequisites.

## First-run behavior

- Desktop shows the bootstrap dialog until the user presses **Continue**. Completion is stored in the Desktop webview profile as pix.desktop.bootstrap.v1.completed; normal launches after completion do not reopen it automatically.
- The dialog reports bundled Pi/tools-suite readiness, the Pi agent directory and configured provider IDs, compatible OpenCode credential presence, Codex file-auth presence, and IDX availability. Inspection returns metadata only and never returns credential/token values.
- Import/install actions are independent and optional. A failure stays in the dialog and does not mark setup complete.
- A successful credential import reconnects Desktop ACP so newly available auth can be observed by a fresh runtime.

## Credential migration

- **OpenCode:** first-run calls the tools suite's existing importOpencodeAccounts() implementation. Its provider mapping, Antigravity support, validation, secure writes, and non-overwrite behavior remain the single source of truth. Existing Pi credentials are preserved unless the source is already identical; first-run never passes overwrite=true.
- **Codex API key:** when CODEX_HOME/auth.json (default ~/.codex/auth.json) contains a static OPENAI_API_KEY, first-run may copy it to Pi's openai credential only when Pi has no credential for that provider. Identical or existing Pi auth is preserved.
- **Codex ChatGPT OAuth:** first-run may detect file-backed OAuth metadata but does not copy access/refresh tokens into Pi. Codex and Pi can refresh/rotate OAuth credentials independently, so duplicating the token record would create two mutable auth stores. Pi must authenticate that provider through its own supported auth flow until a shared-source bridge exists.
- Bootstrap responses and UI messages may contain paths, provider IDs, import statuses, and versions, but never API keys, access tokens, or refresh tokens.

## Optional managed IDX

- IDX installation is user-triggered. First-run never initializes a project's .indexer-cli state; project initialization remains an explicit workspace action.
- If idx is already resolvable from the Desktop/login-shell environment, Desktop keeps using that system installation and does not install a managed copy.
- Otherwise **Install** runs the bundled Node plus bundled npm to install indexer-cli@latest under ~/.pi/pix-desktop-tools. It does not use npm install -g, administrator privileges, or a system npm.
- ACP/Pi child PATH includes the managed package bin directory. Native Desktop IDX commands resolve system idx first, then the managed indexer-cli package entry.
- Native Desktop launches a managed IDX JavaScript entry with Pix's bundled Node rather than its env-node wrapper. Native addons installed by npm therefore use the same Node ABI that executes IDX.
- Managed-package metadata is treated as untrusted input: Desktop rejects absolute or parent-traversing bin.idx paths.

## Related files

- scripts/release/bootstrap.mjs
- scripts/release/node-runtime.mjs
- scripts/release/prepare.mjs
- desktop/src-tauri/src/backend_runtime.rs
- desktop/src-tauri/src/desktop_bootstrap.rs
- desktop/src-tauri/src/lib.rs
- desktop/src/lib/desktop-bootstrap.ts
- desktop/src/components/DesktopBootstrapDialog.svelte
- desktop/src/App.svelte
- external/pi-tools-suite/src/opencode-import/importer.ts

## Verification

- Release bootstrap tests use isolated HOME/agent/OpenCode/Codex directories, verify OAuth secrets are absent from bootstrap output, exercise Codex API-key import, and exercise the real tools-suite OpenCode importer with non-overwrite assertions.
- Rust tests verify managed IDX entry resolution/path confinement plus bundled/development runtime resolution.
- Desktop typecheck and Vitest cover the surrounding frontend contracts; the full Desktop Rust suite remains the native gate.
- Release packaging/smoke must continue to validate actual native artifacts on each supported target because bundled npm/native IDX dependencies are target-specific.
