# 05 — lsp trust & command execution (as-is spec)

> Risk class: **security**. Gates execution of LSP server binaries declared in
> project-local config behind a trust decision, while allowing unrestricted
> execution from global (user-owned) config.
>
> _Investigated by a read-only sub-agent; re-verify against current code. Line
> numbers are approximate._

## Purpose
Gate execution of LSP server binaries declared in project-local config behind a
trust decision; global config servers run with no gate. `[confirmed by code]`

## Current behavior

### Config loading (two layers)
1. **Global configs (no trust gate)**, in order: `$HOME/.config/pi/pi-tools-suite.jsonc`, then `$PI_CONFIG_DIR/pi-tools-suite.jsonc` if `PI_CONFIG_DIR` is set. `[confirmed by code: config.ts 147-151; config.ts 44-46 getPiToolsSuiteUserConfigPath]`
2. **Project config (trust-gated)**: `$CWD/.pi/pi-tools-suite.jsonc` found via `findUp` (walks ancestors of `ctx.cwd` up to `/`). `[confirmed by code: config.ts 31; paths.ts findUp]`
3. Items merged by `id`; project layer can override or disable (`enabled:false`) global servers. `[confirmed by code: config.ts 112-121]`

### Trust gate (project layer only)
- Only the **project** layer is trust-gated, checked **after** the file is parsed but **before** its items are merged. `[confirmed by code: config.ts 156-168]`
- The **entire raw file text** is hashed with SHA-256 (`sha256(raw)`). Hash covers the full file (comments, formatting, non-LSP keys all count). `[confirmed by code: config.ts 106-108]`
- Decision outcomes: **Trust once** (in-process session memory only), **Trust always** (persisted to disk), **Reject**. `[confirmed by code: trust.ts 79-91]`
- **Non-interactive mode** (`!ctx.hasUI`): project config is **silently rejected** — no prompt, no execution (a warning string is added). `[confirmed by code: trust.ts 65-67]`

### Command resolution & execution
- Each `LspServerConfig` `bin`/`args`/`cwd`/`env` is resolved via template substitution (`{root}`, `{file}`, `{relFile}`, …) and path expansion (`~` → `$HOME`, relative → absolute). `[confirmed by code: paths.ts resolveCommand, createPathPlaceholders]`
- `bin`: absolute → as-is; contains `/` → relative to `root`; otherwise `$PATH` lookup. **No validation** that the binary is within the project or a safe location. `[confirmed by code: paths.ts resolveExecutable, resolveWorkingDirectory]`
- Spawned via `child_process.spawn` with `shell:false`, `detached:true` (POSIX), `stdio:pipe`. `env` from config is **merged into** `process.env` (`{...process.env, ...command.env}`). `[confirmed by code: client.ts 88-93]`
- Execution is lazy, on first `ensureStarted()` (triggered by `openOrChange` / `ensureDocumentForTool`). `[confirmed by code: client.ts 45-52]`

### Entry point
- `LspManager.matchingServers` → `loadLspConfig` → spawns as needed; called from `appendLspDiagnosticsToMutationResult` on `tool_result` for mutation tools (`apply_patch`, `ast_apply`, `Write`, `Edit`). `[confirmed by code: manager.ts 73; lib/lsp.ts 30-48]`

## Public contracts / inputs / outputs

### Config locations & format
- Global: `$HOME/.config/pi/pi-tools-suite.jsonc` (JSONC, `lsp.servers[]`); alt `$PI_CONFIG_DIR/pi-tools-suite.jsonc`; project: `<ancestor-of-cwd>/.pi/pi-tools-suite.jsonc` (via `findUp`). `[confirmed by code]`
- Schema `{ lsp: { servers: LspServerConfig[] } }`; `LspServerConfig` fields: `id`, `enabled`, `bin`, `args`, `cwd`, `env`, `config`, `include`, `exclude`, `rootMarkers`, `languageIdByExtension`, `startupTimeoutMs`, `diagnosticsWaitMs`, `pullDiagnostics`, `waitForPublishDiagnostics`, `initializationOptions`, `settings`, `maxFileSizeBytes`. `[confirmed by code: types.ts 27-44]`

### Trust store
- Path `$PI_AGENT_DIR/trust/lsp.json` (default `$HOME/.pi/agent/trust/lsp.json`). `[confirmed by code: trust.ts 21-24]`
- Format `{ "version": 1, "trustedHashes": string[] }`; hashes are SHA-256 hex of the full raw JSONC text. `[confirmed by code]`
- `writeTrustStore` uses `fs.writeFile` **without** an explicit `mode` (defaults to umask). `[confirmed by code]`

### What is hashed
- The entire file content (`raw`), not individual entries, not a canonical form. `[confirmed by code: config.ts 107]`

## Invariants
- Global config servers are **never** trust-gated. `[confirmed by code]`
- Trust is checked **once per file load**, not per server within the file. `[confirmed by code]`
- Session-trusted hashes (Trust once) live in a module-level in-process `Set` and reset on restart. `[confirmed by code: trust.ts 15]`
- Persisted trusts survive across sessions. `[confirmed by code]`
- Rejected hashes are **not** cached/persisted — rejection re-prompts every time. `[confirmed by code; confirmed by tests]`

## Edge cases
- **ENOENT on trust store**: empty store (first run). `[confirmed by code: trust.ts 34-37]`
- **Malformed trust store JSON**: thrown (not gracefully handled beyond ENOENT). `[confirmed by code: trust.ts 34-39]`
- **Empty `bin` with `enabled:false`**: server skipped during parse. `[confirmed by code: config.ts 74-76]`
- **Invalid JSONC**: caught, added to warnings; layer not loaded. `[confirmed by code: config.ts 164-168]`
- **`findUp` traverses above cwd**: project config may be in any ancestor of `ctx.cwd`. `[confirmed by code]`
- **No project config**: no trust gate; only global servers used. `[confirmed by code]`

## Side effects
- **Child processes spawned** by `LspClient.start()` (`detached:true`, `shell:false`); killed via SIGTERM→SIGKILL with process-group kill (`-child.pid`) on shutdown. `[confirmed by code: client.ts 88-93; child-process.ts 27-45]`
- **Trust file written** only on "Trust always" (`mkdir -p` parents). `[confirmed by code: trust.ts 88-90]`
- **Commands executed** per config (full command line, cwd, env overlay). `[confirmed by code]`
- **LSP server handlers** respond to `workspace/executeCommand`, `textDocument/diagnostic`, `workspace/configuration`, `client/registerCapability`, and `markdown/*` (parse, fs/readFile, fs/stat, fs/readDirectory). `[confirmed by code: client.ts registerHandlers]`
- **Network**: none initiated by trust/config itself; LSP servers may use network. `[inferred]`

## Related files
`external/pi-tools-suite/src/lsp/_shared/{trust,config,paths,runner,template,types,output,glob}.ts`, `.../lsp/{client,manager,child-process,index,types,tsserver,...}.ts`, `.../src/lib/lsp.ts`, `.../src/config.ts`, `.../test/lsp.test.ts`.

## Existing tests
- `lsp.test.ts` `[confirmed by tests]`:
  - "caches Trust once decisions for the current session" — `sessionTrustedHashes` prevents re-prompt.
  - "persists Trust always decisions and does not cache rejects" — file persistence; rejects re-prompt every time.
  - "loads LSP servers from shared pi-tools-suite config" — global config read from `$HOME/.config/pi/pi-tools-suite.jsonc` (not `$PI_AGENT_DIR/lsp.json`).
  - Execution tests with a real fake LSP server script in temp, configured via **global** config: diagnostics, re-use, crash backoff, multi-root, tsserver/pull/dynamic diagnostics, stubborn-process kill, abort.
  - **No test exercises the project-config trust gate with a real `.pi/pi-tools-suite.jsonc`** — all tests use `writeGlobalLspConfig`. `[confirmed by tests]`

## Gaps / risks
### Arbitrary command execution
- **Global config has no trust gate**: any binary can be configured in `~/.config/pi/pi-tools-suite.jsonc` and executed without consent; `bin` may be an absolute path and `env`/`cwd` are fully controllable. Risk is bounded by "attacker can write to the user's own home config" (or social engineering the user to add a server). `[confirmed by code]`

### Trust hash coverage
- Any change to the project file (incl. formatting/comments) **does** change the hash and re-trigger the prompt (so adding a new entry is caught). `[confirmed by code: sha256(raw)]`
- **No per-server granularity**: trusting a file trusts **all** servers in it; cannot trust 9-of-10. `[confirmed by code]`

### Path traversal
- `bin` may be an absolute path anywhere (`/tmp/evil`); `cwd` may be absolute; `env` values used verbatim; `config` path may point outside the project. `[confirmed by code]`
- Template placeholders (`{file}`, `{root}`) substituted with resolved paths — could exfiltrate path info. `[confirmed by code]`

### `findUp` scope
- A config at `/tmp/.pi/pi-tools-suite.jsonc` is found when `ctx.cwd=/tmp/...`; no check that the project config is within a trusted directory (e.g. `$HOME`/known workspace). `[confirmed by code]`

### Trust bypass
- `$PI_AGENT_DIR/trust/lsp.json` is a plain JSON file with no signature/HMAC — writable attackers can pre-seed trusted hashes. `[confirmed by code]`
- Changing `$PI_AGENT_DIR` via env moves the trust store. `[confirmed by code]`
- Module-level `sessionTrustedHashes` is shared across all `loadLspConfig` calls in one process. `[confirmed by code]`

### Non-interactive silent rejection
- Headless mode rejects project config with only a warning; the LLM gets no explanation of how to trust. `[confirmed by code]`

### Detached processes
- `detached:true` on POSIX → orphaned processes possible if the parent crashes without cleanup (exit/signal handlers mitigate normal termination only). `[confirmed by code]`

### `markdown/*` LSP requests
- The client serves `markdown/fs/readFile|stat|readDirectory` from the server via `uriToFilePath` with **no path sandboxing** — an LSP server can read arbitrary files. `[confirmed by code]`

## Suggested verification
1. Confirm no test exercises the project-local trust gate with a real project config file (only mocked `askProjectConfigTrust`). `[confirmed by tests]`
2. Add a test that `resolveExecutable` accepts absolute paths outside the project without restriction. `[confirmed by code]`
3. Add a test that `markdown/fs/*` handlers have no path sandboxing. `[confirmed by code]`
4. Determine whether `$PI_CONFIG_DIR` is attacker-controllable in the host (could redirect global config). `[unknown — depends on pi host]`
5. Add a test confirming `writeTrustStore` file mode (currently umask). `[confirmed by code]`
6. Add a scenario: project config at `/tmp/.pi/pi-tools-suite.jsonc` with `ctx.cwd=/tmp/project` → confirm it is found and trust is prompted. `[not tested — gap]`
