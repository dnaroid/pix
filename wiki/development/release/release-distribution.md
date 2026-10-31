---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T02:03:14.629Z","result":{"path":"wiki/development/release/release-distribution.md","documentHash":"f3be7f44a9ce52b444c06cc07903a20114b1764eed8f79f7e494b89290d9e8b6","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/development/release/guide.md","quote":"\n```bash\ngh secret set TAURI_SIGNING_PRIVATE_KEY \u003c \"$HOME/.config/pix/release-signing/pix-updater.key\"\n```\n\nDo not rotate again merely because CI has not yet been updated; it would strand\nclients that trust this newly committed public key.\n\n### Package contents and size checks\n\nThe TUI archive includes Pix and its Node runtime, **not ACP**. The Desktop\nruntime additionally includes ACP. Preparation cleans generated `dist` directories\nbefore compilation so old emitted files or Vosk models cannot leak into a release;\nit does not delete source files or the user's `models/` directory.\n\nThe packager removes foreign esbuild/PTY/clipboard variants and debug source maps,\nthen shares equivalent nested TUI/Desktop packages and top-level ACP packages\nonly with their first Node ancestor fallback, after file/mode and complete\ndependency-graph comparison. Differing versions, dependency contexts and nearer\nshadowing packages remain isolated. The `shared` optimization report applies to\nboth variants and lists each removed package's original and fallback path.\nCompatible root/ACP transitive lock resolutions can be aligned as a separate\ndependency change, after checking consumer ranges and clean installs. Preparation\nnever edits locks or weakens graph equivalence to increase sharing.\nRuntime TypeScript, declarations, native binaries for this target,\nWASM and license files are preserved.\n\nInspect `.artifacts/releases/\u003ctarget\u003e/pix/SIZE.json` for TUI and\n`.artifacts/releases/\u003ctarget\u003e/desktop/pix/SIZE.json` for the Desktop backend.\nAdjacent `OPTIMIZATIONS.json` reports explain the pruning and sharing decisions.\nSizes count regular-file bytes, not filesystem block allocation. The native\nDesktop host and signing metadata are additional to its backend payload.\n\nBuilds fail above these budgets: TUI 384 MiB unpacked / 160 MiB download;\nDesktop backend 512 MiB unpacked / 240 MiB installer. The limits live in\n`scripts/release/size-budget.mjs`; review dependency growth before changing them.\nCI also uploads `size-\u003ctarget\u003e` report artifacts separately from release assets.\nSmoke tests execute native esbuild, PTY and extension loading after unpacking,\nand additionally exercise ACP and the native application for Desktop.\n\n### CI and publishing\n\nThe `Release` workflow uses native Ubuntu 22.04 x64, macOS 15 ARM64 and Windows\n2022 x64 runners. `Actions → Release → Run workflow` builds and tests all packages\nwithout publishing anything. The seven user-facing installers/archives are\navailable as three Actions artifacts. On a version-tag push, the final job waits\nfor the full native matrix, validates the complete set, adds `SHA256SUMS`, uploads\neverything to a temporary draft, and only after the complete upload succeeds\npublishes it as the public **Latest** release. A failed or incomplete matrix never\nbecomes public. The release script refuses to overwrite an already published\nrelease; publish a new version for fixes.\nChecksums detect damaged downloads; they do not replace trusted code signatures.\nThe final release also contains signed Tauri updater artifacts plus `latest.json`;\nthe latter is generated only after all three native jobs have supplied the exact\nexpected asset set.\n\nTauri's generated `.sig` sidecars are CI inputs, not public downloads. Their text\nis embedded into `latest.json` for updater verification, while the standalone\n`.sig` files are omitted from GitHub Releases and `SHA256SUMS`.\n\n### Optional signing secrets\n\nWithout signing secrets, macOS builds use ad-hoc signatures and Windows installers\nare unsigned. Such builds are suitable for testing but may trigger OS warnings.\nTrusted signing/notarization cannot be configured without the maintainer's keys.\n\nFor macOS, configure repository Actions secrets `APPLE_CERTIFICATE` (base64 P12),\n`APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY` (Developer ID Application).\nFor Tauri notarization also set `APPLE_ID`, `APPLE_PASSWORD` (app-specific password)\n","startLine":109,"endLine":177},{"path":"wiki/development/watch-all-desktop-assets.md","quote":"  watcher request. Cancellation (including an already-open confirmation) returns\n  the control to its non-pending state without publishing a restart marker;\n  a confirmed request keeps the restart animation until exit. Confirmation\n  completion from an obsolete frontend lifecycle cannot change a newer restart.\n- `watch:all` disables Tauri's `beforeBuildCommand` because it has already built the web bundle once in the ordered build plan.\n- Watch web builds write directly to `frontend-dist` inside that watcher's\n  unique temporary runtime root, with Vite's explicit `--outDir` and\n  `--emptyOutDir`. Native builds override Tauri's `frontendDist` with this\n  absolute private path; they never embed the shared `desktop/dist`. This\n  prevents a concurrent ordinary web build (or another watcher) from deleting\n  assets while Tauri reads them. Within one watcher web/native steps remain\n  serialized. Rust-only rebuilds reuse its last successful private web output;\n  a failed web rebuild invalidates it and cannot feed a native build. The\n  private output follows the existing runtime-root cleanup/retention lifecycle.\n- Every native watch build uses the persistent, isolated\n  `desktop/src-tauri/target/watch-all` cache with `CARGO_INCREMENTAL=0` and\n  `CARGO_PROFILE_DEV_DEBUG=0`, overriding inherited values for that subprocess.\n  This avoids retaining rustc incremental state for repeatedly changing embedded\n  assets and reduces debug artifact size. It remains a Tauri debug build; compiled\n  dependencies are reused, and ordinary native/release builds are unchanged.\n  Before each native build it runs `cargo clean --package pix-desktop` with an\n  explicit manifest and `--target-dir` pointing only to that watch cache. This\n  removes obsolete content-hashed Tauri embedded assets and application outputs\n  under Cargo's lock, not dependencies or the running Desktop's copied bundle.\n  A cleanup failure aborts the build without publishing an artifact. Other target\n  directories and obsolete dependency artifacts are not automatically cleaned.\n- For ordinary builds, `desktop/src-tauri/build.rs` explicitly tracks the\n  generated `\u003crepo\u003e/desktop/dist/index.html` as a Cargo input. Vite's production\n  entrypoint contains hashed references to emitted JS/CSS assets. Watch builds\n  instead use the private frontend config and package-scoped cleanup above to\n  force regeneration, without depending on shared `dist` changes.\n- The native rebuild therefore regenerates and recompiles Tauri's embedded asset context before the first Desktop launch or a user-requested restart into the newly bundled artifact.\n- A failed web/native build keeps the previous working Desktop process alive and does not mark it stale; the watcher never restarts into a partially built frontend.\n- macOS launch success is based on the real Tauri app process, not only the\n  `/usr/bin/open -n -W` helper. After resolving the exact copied bundle\n  executable PID, `watch:all` gives that PID its own startup grace interval and\n  verifies it is still present before printing that Desktop is running. A\n  short-lived app therefore reports a restart failure instead of a false\n  success followed immediately by `desktop stopped`.\n- Development/watch native builds do not compile/register the release-only\n  Tauri updater plugin, and the watch-built frontend does not start an updater\n  check. This avoids requiring release updater configuration in the base Tauri\n  config and keeps the debug `.app` launchable.\n- Build subprocess output remains streamed to the terminal in real time, but the\n  watcher also retains only a bounded tail of the current build step. If that\n  command exits unsuccessfully, `watch:all` repeats the retained tail underneath\n  a prominent `BUILD FAILED` banner at the bottom of the terminal and emits a\n  terminal bell, so compiler errors cannot disappear above a long build log.\n- A failed cycle remains explicit in watcher state until a later successful\n  cycle. The next relevant edit logs that it is retrying the failed build, and a\n  successful recovery is called out before the normal success message.\n- Each successful native build gets a distinct copied debug bundle so its\n  executable path identifies the launched macOS process. The watcher removes\n  superseded copies after publication and restart, but retains the running app,\n  an in-flight launch, the latest build, and any app still visible in the\n  process list. A failed copy/signing removes its incomplete destination.\n- On macOS startup, the watcher reclaims abandoned `pix-watch-all-*` temporary\n  roots only after checking their owner PID and process commands for a running\n  app/helper using that exact root. A missing or invalid process snapshot\n  prevents cleanup. Pre-owner-marker roots are eligible only after an hour and\n  when no other watcher is running; recent/ambiguous roots are left intact.\n  Shutdown likewise retains a root if its Desktop process survives termination.\n\n## Non-goals\n\nOrdinary native UI QA consumes a pinned successful watch artifact through\n`qa:desktop`, without restarting the working Desktop or changing this watcher's\nlifecycle. See `wiki/development/testing/desktop-qa-isolated-launch.md`. QA owns its copy/profile and\ncleanup; the watcher remains only the producer. Restart/recovery testing remains\na separate explicitly requested scenario.\n\n- Running a development HTTP server from `watch:all`.\n- Rebuilding the web bundle twice per cycle.\n- Changing Cargo profiles or incremental compilation outside `watch:all`.\n\n## Related files\n\n- [Decision: disk-saving native watch builds](../decisions/0005-watch-all-cargo-disk.md)\n\n## Implementation\n\n- `scripts/pix-watch`\n- `scripts/watch-all.mjs`\n- `scripts/watch-all-desktop-quit.mjs`\n- `scripts/watch-all-state.mjs`\n- `scripts/watch-all-temp.mjs`\n- `desktop/src/app/desktop-watch-restart.svelte.ts`\n- `desktop/src/App.svelte`\n- `desktop/src/components/DesktopTitlebar.svelte`\n- `desktop/src-tauri/build.rs`\n- `desktop/src-tauri/src/lib.rs`\n","startLine":64,"endLine":154},{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (radar), Subagents, then Plan, with no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged.\n\n- Status-bar elements and their detail surfaces do not use browser-native `title` tooltips. Accessible labels remain. Usage shows recorded session spend, an integrated weekly cycle/remaining-quota timeline and a short-window Limits scale, not quota-description paragraphs; compact quota indicators remain in its trigger. See [quota limits](desktop-quota-calendar.md) and [decision 0039](../decisions/0039-quota-reset-calendar.md). Context, Usage and Observer popup lower edges match Plan, touching the top of their triggers with no visual gap. Sidebar tooltips are unchanged.\n\n- Once an active Desktop session runtime is ready, the status bar shows a slightly extended horizontal capacity track without an inline numeric percentage.\n- Compact status chrome labels context as `Context`, omits redundant hourly/weekly and `resets` text (window names and reset meaning remain in click details), and shows Claude Code provider model names without the `Claude Code ` prefix in the model/thinking display. Persistent model names use neutral foreground text and thinking uses muted text, leaving provider brand color to the icon; picker and usage-detail model colors are unchanged. Provider IDs and routing are unchanged. Context and quota use content-sized grid groups rather than equal columns; bounded inline controls clip excess content at very narrow widths instead of painting over neighboring controls, while detail panels remain unclipped.\n- Context and Usage have distinct inter-group spacing and fixed inner telemetry slots. Quota windows use track, reset countdown, then the associated warning/retry/cache indicator, with no bullet or middle-dot separators; loading placeholders follow the same order. Only actually present quota windows take space; the account label stays in the details rather than the trigger.\n  Neither Context nor quota triggers reserve or render numeric percentage slots, including their skeleton placeholders. Percentages remain available in detail panels and quota accessible descriptions; narrow-window clipping remains bounded by the outer control.\n","startLine":1,"endLine":35},{"path":"wiki/work-management/registry/resource-registry-agent-companions.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Registry agent companion directories\n\n## Behavior\n\nAn agent is identified by `agents/\u003cname\u003e.md` in the private Git registry or\n`.pi/agents/\u003cname\u003e.md` in a project. If a sibling directory `agents/\u003cname\u003e/`\nexists, it belongs to that agent and is synchronized recursively along with\nthe Markdown definition. A directory without a valid matching definition is\nnot a separate Registry resource.\n\nInstall and update replace both components, including removal of an obsolete\nlocal companion when the remote no longer has one. Push replaces both remote\ncomponents, including deleting an obsolete remote companion. Remove deletes\nboth remote components but retains the project copy; uninstall deletes both\nlocal components but retains the registry copy. Registry is available only in\nPix Desktop; operations run directly in ACP without a Pi session.\n\nStatus and provenance hash both components when the companion exists, detecting\nedits, additions, and deletion of local assets. Remote revisions follow both\npaths, so companion-only commits show as updates or divergence. File-only\nagents retain their original file hash for existing provenance compatibility.\n\n## Constraints and failure cases\n\nThe companion must be a regular directory, not a symlink or file. Its nested\ncontents follow the same copy/hash rule as skill trees: symbolic links and\nunsupported filesystem entries are rejected rather than followed. Registry\noperations continue to validate the Markdown definition before syncing.\nOnly the named agent's two paths are staged/committed; other agents are not\nincluded in an agent push or remove. As with other Git-backed Registry trees,\nan empty companion directory alone cannot be transported by Git.\n\n## Implementation\n\n- `acp/src/registry/resource-files.ts`\n- `acp/src/registry/resources.ts`\n- `acp/src/registry/status.ts`\n\n## Tests\n\n- `acp/test/registry.test.ts`\n\n## Verification\n\nRun the ACP resource registry tests and typecheck. Confirm companion-only\nedits and removals change status, transfer on push/update, and are removed by\nuninstall/remove without changing other agents.\n\n\n","startLine":1,"endLine":54},{"path":"wiki/tools/suite.md","quote":"Live evals are opt-in. The deterministic coverage registry is part of normal\ntests, so adding an extension or tool without eval coverage fails the gate. See\n[`docs/evals.md`](../development/testing/evals.md) for the architecture, complete 19-case catalog,\nfixtures, assertions, metrics, model matrix, report format, environment\nvariables, CI recommendations, and the procedure for adding new evals.\n\nSupporting docs and historical standalone README content are kept in `docs/`; third-party license texts are kept in `licenses/`.\n\n## SDK pin\n\nThis suite runs inside the Pi host process, so its `@earendil-works/*`\npeerDependencies (`pi-ai`, `pi-coding-agent`, `pi-tui`) must match the host Pi\nSDK version exactly. Otherwise npm can resolve a stale copy in this package's\nown `node_modules` and cause a double-load (e.g. `0.75.4` here vs `0.79.4` in\nthe host).\n\nThe host repo keeps these aligned: `npm run sync:sdk-pin` rewrites these\npeerDeps to the host version, and `npm run sync:sdk-pin:check` reports drift\n(non-zero exit). When you bump the Pi SDK in the host `package.json`, the host\nruns `sync:sdk-pin` and then you reinstall here:\n\n```bash\nnpm install --ignore-scripts\n```\n\nThe suite deliberately does not bump its own `version` field for SDK changes;\nits peerDeps carry the version.\n\n## Third-party notices\n\nParts of this extension suite are based on or adapted from code by other vendors and projects. The corresponding license texts and notices are included in `licenses/`.\n\n\n","startLine":1346,"endLine":1378},{"path":"wiki/tools/headless-tool-api.md","quote":"# Headless Tool API\n\nThe `src/headless/api.ts` entrypoint runs the actual `pi-tools-suite` tools\nwithout opening an interactive Pi parent session or ACP. It loads the\noriginal extension registration functions and calls their real `execute()`\nimplementations. The ordinary tools do not call an extra LLM; the `subagents`\ntool **does** launch delegated Pi agents, which may invoke configured models.\n\n## Use as a TypeScript API\n\n```ts\nimport { createHeadlessToolApi } from \"./src/headless/api.js\";\n\nconst api = await createHeadlessToolApi({\n  cwd: \"/absolute/project/path\",\n  model: { provider: \"openai\", id: \"gpt-6\" },\n});\n\nconst inventory = api.inventory();\n// inventory.profile === \"codex\"\n// inventory.nativeTools === [\"read\", \"shell\", \"apply_patch\"]\n// inventory.tools: original SDK + Pix extension tool schemas\n\nconst result = await api.execute(\"ast_grep\", {\n  lang: \"ts\", pattern: \"console.log($A)\", paths: [\"src\"],\n});\n\nconst roles = await api.execute(\"subagents_catalog\", {});\n// Includes project-local .pi/agents/*.md profiles\n\nconst writable = await createHeadlessToolApi({\n  cwd: \"/absolute/project/path\", readOnly: false,\n});\nawait writable.execute(\"read\", { path: \"src/index.ts\" });\nawait writable.execute(\"shell\", { command: \"git status\" });\n// writable.execute(\"apply_patch\", { input: \"*** Begin Patch\\n...\" })\n```\n\nRun this source API using `node --import tsx` from the Pix checkout. For a\nprocess boundary, `src/headless/cli.ts` accepts one base64url-encoded JSON\nrequest per invocation, with `operation: \"list\"` or `\"call\"`, `cwd`,\n`model`, and `tool`/`args` for calls. The CLI returns one JSON object on stdout.\n`cwd` must be an absolute path in the host OS's native syntax (including\nWindows drive-letter paths). The detached subagent broker passes the TypeScript\nloader as a file URL so Node can resolve it on Windows as well as Unix.\nFor `todo`, the trusted MCP host also sends an opaque `todoSessionKey` that\nidentifies the current ChatGPT conversation **and** selected project.\n\n## Tool descriptions and MCP instructions\n\nThe `list` response returns the actual Pix GPT/Codex tool descriptions and\nschemas. The MCP host publishes those descriptions in `tools/list`; it does\n**not** copy Pix `promptSnippet`, `promptGuidelines` or system-prompt hooks\ninto `initialize.instructions`. The MCP server uses that separate field only\nfor its short project/workspace/transport contract.\n\nMost Pix descriptions are passed through unchanged. `project_tasks` already\nhas its headless-mode authorization description. The `subagents` adapter\nchanges the two incompatible parent-session statements: `subagentType`\nmust be explicitly chosen from `subagents_catalog` because there is no LLM\nrole router, and ChatGPT MCP does not receive automatic child-completion\nfollow-ups. The headless task schema also marks `subagentType` as required,\nand both the direct API and the CLI reject missing roles before launching\nthe broker. `spawn` returns after scheduling; call `status`, `wait` or\n`result` when a result is needed.\nIf those upstream statements change, the adapter fails closed for review\ninstead of publishing contradictory guidance.\n\nThe complete Pi system prompt, `coding-discipline`, DCP, provider hooks,\ncustom prompt files and other `before_agent_start` sections are not\ncollected or forwarded. Project-specific instructions come through the\nMCP host's per-chat `projects` and `skills` tools, and role definitions\ncome through `subagents_catalog` for the selected project. Changing the\n","startLine":2,"endLine":74},{"path":"wiki/desktop/guide.md","quote":"configuration can override the user defaults. TUI settings are independent.\n\nFindings still appear above the composer with evidence and feedback. **Insert\nquestion** only fills an empty draft; it does not send it or change code. A\nwaiting observer may need more completed agent turns, not only elapsed time.\nSee the [feature contract](../assistants/observer/heads-up-observer.md) and the\n[reproducible evaluator](../assistants/observer/evaluation.md) for limitations and checks.\n\n## Updates\n\nPackaged production Desktop builds use Tauri Updater. On startup Pix checks the\nsigned release feed; when a newer version exists, the UI exposes an Update\naction with download progress.\n\nWindows uses the packaged installer flow. macOS/Linux offer Restart after the\nreplacement is ready. Development/watch builds do not run the production\nupdater, and Desktop never falls back to npm or the portable-TUI updater.\n\n## Linux AppImage blank window: `EGL_BAD_PARAMETER`\n\nThis issue was reproduced on a Fedora/Bazzite-family Wayland/Mesa system. The\nrepository keeps the original diagnostic handoff separately; the instructions\nbelow are the generalized user-facing fix.\n\n### Symptom\n\nPix Desktop launches a window, but the WebView remains blank. Starting the\nAppImage from a terminal shows:\n\n```text\nCould not create default EGL display: EGL_BAD_PARAMETER. Aborting...\n```\n\nAn `atk-bridge` accessibility warning may also appear; in the reproduced case\nthat warning was not the cause of the blank window.\n\nThe observed failure is consistent with a Wayland/Mesa compatibility problem\nwhere the AppImage's bundled `libwayland-client` conflicts with the host\nEGL/Mesa stack.\n\n### Workaround\n\nApply this only when the AppImage has the exact blank-window /\n`EGL_BAD_PARAMETER` symptom.\n\nAssuming the AppImage is stored as:\n\n```text\n~/.local/opt/pix-desktop/pix-desktop.AppImage\n```\n\ncreate a wrapper beside it:\n\n```sh\n#!/bin/sh\nset -eu\n\napp_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nwayland_lib=$(ldconfig -p 2\u003e/dev/null | awk '/libwayland-client\\.so\\.0/{print $NF; exit}')\n\nif [ -n \"${wayland_lib:-}\" ] && [ -r \"$wayland_lib\" ]; then\n  export LD_PRELOAD=\"$wayland_lib${LD_PRELOAD:+:$LD_PRELOAD}\"\nfi\n\nexec \"$app_dir/pix-desktop.AppImage\" \"$@\"\n```\n\nSave it as:\n\n```text\n~/.local/opt/pix-desktop/pix-desktop\n```\n\nthen:\n\n```bash\nchmod +x ~/.local/opt/pix-desktop/pix-desktop\n```\n\n","startLine":229,"endLine":307},{"path":"wiki/getting-started/installation.md","quote":"fallback, vision Lookup and search-embedding settings (see\n[Pix Desktop](../desktop/guide.md)); skipping the first run is remembered, while cancelling\na manual run changes nothing. Both write the same config files, including\n`search.embedding` / `search.rerankerModel` into `pi-tools-suite.jsonc` on request.\n\nFor provider setup and configuration details, see\n[Configuration and accounts](../configuration/guide.md).\n\n## Updates\n\nPortable TUI release installations update as a unit:\n\n```bash\npix update --check\npix update\n```\n\n`pix update` selects the matching GitHub Release archive, verifies\n`SHA256SUMS`, smoke-tests the staged bundled runtime and swaps the installation\nafter the updater exits.\n\nPackaged Pix Desktop uses the native Tauri updater. Production builds check the\nsigned update feed and expose Update/Restart in the application; Desktop does not\nfall back to the TUI/package-manager updater.\n\n\n","startLine":198,"endLine":223},{"path":"wiki/context/dcp.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# dcp: dynamic context pruning (as-is spec)\n\n\u003e Risk classes: **data / cross-cutting / provider-context mutation**. DCP is\n\u003e headless. Raw Pi session messages remain the recovery source; DCP changes only\n\u003e the projected provider context and persists durable projection decisions as\n\u003e structured `dcp-journal` custom entries in the same session JSONL.\n\n## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nDCP keeps a long-running agent inside its context budget without rewriting the\nraw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`\ntool, can apply exact continuation summaries, and has a bounded emergency path.\nHistorical details are recovered through `session` history actions, not by expanding a\ncompressed block back into the provider prefix.\n\nOnly sessions created by the journal implementation are supported. There is no\nsidecar importer, legacy state reader, dual-write mode, `decompress`, or\n`recompress` compatibility path.\n\n## Lifecycle and persistence\n\n1. A confirmed new persistent session receives one `dcp-journal` `init` custom\n   entry before DCP publishes provider-visible addressing/rewrite decisions.\n   Ephemeral sessions use the same contract in memory for their lifetime.\n2. `session_start` resets transient runtime state and replays the complete\n   journal on the active branch. A non-empty persisted session without a valid\n   journal is deliberately unsupported rather than adopted as a new DCP\n   session. Unknown versions, broken predecessor chains, or conflicting\n   operation IDs fail closed.\n3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output\n   needed by current policy can be reconstructed from the raw branch. Large raw\n   tool bodies are not duplicated into the journal.\n4. `context` builds a detached provider projection, applies already committed\n   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and\n   candidates, and publishes any new durable projection decision before the\n   resulting bytes may be used by the provider.\n5. `before_provider_request` records which tool results actually occur in the\n   outgoing payload. `after_provider_response` treats HTTP status as diagnostic\n   acceptance only. A successful finalized assistant `message_end` can promote\n   provider evidence when the local attempt is unambiguous. This evidence is\n   runtime-only and returns to unknown after restart.\n6. `agent_end` and `session_shutdown` do not persist a full DCP runtime snapshot.\n   Durable decisions are appended at their mutation/publication boundary.\n\nPlain `custom` entries are not provider messages. `dcp-journal` must never be\nstored as `custom_message` or copied into a model-facing tool result.\n\nAsync-subagent common spawn explicitly loads `dcp/subagent.ts` for every role\nand attempt, without interactive `/dcp` commands or the full suite. The normal\nDCP configuration and model overrides still apply. Enabled `compress` survives\nrestricted/empty work-tool lists, CLI exclusions and model selection; read-only\nchild/council guards allow this context-only operation. Async children are always\n","startLine":1,"endLine":67},{"path":"wiki/development/guide.md","quote":"- Node.js `\u003e=22.19.0 \u003c27`;\n- npm selected by the current shell;\n- Git;\n- Rust + platform Tauri prerequisites for native Desktop builds.\n\nPix intentionally does not pin Node with mise/nvm/Volta repository files.\nDevelopment, CI and release scripts use the `node` / `npm` on `PATH`.\n\n## Clone and install\n\n```bash\ngit clone https://github.com/dnaroid/pix.git\ncd pix\n\ncommand -v node\nnode --version\ncommand -v npm\nnpm --version\n\nnpm ci\n```\n\nACP, Desktop and pi-tools-suite have their own dependency trees when their\ncommands are used:\n\n```bash\nnpm ci --prefix acp\nnpm ci --prefix desktop\nnpm ci --prefix external/pi-tools-suite\n```\n\nAfter changing Node major versions, delete all native dependency trees before\nreinstalling:\n\n```bash\nrm -rf node_modules acp/node_modules desktop/node_modules external/pi-tools-suite/node_modules\nnpm ci\nnpm ci --prefix acp\nnpm ci --prefix desktop\nnpm ci --prefix external/pi-tools-suite\n```\n\nThis avoids reusing native addons built for a different Node ABI.\n\n## Verification before pushing\n\nFor CI failures, flaky tests and cross-platform CI changes, load the project's\nauto-discovered `ci-reliability` skill in `.pi/skills/ci-reliability/SKILL.md`\nbefore modifying tests or workflows.\n\n`npm run check` is the quick **root-only** check, not the complete CI gate.\nFor ordinary implementation, review and bug-fix tasks, run focused regression\ntests and relevant typechecks/builds for the changed code. Do not routinely run\nthe full gate, or reproduce it by running all its stages separately.\n\nRun the full local CI only when preparing a release or when the user explicitly\nasks to push everything (\"запушить всё\"). A focused preflight does not by itself\nauthorize a full run. For those release/push-everything tasks, run:\n\n```bash\nnpm run check:ci:preflight -- --list  # inspect platform-specific smoke tests\nnpm run check:ci:preflight            # quick lifecycle/portability regressions\nnpm run check:ci -- --list  # inspect the native-host plan without running tests\nnpm run check:ci\n```\n\nThe same entrypoint runs in `check.yml`: root checks, ACP checks (including\nstdio smoke), and the tools-suite tests on all three supported TUI platforms;\nDesktop frontend checks/tests and Rust fmt/check/backend-runtime tests on macOS;\nbrowser mock-page E2E on Linux. A successful native gate does not prove the other\nOS matrix legs or release smoke. It does not install dependencies or act as a Git hook.\nThe CI workflow runs the preflight first, **then** the unchanged full gate;\nthe smoke result is never a substitute for the complete platform matrix. This\nlocal verification policy does not change automatic GitHub Actions triggers.\n","startLine":15,"endLine":88},{"path":"wiki/decisions/0005-watch-all-cargo-disk.md","quote":"# 0005 — Disk-saving native watch builds\n\n- Status: accepted\n- Recorded: 2026-10-02\n- Decided: 2026-10-02\n- Owner / approval evidence: parent implementation decision for the user's\n  request to fix `watch:all` after clearing an oversized native target directory.\n- Governing spec: [watch:all Desktop assets](../development/watch-all-desktop-assets.md)\n- Replaces / replaced by: none\n\n## Context\n\nDesktop web edits trigger native rebuilds to embed the newest assets. The watch\nloop should retain dependency reuse without the disk cost of incremental state\nand full native debug symbols.\n\n## Observations and sources\n\n- The user reported excessive disk consumption in `desktop/src-tauri/target`\n  and had already cleared it. No before-cleanup size breakdown is available;\n  the exact contribution of each artifact category is not established.\n- [The watcher](../../scripts/watch-all.mjs) has a dedicated persistent\n  `target/watch-all` directory and uses Tauri's debug build mode. Previously it\n  passed only `CARGO_TARGET_DIR`, leaving incremental/debug settings unchanged.\n- [Tests](../../tests/watch-all.test.ts) verify consistent subprocess settings\n  across initial and repeated builds, and their isolation from web builds.\n- Locally installed `tauri-codegen` 2.6.3, `src/embedded_assets.rs`, writes assets\n  under `OUT_DIR` using content-hashed filenames and reuses existing entries;\n  that path does not remove superseded assets. This establishes an accumulation\n  mechanism, not its measured contribution to the user's cleared target.\n\n## Decision\n\nSet `CARGO_INCREMENTAL=0` and `CARGO_PROFILE_DEV_DEBUG=0` for every native watch\nsubprocess, overriding inherited values. Retain the existing target directory,\ndebug-mode behavior, compiled dependency cache, and artifact/restart lifecycle.\nDo not change Cargo.toml or ordinary native/release builds.\n\nBefore every native watch build, use Cargo's package-scoped clean for\n`pix-desktop`, explicitly targeting only `target/watch-all`. Cargo handles the\nbuild-directory lock; clearing this crate's outputs removes previous embedded\nasset hashes without deleting dependency artifacts or the separately copied\nrunning application. Cleanup failure aborts that build cycle.\n\n## Alternatives\n\n- Clean the entire target or directly delete directories: forces expensive\n  dependency rebuilds or bypasses Cargo's lock. Package-scoped Cargo cleanup\n  avoids both problems.\n- Only disable incremental/debug info: reduces size but does not reclaim\n  content-hashed assets retained by Tauri codegen.\n- Disable incremental compilation only for web-triggered builds: switching\n  settings within one cache undermines reuse and leaves native-only watch\n  sessions producing the expensive state.\n- Change the global dev profile: unnecessarily changes non-watch debugging.\n\n## Consequences\n\nExpected lower steady-state disk usage, not a hard size quota. Rust edits may\ncompile more slowly without incremental state; the application crate is always\nrebuilt after cleanup, while dependencies remain reusable. Native source-level debugging\nrequires a normal non-watch debug build. Dependency/toolchain changes can still\nleave obsolete dependency artifacts; other target directories are not reclaimed.\n\n## Revisit when\n\nTarget continues growing across same-profile web rebuilds, native rebuild times\nbecome unacceptable, or watch-mode source-level debugging becomes a requirement.\n\n\n","startLine":1,"endLine":70},{"path":"wiki/archive/desktop-mvp.md","quote":"- A standalone `desktop/` package; the existing terminal UI remains unchanged.\n- A Tauri process host for the existing `acp/dist/main.js` adapter.\n- An ACP 1.4 JSON-RPC client in the Svelte application.\n- Workspace selection, recent sessions, transcript replay, model/thinking\n  selectors, prompt composition, cancellation, and one-field form\n  elicitations.\n- Development commands and a documented local setup path.\n\n## MVP-era non-goals\n\nThe items below were intentionally out of scope for the first slice. Several\nwere implemented later and are governed by newer feature specs; they are not\ncurrent product non-goals.\n\n- Feature parity with `PiUiExtendApp`.\n- Voice input, an embedded terminal, custom widgets, image attachments,\n  markdown/diff rendering, or authentication management.\n- Bundling Node or a platform-specific standalone `pix-acp` executable in this\n  first slice. Development uses Node plus pix-acp's pinned pi npm dependency;\n  distributable packaging is now governed by\n  [`release-distribution.md`](../development/release/release-distribution.md), using bundled Node,\n  Pix and ACP resources for release builds while preserving source-mode development.\n- Reimplementing the pi runtime in Rust or the webview.\n\n## Behavior\n\n1. Tauri starts one isolated `pix-acp` child for the ACP protocol. The host's\n   command surface has since grown beyond start/line-send/stop (e.g. package and\n   shell terminals via portable-pty); those additions are governed by the later\n   current Desktop contracts, not by this historical baseline.\n2. The client initializes ACP with form-elicitation support before creating or\n   loading a session.\n3. **Later implemented behavior:** selecting a workspace lists its persisted\n   sessions. The user can create a session or load one; loading replays its\n   transcript. Clicking the active session tab opens a searchable session\n   selector below the tabs, matching the terminal UI's active-tab behavior.\n   Each visible tab also has a close button; closing a tab does not delete its\n   persisted session, so it remains available from the selector.\n4. A submitted prompt appears immediately as a user message. ACP\n   `session/update` notifications incrementally update assistant text,\n   thoughts, and tool activity.\n5. While a prompt request is pending, duplicate submission is disabled and a\n   stop action sends `session/cancel`. Final updates remain accepted until the\n   prompt response settles.\n6. Model and thought-level controls reflect ACP `configOptions` and use\n   `session/set_config_option` for changes.\n7. A form `elicitation/create` request blocks in a modal until the user accepts\n   or cancels. String/select/boolean fields emitted by `pix-acp` are supported.\n","startLine":23,"endLine":70}],"notices":["Неопределённость 1 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":61,"excerptedSources":10,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->

# GitHub Release distribution

## Scope and version

Pix ships standalone Node runtime payloads in portable TUI archives and Tauri
Desktop installers. The two variants share preparation code, not an identical
file inventory: only Desktop includes ACP. GitHub Releases are the only supported
distribution channel; the root package is private and must not be published to npm.
Desktop product support is currently macOS only. Windows/Linux Desktop packaging
paths and historical measurements below do not make those supported products;
their validation is not a current Desktop delivery gate. TUI target support is unchanged.
Root `package.json` is the authoritative application version. ACP, Desktop,
Tauri, the Pix Cargo package, and the three npm lockfile root records share it.
`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its
commit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`
tags. The external tools
suite is not independently version-bumped.

## Payload invariants

- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging
  runs natively on each target. Unsupported/cross-host targets fail before output
  cleanup or dependency installation.
- Node is downloaded from the official HTTPS distribution for the exact stable
  version currently selected by the release builder's PATH. The repository does
  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;
  its SHA-256 is verified before extraction. `release.json` records the source
  archive hash and version. This is not a GPG verification or an asset attestation.
- Release preparation removes only the owned compiler outputs (`dist`, and
  `acp/dist` when building Desktop) before compilation. Stale Vosk models and
  obsolete emitted JavaScript must not survive a previous local build. Source
  files and the user's `models/` directory are not deleted.
- Pix uses the actual `npm pack` allowlist and locked production dependencies,
  including required optional platform packages. Desktop additionally installs
  ACP's locked dependencies before conservative deduplication. Development
  node_modules, HOME, credentials and the checkout are never copied into the
  payload. Production runtime compilers/loaders such as jiti, and esbuild when
  present in the production dependency graph, are retained.
- Layout is `pix/runtime/node[.exe]`, `pix/app/{bin,dist,node_modules,...}` and
  (Desktop only) `pix/app/acp/{dist,node_modules,...}`. Preserve the relative relationship between
  ACP, Pix dist and the bundled tools suite. Native addons and dependency license
  files are retained; `DEPENDENCIES.json` inventories shipped package metadata.
- The shell/CMD launcher selects the absolute bundled Node path, prepends its
  directory to PATH for child tools, preserves the caller's working directory,
  forwards arguments, and propagates exit status.
- Standalone means no separately installed Node/npm for Pix itself. Git, project
  toolchains, optional language servers, voice/clipboard helpers and provider
  credentials remain external requirements as applicable.

## Payload optimization and size gates

Preparation writes the TUI variant to `.artifacts/releases/<target>/pix` and the
Desktop variant to `.artifacts/releases/<target>/desktop/pix`. Their `release.json`
uses format 2 and declares `variant: tui` or `desktop`. `--tui-only` skips building
and installing ACP entirely. The Desktop wrapper refuses a TUI or stale payload.

Pruning is restricted to known native package families (`@esbuild/*`,
`@lydell/node-pty-*`, and `@mariozechner/clipboard-*`) and Pi TUI's Darwin
modifier prebuilds. Keep the actual target, macOS universal clipboard fallback,
and glibc clipboard builds for the Linux target. Never infer removals from
arbitrary filenames containing OS names. Missing target esbuild versions fail
before pruning; smoke executes every remaining esbuild instance to prove native
resolution after relocation. Debug JavaScript/declaration source maps are removed;
runtime TypeScript, declarations, WASM, data, documentation and licenses stay.

Nested TUI and Desktop packages, as well as top-level ACP packages, can be
removed only when their files, executable modes and complete declared dependency
graphs match the **first** existing ancestor package Node would resolve after
removal. Graph comparison includes optional/peer dependencies, nested
shrinkwrapped packages and cycles. Same package name/version is not sufficient;
a different nearer ancestor shadows even an equivalent farther copy. Package
edges are recomputed after each removal, including multi-level fallback chains.
Unix and Windows npm bin shims are repointed throughout the payload before
removal, including shims already repointed to a subsequently removed ancestor;
loading uses normal ancestor `node_modules` resolution. No directory links,
dependency upgrades or lockfile edits are used for deduplication. The existing
`shared` entries in `OPTIMIZATIONS.json` now include nested paths and also
appear for TUI. Desktop preparation copies the already-deduped TUI payload and
then dedupes the installed ACP tree: the Desktop report includes both inherited
TUI removals and additional Desktop-stage removals, in stage order. Each entry's
`bytes` counts regular files removed at that stage without double-counting
descendant removals; sum the Desktop report only once, not alongside the TUI
report. A Desktop report's entry count is thus not just the number of packages
removed from the copied Desktop tree.

Dependency maintenance is separate from payload deduplication. Root and ACP
lockfiles may deliberately align compatible transitive resolutions, with exact
registry integrity metadata, all consumer ranges checked, and clean-install and
runtime checks. This does not authorize rewriting SDK shrinkwraps, forcing
incompatible peers, or treating equal versions as proof of equivalent graphs.
Preparation itself still uses the committed locks without changing them; sharing
must pass the same file/mode and full-graph comparison after any alignment.

`SIZE.json` records logical regular-file bytes/counts and section totals.
`OPTIMIZATIONS.json` records removed platform packages/maps and shared dependencies.
The size budgets in `scripts/release/size-budget.mjs` are 384 MiB for the TUI
payload and 512 MiB for the Desktop backend payload, and 160/240 MiB respectively
for their compressed archives/installers. Limits fail closed, not auto-adjusted
to whatever a build produces. A budget change requires review. The installed
GUI also contains the native host and signing metadata beyond its backend payload.

Audits reject legacy Vosk files, ACP inside TUI, remaining foreign packages,
and dangling/external links. Audits and size gates run before bundling and again
on extracted/installed payloads. CI stores size reports separately as `size-*`
artifacts, excluded from the final `release-*` asset download and release manifest.

### Measured size baseline (2026-09-18)

This is a historical local-build measurement, not a promised size for every OS
or a claim that these files were published. Both measurements used Pix `1.0.50`
on `macos-arm64`, with bundled Node `24.21.0` and Pi SDK `0.85.1`. The packaging
changes were in the working tree based on `0a887c7`; that commit alone does not
contain the implementation. macOS signing was ad-hoc, without notarization.

| Measurement | Before (MiB) | After (MiB) | Reduction |
| --- | ---: | ---: | ---: |
| TUI `pix-tui-1.0.50-macos-arm64.tar.gz` | 395.03 | 72.83 | 81.56% |
| Desktop `pix-desktop-1.0.50-macos-arm64.dmg` | 404.66 | 117.60 | 70.94% |
| Unpacked TUI regular files | 1174.07 | 254.85 | 78.29% |
| Complete Desktop `.app` regular files | 1216.86 | 426.34 | 64.96% |

MiB means 1,048,576 bytes. Downloads are measured by archive file size; unpacked
sizes sum regular-file lengths without following symlinks, not filesystem block
allocation or Finder's reported disk usage. The optimized Desktop backend payload
alone was about 388.8 MiB; the full `.app` additionally includes its native host
and signing metadata. Do not compare its whole-app size to the backend-only budget.

#### Causes of the original oversized packages

The initial shared payload included Desktop ACP in the TUI archive. Two independent
production installs also carried overlapping dependencies in `app/node_modules`
and `app/acp/node_modules`. Nested Pi SDK dependency trees contained esbuild
variants for 26 OS/CPU combinations; off-target esbuild packages alone occupied
about 545.9 MiB across those two trees. A stale
`dist/models/vosk/vosk-model-small-ru-0.22` added about 87.1 MiB even though current
dictation no longer used it. These categories overlap and must not be added as
independent savings. Production-only npm installation did not by itself guarantee
a target-minimal artifact, and compilation over an existing `dist` did not remove
obsolete assets.

The corrected pipeline separates TUI/Desktop inventories, cleans compiler output,
prunes known foreign binaries and debug maps, and conservatively shares equivalent
ACP packages. This run shared 50 packages, saving 12,316,322 bytes (11.75 MiB)
after pruning. It did **not** eliminate every duplicate or collapse all Pi SDK
copies. Further savings must preserve the dependency-context rules above; removing
an entire ACP `node_modules` or every `.ts`/`.wasm` file is not a valid shortcut.

#### Evidence and repeat verification

The optimization run completed `npm run release:build -- macos-arm64` with exit
code 0. Both extracted TUI and the native GUI copied from its read-only mounted
DMG passed isolated smoke checks: bundled Node, native PTY, extensions and retained
esbuild; Desktop also passed ACP initialize/new/close. The recorded regression run
passed 1209 root tests, 25 release tests and workflow actionlint. Historical local
npm-smoke evidence may still exist under `.artifacts`, but npm is no longer a
supported publication channel.
Windows and Linux were not executed in this local optimization run; their support
still requires the corresponding native CI results. Real-certificate
signing/notarization was not tested by the ad-hoc build.

Local evidence was saved in `.artifacts/release-size-comparison.json`,
`.artifacts/size-build.log`, `.artifacts/size-build.exit`,
`.artifacts/size-check.log` and `.artifacts/size-npm-smoke.log`, plus each variant's
`SIZE.json` and `OPTIMIZATIONS.json`. These are generated local evidence, not durable
version-controlled dependencies of this spec; the dated table above preserves the
baseline when artifacts are cleaned. Subsequent measurements must record their own
version, target and signing mode rather than treating this snapshot as current.

#### Nested deduplication measurement (2026-09-24, local macos-arm64)

Pix 2.0.14, Pi SDK 0.87.1, bundled Node 26.7.0. On the prepared macOS ARM64
payloads, a read-only
first-fallback scan found 48 TUI candidates (13,940,865 regular-file bytes) and
100 Desktop candidates (33,755,119 bytes) on payloads **already** sharing 53
top-level ACP packages. These are candidate estimates, not additive final savings. The
previous reports and a compressed TUI baseline are preserved under
`.artifacts/release-nested-baseline/` on the measuring machine.

Fresh full preparation removed 49 TUI packages (13,951,897 reported bytes).
The Desktop report retains those 49 inherited removals plus 105 additional
Desktop-stage removals (34,629,264 bytes): 154 entries / 48,581,161 reported
bytes in total. Do not count the TUI stage a second time when using the Desktop
report. These reported bytes are removed-package file totals, not the net
payload size change (generated reports and inventories change size too).

TUI regular-file bytes/count went from 304,654,710 / 24,395 to
290,843,478 / 21,969; Desktop backend from 443,881,566 / 43,793 to
410,113,695 / 38,950. After the full prepare, a temporary local measurement
path ran the production signing, archiving and smoke steps on the prepared
TUI without a second preparation; it is not a supported release CLI mode.
TUI compressed size went from 83,659,539
bytes (a manually generated archive of the prior prepared payload) to
81,023,779 bytes (the signed production bundle helper's tarball). The archive
comparison is indicative, **not** a controlled before/after signing/build
comparison. Both isolated variant probes passed with the bundled Node on PATH;
the Desktop GUI installer was not rebuilt or visually tested. Final reports and
logs are under `.artifacts/release-nested-baseline/` (the original before reports
and archive remain untouched).

#### Compatible ACP resolution alignment (2026-09-24, local macos-arm64)

With Pix 2.0.14, Pi SDK 0.87.1 and bundled Node 26.7.0 unchanged, ACP's
top-level `zod` resolution was aligned from 4.5.4 to root's 4.6.4. Only its
version, registry URL and integrity changed in `acp/package-lock.json`; existing
peer ranges accept 4.6.4. Manifests, SDK shrinkwrap descendants, `ws` versions
and the graph-equivalence algorithm were not changed. A clean ACP install passed.

Fresh preparation then shared ACP's `zod` and `@anthropic-ai/sdk` with their
root copies: two additional removals totaling 12,994,348 regular-file bytes.
The Desktop report now contains 156 shared entries / 61,575,509 removed bytes,
including the inherited TUI stage. Desktop backend size changed from
410,113,695 bytes / 38,950 files (391.11 MiB) to 397,461,402 bytes / 37,151 files
(379.05 MiB): an observed net reduction of 12,652,293 bytes (12.07 MiB, 3.09%).
The removed-package total is not the net saving: the retained dependency version
and generated inventories changed, and rebuilt application files grew by 863 bytes.

TUI dependencies were unchanged. Its signed payload is 290,844,341 bytes /
21,969 files, and the measured tarball is 81,031,825 bytes (77.28 MiB).
Small TUI differences from the previous run are not savings from the ACP change.
The complete ACP Pi SDK tree still cannot be shared: other version/context and
nested-inventory differences remain. This is not a maximum-size-reduction claim.

ACP typecheck, 215 tests and stdio smoke, 44 release tests, SDK/version checks,
and full preparation passed. ACP tests ran with the inherited Desktop config
profile and ACP bridge overrides cleared; the initial ambient-profile run failed
six configuration expectations. The TUI was ad-hoc signed and archived using the
production helpers without another prepare; its extracted payload and a separately
relocated Desktop backend passed isolated runtime probes (native PTY, extensions,
all retained esbuild instances, and Desktop ACP initialize/new/close). This local
measurement path does not add a release CLI option. Evidence is under
`.artifacts/release-alignment/{before,after}/` and sibling logs.

No DMG, updater bundle or full `.app` comparison was produced during this
measurement: the then-current updater private key was unavailable after cleanup
of `.artifacts`. No replacement key was generated during the measurement, signing
requirement bypassed, or real Desktop UI verification claimed. The later key
rotation below does not retroactively validate the deferred installer build and
installed-host smoke.

To validate a later packaging change on a supported native host, run
`npm run test:release` and `npm run release:build -- <target>`. Compare actual
archive bytes and both payload reports, then retain the successful artifact smoke
results. Use `npm run release:smoke -- <target>` and
`npm run release:smoke:desktop -- <target>` to recheck existing artifacts. Never
raise size budgets or remove smoke assertions merely to make an oversized build pass.

## Desktop runtime boundary

`tauri.release.conf.json` enables bundling and copies the prepared payload to
`pix-runtime/` in application resources. Release builds enable the explicit
`bundled-runtime` Cargo feature. In that mode `BackendRuntime` resolves Node,
ACP, all four host extensions, and the bundled pi-tools-suite extension only
from Tauri's resource directory. Missing
files fail with a reinstall diagnostic: never fall back to a build-time checkout,
system Node or development entry overrides. The inherited Pi-entry override is
removed when starting bundled ACP. Environment updates are child-scoped.

The same resource root contains the Desktop first-run bootstrap helper. The
checksum-verified Node archive contributes both the Node executable and its npm
package; npm stays inside pix-runtime/runtime for explicit app-managed tool
installation and is not exposed as a global prerequisite. See
desktop-first-run-bootstrap.md for credential migration and managed tool-installation rules.

Without this feature, existing development/watch workflows retain source paths
and explicit `PIX_ACP_*` overrides. The base Tauri config stays unbundled for
those workflows; distributable builds use the release orchestrator, not plain
`tauri build` or `npm run build:desktop`.

macOS release bundles declare a minimum version of 13.5. The release builder
sets `CI=true` for unattended
DMG generation without Finder/AppleScript customization, including local builds.

Backend resolution/spawning stays within the existing blocking-worker boundary.
Generation, pipes, shutdown, and per-window ownership are unchanged. The packaged
`--release-smoke-test` diagnostic requires the offline, isolated harness and
performs verification on a worker thread after native Tauri/WebView setup. The
native host exits with a dedicated success code only after backend verification;
the smoke does not depend on GUI stdout being attached on Windows, and a normal
GUI exit cannot be mistaken for verified release-smoke success. The host uses
direct process termination for this smoke-only code rather than Tauri event-loop
shutdown. Bundled verification runs `verify.mjs` relative to the runtime root,
which avoids Windows drive-prefix parsing failures in installed paths with spaces.

## Artifacts, gates and publishing

The native matrix produces eleven build assets. Three of those are updater `.sig`
sidecars used only inside CI to populate the `signature` fields in `latest.json`;
they are not public GitHub Release downloads and are not listed in `SHA256SUMS`.
The eight public build assets are three TUI archives, one macOS DMG, one macOS
`.app.tar.gz` updater bundle, one Windows NSIS EXE, and Linux AppImage and DEB.
The final publish job rejects missing/unexpected build inputs, generates
`latest.json` from the internal signatures, then hashes only public assets into an
alphabetically ordered `SHA256SUMS`. A complete updater-capable public GitHub
Release therefore contains ten files: eight build/updater assets, `latest.json`,
and `SHA256SUMS`.

`check.yml` owns PR/master correctness checks and never runs on release tags.
`publish.yml` is release-only. A lightweight `release-contract` job validates
release tests and version/tag alignment, then `build-release` runs the three native
targets. Each runner prepares, packages, audits and smoke-tests its real artifacts
before upload. `github-release` waits only for the native release matrix, has the
only `contents: write` permission, validates the tag/repository, creates a draft,
uploads the complete verified asset set, then publishes it as the stable GitHub
Latest release. Failed/incomplete matrices remain non-public. Reruns may replace
draft assets but never published assets. Manual dispatch produces Actions artifacts
but cannot create a GitHub Release. Draft discovery retries briefly after create/edit
because GitHub's release listing is eventually consistent. There is no npm publication
gate or registry dependency.

## Signing and updates

macOS payload Mach-O files are signed inside-out before archiving/bundling. With
no identity they are ad-hoc signed. The embedded Node executable alone receives
Node-specific JIT/native-addon entitlements; the GUI uses separate entitlements.
Both the portable macOS TUI archive and the Desktop `pix-runtime` payload include
the prebuilt `helpers/macos-accessibility` UI-QA driver. Preparation compiles it
before the payloads split; release signing applies the fixed
`org.pix.ui-qa.macos-accessibility` identifier, then the archive/installer smoke
and installed runner check its signature. Installed QA does not need `swiftc` or
fall back to a per-project executable. With a Developer ID certificate the
helper's certificate-based TCC identity can persist across updates; ad-hoc
signing still uses a code-hash requirement and may require renewed user grants.
Optional Apple Developer ID and notarization credentials and Windows PFX signing
credentials are supplied as Actions secrets, imported into temporary runner
stores, and cleaned with `always()` steps. They are never embedded in artifacts.
Absent certificates do not imply trusted OS signing or warning-free installation.

Desktop update signing is a separate trust boundary from Apple Developer ID or
Windows Authenticode signing. `createUpdaterArtifacts` is enabled for release
builds. Tauri signs updater artifacts with the private key supplied only through
`TAURI_SIGNING_PRIVATE_KEY` (or a local ignored key path); the corresponding
public key is embedded in `tauri.release.conf.json`. `latest.json` references the
published GitHub Release assets and embeds their generated signatures for
`linux-x86_64`, `windows-x86_64` and `darwin-aarch64`; separate `.sig` downloads
are intentionally omitted. Losing or replacing the
private updater key without a migration path breaks update continuity for already
installed Desktop clients. The private key must never be committed.

`.pix-portable.json` marks a release installation. Presence, even with damaged
JSON, disables package-manager self-mutation. A valid format-2 marker additionally
identifies `variant` and native `target`. npm installs retain their existing npm
update/ABI-alignment behavior; `--force` on a release installation never mutates
global Pix/Pi packages. Settings and sessions stay in the user profile.

### Updater key rotation (2026-09-24)

The prior private key was lost after local build-artifact cleanup and its matching
old public key could already have reached some Desktop installations; distribution
is uncertain. With explicit approval to break old trust, a new Tauri signer pair
was generated locally for unattended use with an **empty password**. The new
private key is stored outside the checkout at
`~/.config/pix/release-signing/pix-updater.key` (directory `0700`, key and public
file `0600`), and the exact new `.pub` contents replace only
`plugins.updater.pubkey` in `desktop/src-tauri/tauri.release.conf.json`. Endpoint
and updater signature verification remain enabled. New `.pub` SHA-256 fingerprint:
`05f3494ed57d62bfcdcf0311bb01ab9cc0074bf5e08cb7fd75fc7b4df107f439`
(public-key comment `60FC3A7427E9135`). A benign message signed with the new key
verified against the configured public key using `minisign-verify` 0.2.5;
altering the message was rejected. This is a key-pair check, not an installer
build or a claim that any Desktop release was published.

Old-trust installs cannot verify updates with this new key: users of any
previously distributed Desktop must **manually reinstall** a release carrying
the new public key. There is no automatic updater migration. Keep an independent
secure backup of the private key; do not place the only copy in `.artifacts`,
commit it, or expose it in logs. For a local Desktop release use
`TAURI_SIGNING_PRIVATE_KEY_PATH` pointing to the durable key. Before any future
updater-enabled release, a maintainer must manually replace the Actions
`TAURI_SIGNING_PRIVATE_KEY` secret with this key (see `wiki/development/release/guide.md`);
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must be unset or empty both locally and in
CI. No CI secret was changed during rotation. Pix remains at **2.0.14**;
increment the version for the next updater-capable release.

After rotation, a full local `npm run release:build -- macos-arm64` passed with
the new key path, including extracted TUI smoke and installed native-host/runtime
smoke from the mounted DMG. The resulting updater archive's signature verified
against the configured public key with `minisign-verify` 0.2.5, and a tampered
archive was rejected. The DMG is 118,004,115 bytes, updater tarball 118,632,021
bytes, and TUI tarball 81,024,001 bytes. The full `.app` contains 437,517,183
logical regular-file bytes / 37,180 files (not allocated disk usage). Evidence is
under `.artifacts/release-key-rotation/`; downloads are under
`.artifacts/releases/macos-arm64/assets/`. This is an unpublished local 2.0.14
test build with ad-hoc macOS signing, not Apple notarization, visual GUI QA, an
end-to-end in-app update test, or a before/after DMG comparison.

### Portable TUI updater

`/update` inside the TUI remains a non-mutating check. `pix update --check` does
the same from a shell. `pix update` shows an animated stage indicator on a
terminal and plain stage lines when output is redirected. On a valid portable
TUI installation it fetches the latest stable GitHub Release, selects the exact
target archive, downloads it
and `SHA256SUMS` with bounded byte counts, and requires exactly one matching
SHA-256 entry. It never trusts a filename substring or npm metadata.

The updater extracts into a temporary directory before touching the installation.
ZIP extraction rejects absolute/traversal paths, backslashes, symlinks, and
unsupported entry types. Tar extraction disallows preserved outside paths. The
staged `release.json` and `.pix-portable.json` must match version, target, and TUI
variant; all symlinks must resolve inside the staged tree. The exact bundled Node
then runs the staged `verify.mjs` in an isolated offline profile, covering native
PTY, extensions, and retained esbuild binaries.

Only after verification is the tree copied to a sibling directory on the same
filesystem. A detached helper, running from a temporary copy of the old bundled
Node, waits for the invoking `pix update` process to exit. It renames the current
installation to a sibling backup and the staged tree into the original path. If
the second rename fails, it restores the backup. A successful swap deletes the
backup and schedules cleanup of the temporary helper. Failures before the swap
leave the current installation untouched. Desktop-marked payloads refuse this
CLI replacement path and direct the user to the native updater.

### Desktop updater

Packaged production Desktop builds use Tauri Updater and check the static
`latest.json` endpoint on startup. Development/watch builds do not run the update
check. When a newer signed release exists, the UI shows a dismissible update
banner; installation starts only after the user clicks **Update** and exposes
download progress. Signature verification is performed by Tauri before install.
Windows uses passive NSIS installation and may restart after the installer is
launched. macOS/Linux expose **Restart** after replacement and relaunch through
the process plugin. Failed checks or installs are retryable and never fall back to
npm, ACP, the source checkout, or the portable-TUI replacement code.

The updater is release-gated at both layers. Native Tauri registers the updater
plugin only when the `bundled-runtime` Cargo feature is enabled, so ordinary
development/debug bundles do not require a `plugins.updater` configuration.
The release orchestrator also exports `VITE_PIX_DESKTOP_UPDATER=1` while Tauri
builds the production frontend; without that explicit build flag the WebView
does not start an updater check. This keeps `watch:all` and `tauri dev` from
initializing release-only updater state while preserving updater behavior in
official release artifacts.

## Verification

`test:release` covers targets, checksums, complete-asset gates, version propagation,
published-release protection, stale output cleanup, platform filtering, conservative
dependency sharing, bin shims, and strict size/content gates.
`tests/release-update.test.ts` covers corrupt portable markers, no npm mutation
under `node_modules`, force behavior, stable GitHub metadata, exact asset/checksum
selection, TUI/Desktop updater separation, and swap rollback. Desktop updater
tests cover progress, install/restart, duplicate-install suppression, failure UX,
and stale completion after disposal. Release packaging tests cover the exact
signed updater asset set and generated three-platform `latest.json`. Rust
`backend_runtime` tests cover relocation, missing resources and development
overrides.

Every built archive is extracted outside the checkout into paths with spaces.
The smoke harness isolates the user profile, allowlists only OS/session environment
variables (no provider/signing credentials), removes development Node/npm paths,
adds a failing system-Node sentinel, invokes the real launcher, and runs the exact pinned
bundled Node. It loads native clipboard/PTY dependencies (PTY execution asserts
explicit output), bundled JS/TS extensions and every retained esbuild binary. The
esbuild probe reads the generated `DEPENDENCIES.json` inventory instead of recursively
walking the full dependency tree, avoiding pathological Windows filesystem cost.
Desktop
additionally runs real ACP initialize/new/close without a model request; TUI
asserts that ACP is absent. An inventory without esbuild is valid: Pi SDK 1.2
loads TypeScript through jiti and no longer requires production esbuild. This
does not skip the real JS/TS extension-load checks or allow a retained esbuild
instance to fail its transform. The standalone `verify.mjs` ships its built-in-only
`esbuild-probe.mjs` helper alongside it. GUI checks use an app copied from a read-only mounted DMG, extracted DEB/AppImage
or a temporary NSIS installation, and boot the native application diagnostic.
Linux checks the DEB payload directly; for the AppImage it intentionally lets the
native Tauri host resolve `resource_dir()` from the extracted AppDir instead of
hardcoding an AppImage-internal resource path. The DEB smoke likewise discovers
the unique installed `pix-runtime/release.json` instead of assuming a particular
Tauri Linux resource directory layout. Extracted AppImage native smoke launches
its `AppRun` entrypoint rather than the inner executable so linuxdeploy's library
paths and WebKit helper-process environment are preserved.

The copied `verify.mjs` is a one-shot verifier. After all assertions (and Desktop
ACP shutdown) succeed and it prints `PIX_RELEASE_RUNTIME_OK`, it exits explicitly.
This avoids native dependency handles keeping Windows Node alive after successful
verification; the explicit exit is never reached on an assertion/RPC failure.
The native check must produce the backend completion marker, not merely exit
successfully. macOS executable paths are canonicalized rather than weakening
Tauri's protection against symlink-based resource resolution.
All process ceilings are deadlock safeguards, never speed assertions. Cross-OS
support is verified by the native CI jobs, not inferred from a successful macOS
build. Signing with real certificates still requires a credentialed release run.
The generic release subprocess ceiling remains 20 minutes, while the single Tauri
Desktop packaging subprocess gets a 35-minute ceiling because a cold Windows
Rust build plus NSIS generation can legitimately exceed 20 minutes. The
GitHub native job retains its independent 60-minute hard ceiling.

Windows publishes only the NSIS installer. MSI is intentionally omitted because
the signed Tauri updater feed and native smoke both use NSIS; carrying a second
installer adds several minutes of packaging time without adding a supported
update path. Windows NSIS smoke passes encoded installer/destination paths in the
PowerShell command itself rather than through inherited environment variables.

## Implementation

- `scripts/release/`: preparation, Node downloads, signing, installers, smoke and publication; launcher scripts are under `scripts/release/launchers/` and release tests under `scripts/release/test/`.
- `.github/workflows/check.yml`: PR/master correctness matrix.
- `.github/workflows/publish.yml`: release contract, native matrix and stable Release publication.
- `desktop/src-tauri/src/backend_runtime.rs`, `desktop/src-tauri/src/release_smoke.rs`,
  `desktop/src-tauri/src/lib.rs` and release config: resource-backed host.
- `src/app/cli/release-update.ts`, `src/app/cli/portable-update.ts`,
  `src/app/cli/portable-update-helper.ts`, `src/app/cli/update.ts`, TUI command actions and ACP update
  report: distribution-aware checks and safe portable replacement.
- `desktop/src/app/desktop-updater.svelte.ts`, `desktop/src/components/DesktopUpdateBanner.svelte`, the
  Tauri updater/process plugins and release config: signed native GUI updates.
- `scripts/release/test/packaging.test.mjs`, `tests/release-update.test.ts`, Rust module tests: deterministic guards.
- `scripts/release/prune.mjs`, `scripts/release/dedupe.mjs`,
  `scripts/release/payload-files.mjs`, `scripts/release/size-budget.mjs` and
  `scripts/release/test/optimization.test.mjs`: bounded runtime inventory and size regressions.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"f061c4de-d66a-4d75-9c7e-aef1d8e78d55","contentHash":"f3be7f44a9ce52b444c06cc07903a20114b1764eed8f79f7e494b89290d9e8b6","checkedAt":"2026-10-31T02:03:14.634Z","maxDocumentChars":128000} -->
