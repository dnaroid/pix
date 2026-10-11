# Headless Tool API

The `src/headless/api.ts` entrypoint runs the actual `pi-tools-suite` tools
without opening an interactive Pi parent session or ACP. It loads the
original extension registration functions and calls their real `execute()`
implementations. The ordinary tools do not call an extra LLM; the `subagents`
tool **does** launch delegated Pi agents, which may invoke configured models.

## Use as a TypeScript API

```ts
import { createHeadlessToolApi } from "./src/headless/api.js";

const api = await createHeadlessToolApi({
  cwd: "/absolute/project/path",
  model: { provider: "openai", id: "gpt-6" },
});

const inventory = api.inventory();
// inventory.profile === "codex"
// inventory.nativeTools === ["read", "shell", "apply_patch"]
// inventory.tools: original SDK + Pix extension tool schemas

const result = await api.execute("ast_grep", {
  lang: "ts", pattern: "console.log($A)", paths: ["src"],
});

const roles = await api.execute("subagents_catalog", {});
// Includes project-local .pi/agents/*.md profiles

const writable = await createHeadlessToolApi({
  cwd: "/absolute/project/path", readOnly: false,
});
await writable.execute("read", { path: "src/index.ts" });
await writable.execute("shell", { command: "git status" });
// writable.execute("apply_patch", { input: "*** Begin Patch\n..." })
```

Run this source API using `node --import tsx` from the Pix checkout. For a
process boundary, `src/headless/cli.ts` accepts one base64url-encoded JSON
request per invocation, with `operation: "list"` or `"call"`, `cwd`,
`model`, and `tool`/`args` for calls. The CLI returns one JSON object on stdout.
For `todo`, the trusted MCP host also sends an opaque `todoSessionKey` that
identifies the current ChatGPT conversation **and** selected project.

## Tool descriptions and MCP instructions

The `list` response returns the actual Pix GPT/Codex tool descriptions and
schemas. The MCP host publishes those descriptions in `tools/list`; it does
**not** copy Pix `promptSnippet`, `promptGuidelines` or system-prompt hooks
into `initialize.instructions`. The MCP server uses that separate field only
for its short project/workspace/transport contract.

Most Pix descriptions are passed through unchanged. `project_tasks` already
has its headless-mode authorization description. The `subagents` adapter
changes the two incompatible parent-session statements: `subagentType`
must be explicitly chosen from `subagents_catalog` because there is no LLM
role router, and ChatGPT MCP does not receive automatic child-completion
follow-ups. The headless task schema also marks `subagentType` as required,
and both the direct API and the CLI reject missing roles before launching
the broker. `spawn` returns after scheduling; call `status`, `wait` or
`result` when a result is needed.
If those upstream statements change, the adapter fails closed for review
instead of publishing contradictory guidance.

The complete Pi system prompt, `coding-discipline`, DCP, provider hooks,
custom prompt files and other `before_agent_start` sections are not
collected or forwarded. Project-specific instructions come through the
MCP host's per-chat `projects` and `skills` tools, and role definitions
come through `subagents_catalog` for the selected project. Changing the
published tool descriptions requires reconnecting ChatGPT to the updated
MCP daemon; ordinary Pix tool calls still execute from its source checkout.

## Model-aware selection

**The caller must identify the actual calling model.** The default host model
for the ChatGPT bridge is `openai/gpt-6`, yielding Pix's `codex` profile via
the existing `detectModelProfile()` and `selectSuitableToolsForModel()`.
Claude tool names are not substituted when a GPT client is connected. The
inventory's `nativeTools` returns the matching base-tool names, but those
tools **are now registered and executed** using `createReadToolDefinition()`
from Pi SDK and the original `model-tools` aliases for `shell` and
`apply_patch`. The headless host runs Pix's existing `session_start` tool
selector without running other modules' session hooks.

The standalone module set includes `ast_grep` / `ast_apply`,
`project_search`, `project_tasks`, and the **original** Pix `todo` and
`subagents` tools. The additional headless-only `subagents_catalog` tool
discovers the effective built-in and project-local role names. Other
Pi-session hooks still need audited adapters; this is not a generic mock
of the entire `ExtensionAPI`.

## Todo state and project agents

Pix `todo` ordinarily persists in Pi JSONL session history. ChatGPT does not
have a Pi parent session, and each headless CLI request is a new process.
The bridge therefore calls Pix's original reducer/tool **unchanged**, then
persists its committed state at `~/.pi/headless-todos/<session-hmac>.json`.
The HMAC is scoped to deployment, ChatGPT conversation, and selected project.
Writes use an exclusive lock and atomic replacement to prevent concurrent
requests from overwriting one another. This does not automatically migrate
the old MCP `get_plan`/`update_plan` state or a Pi JSONL session's todos.
The read-only bridge supports `todo` actions `list`, `get`, and `export`;
normal mode supports the whole original Pix `todo` action schema.

Pix `subagents` supports its original `spawn`, `status`, `wait`, `result`,
`stop`, and `cleanup` actions. `subagents_catalog` reads the current
project's `.pi/agents/*.md` definitions alongside built-in roles; pass
the intended role in `tasks[].subagentType` for `action: "spawn"`. The
headless parent intentionally has no Pi model registry, so automatic
LLM-based selection of missing roles is not supported; use an explicit
subagent type and let its configured models/fallbacks select the child.

Sub-agent spawns run in a detached **broker process**. The broker calls
the original Pix `subagents(action=spawn)` implementation and keeps Pi RPC
streams, callbacks, timeouts, and final result receipts alive after the
initial MCP tool response. Agent state remains in `<project>/.pi/subagents`;
later `status`, `wait`, and `result` calls reopen the original Pix state from
those artifacts. The headless CLI omits `watchSeconds` on spawn: call
`subagents(action="wait")` separately for waiting. The offline fake-Pi
regression test verifies completion after the initiating CLI process exits.

## Boundaries

- The default is **read-only**: `read`, `ast_grep`, `project_search`,
  `project_tasks` list/get, `todo` list/get/export, and `subagents_catalog`.
  `readOnly: false` also enables original Pix `shell`, `apply_patch`,
  `ast_apply`, writable `todo`, and async `subagents`.
  Project task mutations require `projectTaskWrites: true` in the direct API.
  The writable headless CLI enables these original Pix operations only with
  the independent `--allow-write` host flag. Callers must ensure task changes
  follow an explicit user request.
- The **host** sets an absolute canonical cwd for every call. Relative paths
  resolve from this root; absolute paths are accepted for `read`/`apply_patch`
  only when they stay within it. The wrapper rejects `../` escapes, symlink
  escapes (including links in parent path components) and unsafe patch paths.
  `project_search.projectPath` is disallowed. AST paths are checked and
  `--follow` is disabled.
- Original Pi `shell` uses `ctx.cwd` and Pix's workdir validator. A shell
  command is **not** limited by cwd: it may `cd`, read and write outside the
  project when run without a sandbox. In the MCP Pix-first integration,
  shell executes directly on the host, starting from the project selected
  by this ChatGPT conversation. There is no macOS Seatbelt wrapper.
  Normal desktop mode retains its native approval for nontrivial shell calls.
- No other arbitrary executable is available through the minimal
  `pi.exec` shim; structural search uses `ast-grep`. The original Pix `shell`
  tool intentionally invokes Pi's shell executor when write mode is enabled.
- The MCP bridge uses one short-lived CLI process per ordinary call, plus a
  dedicated long-lived broker for async subagent spawning. There is no
  interactive parent Pi runtime. Semantic search can still use the normal
  Pix configuration and update disposable search caches.
- Headless loads only the supported modules and model-specific aliases.
  DCP, LSP lifecycle hooks, providers, interactive UI and slash commands
  are not exposed.

Regression tests: `bun test external/pi-tools-suite/test/headless.test.ts
external/pi-tools-suite/test/headless-broker.test.ts`.
