# Context Gateway P00 capability evidence

<!-- markdownlint-disable MD013 -->

This file records only behavior confirmed against the repository at `daa1b06`
and installed `@earendil-works/pi-coding-agent` `0.85.1`. P00 is accepted for
the explicitly classified paths below. A `limited` or `unsupported` row is a
boundary of the accepted evidence, not an implicit promise that Gateway can
shape that path safely.

## Confirmed result pipeline

| Path / capability | Status | Confirmed behavior | Consequence for Gateway |
| --- | --- | --- | --- |
| Extension `tool_result` chaining | supported | `ExtensionRunner.emitToolResult()` runs handlers in extension/handler order and carries forward returned `content`, `details`, `isError`, and `usage`. | Result-stage ordering can be tested deterministically. |
| Handler exception containment | limited | A throwing `tool_result` handler is reported through the extension error channel and the runner continues. If nothing else modifies the result, `AgentSession.afterToolCall` returns `undefined`, so pi-agent-core keeps the executed result. | Throwing is **not** an enforce/fail-closed mechanism. Enforce mode must return its own bounded degraded result before a fallible archival side effect can leak raw output. |
| Session persistence after result hook | supported | The headless SDK harness proves a post-hook sentinel is written to JSONL while the raw tool-return sentinel is absent. | A successful result-stage transformation is early enough to shape the persisted tool result. |
| Next model context after result hook | supported | The second fake-provider call sees the post-hook tool result and not the raw sentinel. | The same transformed result feeds the next model turn. |
| `before_provider_request` after result hook | supported | The headless fake transport sees the post-hook result. A second contract uses the installed OpenAI-completions serializer: its `onPayload` receives already-built wire parameters containing bounded tool content and `tool_call_id`, while tool-result `details` are absent. | Provider-request observation is later than tool serialization; it is useful for final-payload verification, not for recovering bytes already truncated inside a tool. Provider-specific serializers still need compatibility coverage when claimed. |
| Late call after `ExtensionRunner.invalidate()` | limited | `emitToolResult()` itself does not reject an invalidated runner. A handler that ignores `ctx` still runs and can modify a late result; a handler that touches guarded `ctx.*` throws and that error is suppressed by the runner. | Session/tab binding cannot rely on `invalidate()` alone. Gateway state mutations need an explicit binding/epoch check independent of guarded context access. |
| Tool exception | supported, lossy details | A custom tool throw becomes `isError=true`, text contains the error, and the result is persisted and delivered to the next model turn. The core error wrapper uses `details: {}`. | Preserve the execution outcome separately from adapter metadata; do not expect original structured details after a thrown tool execution. |
| Built-in bash timeout | supported, lossy details | A deterministic `timeout:3` backend error preserves the captured text prefix plus `Command timed out after 3 seconds`, becomes `isError=true`, and reaches the next model turn. Structured details are `{}` after the throw. | Timeout must stay explicit in first delivery; capture metadata needed by Gateway must be retained before the throw path collapses details. |
| Session abort during bash | supported, partial | Aborting an in-flight bash call preserves the captured prefix plus `Command aborted`, emits/persists an error tool result, and settles the session. | A cancelled source is partial; never label it complete and never rerun the command merely to recover output. |
| Extension reload during in-flight custom tool | unsafe without binding | The old tool wrapper is invalidated while awaiting the tool. On completion its post-execute access to the stale runner throws; the original result disappears and the **new** runner handles the resulting error. | Capture origin/runtime epoch before execution. Do not resolve ownership or result-stage state from the current runner after `await`. This is a hard blocker for Gateway enforce without an origin binding seam. |
| App tab switch with late tool-result event | supported at tab ownership layer | After switching away, a late `message_end(toolResult)` from the origin runtime marks only the origin tab history stale; the active target tab remains unchanged and returning to the origin reloads its history. | Host-level tab ownership already has generation/runtime/session guards; Gateway should bind to the same origin identity rather than the active tab. |
| Streaming tool updates | runtime-only preview | `tool_execution_update` carries the preview sentinel, while the final `message_end(toolResult)`, JSONL and next provider context contain only the final result sentinel. | Streaming preview is not a second persisted/provider copy in the tested SDK path; final capture still needs to bind to the final result rather than UI previews. |
| Parallel/batch identity | supported, ordering caveat | The executable harness makes call 2 finish before call 1. `tool_execution_end` follows completion order (`2,1`), while tool-result messages and the next provider context are materialized in source tool-call order (`1,2`) with the original IDs. | Use `toolCallId` as the identity key; do not infer identity from completion order. A fixed aggregate batch budget is still not proven. |
| Native manual compaction | separate lifecycle | Installed `AgentSession.compact()` emits `session_before_compact`, accepts an extension-provided compaction result, persists it, then emits `session_compact`; session listeners see `compaction_start/end`. | Native compaction is its own lifecycle and must not be used as a proxy for DCP manual commits. |
| DCP manual compression | separate tool/projection lifecycle | DCP registers a model-facing `compress` tool and does **not** register `session_before_compact`. It observes native compaction via `session_compact`, which invalidates the DCP owner epoch. DCP manual blocks are committed by the tool transaction and materialized later by the DCP context projection. | Track native-compaction and DCP commit/apply as distinct events. Gateway readers must not depend on either one firing for artifact availability. |

The executable evidence is in `sdk-pipeline.test.ts`.

## Pre-truncation capture matrix

`tool_result` means the generic installed SDK result hook, after the tool's own
`execute()` implementation has returned.

| Tool/path | Generic `tool_result` sees | Pre-truncation capture | Current recovery surface | Status |
| --- | --- | --- | --- | --- |
| Built-in `read` | Already truncated text plus truncation details. `read.js` reads the full file into `textContent`, then calls `truncateHead(selectedContent)` before returning. | No public pre-truncation result hook confirmed. | Native `offset`/`limit` continuation; no full-output temp path for ordinary text reads. | limited |
| Built-in `bash` / shell | Tail-truncated result. `OutputAccumulator.snapshot()` is formatted before return. | No generic pre-truncation result hook confirmed. Raw bytes exist inside the accumulator during execution. | When truncated, result `details` carries `fullOutputPath` to a temp file. Streaming `onUpdate` is already bounded. | limited |
| `repo_search`, `repo_ast`, `repo_structure` and other `repo_*` wrappers | Already truncated `truncateOutput(...)` text. | The suite-owned wrapper has complete `pi.exec()` stdout/stderr immediately before truncation, so a future explicit wrapper adapter can capture there. Generic `tool_result` is too late. | Truncation metadata only; current wrapper does not publish a full-output path. | supported via explicit suite adapter; limited generically |
| `ast_grep` | Already `truncateHead(...)` text plus details. | The suite-owned implementation has the complete combined stdout/stderr before truncation, so an explicit adapter can capture there. | On truncation it writes the complete combined output to a temp file and exposes `details.fullOutputPath`. | supported via explicit suite adapter; limited generically |
| Arbitrary SDK/custom extension tool | Whatever its `execute()` returned. | Only if the tool itself returns raw content or Gateway owns an earlier wrapper-specific seam. Internal truncation performed inside the tool cannot be reversed by `tool_result`. | Tool-specific. | limited / tool-specific |
| ACP `mcpServers` request field | No local MCP tool path found. `PixAcpAgent.newSession()` consumes `cwd` and `_meta`; current ACP source has no `mcpServers` execution plumbing. | None confirmed. | ACP protocol callers may send the field, but that is not evidence of a Pi tool/result stream. | unsupported in current Pix adapter / protocol field ignored for execution |
| Browser QA | Parent sees async-subagent status/result, not browser DOM/network tool events. The browser runner executes in a child Pi process launched with `--no-extensions` plus a restricted extension set. | Parent Gateway cannot intercept Playwright/browser bytes through its own `tool_result` hook. | Browser QA retains its own screenshots/video/trace/result artifacts under the subagent workspace; parent subagent result is already compact. | unsupported as a direct Gateway browser adapter; future subagent-artifact integration only |

## P01-R native recovery and lifetime matrix

R-A refines the earlier capability rows by separating a *current/native recovery
surface* from a future durable snapshot. The table below is an offline capability
contract; it does not retroactively reclassify the saved live recovery report.

| Surface | Source boundary / upstream completeness | Native continuation / handle | Lifetime / version semantics | Error / timeout / abort | Checked provider / renderer boundary |
| --- | --- | --- | --- | --- | --- |
| Built-in `Read` | Generic result is already the SDK decoded text view after its own truncation. P00/R-C do not claim byte identity with an arbitrary on-disk encoding. | `offset` / `limit`; R-A v2 validator requires the next call to use the **same path** and the exact `Use offset=N to continue` hint from the preceding successful result. R-C confirms there is no byte cursor and a huge single line is an explicit limited case. | Reads the current file again. R-C proves the same path can return a changed version; it is not a historical snapshot. | Empty/EOF/out-of-range and CRLF/Unicode are covered. Long single-line recovery remains limited to the SDK's shell advice rather than a fabricated line continuation. | Delivered text participates in JSONL/next context. Checked OpenAI-completions serialization omits tool-result `details`; renderer equivalence after metadata cleanup is covered. |
| Built-in `Bash` / shell | Successful truncated result is a tail view; full bytes are retained by the SDK output accumulator before final formatting. | Successful truncation can issue `details.fullOutputPath`. R-A v2 provenance requires exact producer call/result ID, successful producer, exact handle equality, subsequent successful `Read`, and hidden fact in both the issued native file and Read result. | SDK temp output only. R-C proves replacement/deletion changes later Read behavior; no resume/export/fork or immutable-identity guarantee. | Timeout/abort/nonzero retain visible status/output but reject; no structured result handle survives the exception bridge. A path mentioned only in formatted error text is not promoted to a trusted capability. | Bash renderers can surface success-path truncation/full-output metadata. Checked OpenAI-completions provider payload contains delivered content, not `details`. |
| Suite `ast_grep` | Suite wrapper has complete combined stdout/stderr before truncation; generic result is already truncated. | On successful truncation the suite publishes `details.fullOutputPath`; R-A v2 uses the same exact producer-handle-Read correlation as Bash. | Temp artifact owned by the producer; no durable lifetime is promised. | R-C confirms successful truncation publishes a handle, killed/cancelled output does not, and code>1 errors throw rather than publishing a successful recovery handle. | Suite renderer marks truncation and preserves the handle after metadata cleanup; provider claim is limited to the checked common tool-result serialization boundary. |
| `repo_*` Native Compact | Wrapper output is bounded by native profile/policy and then by wrapper delivery limits. Upstream index completeness remains command-specific. | Native cursors exist for `structure`/`ast`; current `search` exposes no cursor. Integer flags require safe integers. No artifact handle exists. | R-C re-executes the same cursor against two backend versions and observes two results: cursor state is current-index continuation, not immutable history. | Policy refusals are explicit and happen before `idx`; execution errors retain their actual outcome. | Registered schemas/guidance and deterministic wrapper tests are covered; no durable reader exists. |
| Persisted Pi session tool-result text | Stores the **post-hook delivered result**, not bytes that were already lost before `tool_result`. | Session/history readers may recover persisted delivered text through their own APIs; this is not a full-output handle. | Session-format lifetime only. It does not turn native temp output into a persistent source. | Persisted error result keeps its visible outcome; structured details may already be lossy. | P00 proves JSONL + next-provider-context behavior for the installed SDK. |
| Future durable snapshot | Not implemented. | Would require a new authorised reader/catalog contract. | Would need explicit session/workspace binding, publication, integrity and retention semantics. | Would need independent fault/security gates. | **No support claim. P02 remains conditional.** |

The historical report
`test/evals/artifacts/context-gateway-recovery-2026-09-07T18-32-36-215Z/context-gateway-recovery-report.json`
does not contain the transient native handle, exact Read arguments/result correlation,
or the producer/result probes required by validator v2. Therefore all three
historical recovery strategies are **unknown under the R-A provenance contract**,
even where the old report's v1 strategy column says PASS. The report is preserved
unchanged; a v2 live recovery report would require separate model authorization.

### Source points inspected

- Installed SDK result chain: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`, `emitToolResult()`.
- Installed session bridge: `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`, `_installAgentToolHooks()`.
- Agent execution/finalization and parallel ordering:
  `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`,
  `executeToolCallsSequential()`, `executeToolCallsParallel()`, and `finalizeExecutedToolCall()`.
- Built-in read truncation:
  `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js`, `createReadToolDefinition().execute()`.
- Built-in shell truncation/temp output:
  `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js`, `createBashToolDefinition().execute()`.
- Repo wrappers: `src/repo-discovery/index.ts`, `executeRepoDiscovery()`.
- ast-grep wrapper: `src/ast-grep/tool.ts`, result formatting around `truncateHead()` and `fullOutputPath` publication.
- ACP new-session path: `acp/src/acp/pix-acp-agent.ts`, `newSession()` / `startNewSession()`.
- Browser QA child isolation: `src/async-subagents/core/spawn.ts`, Pi args around `--no-extensions`.
- Native compaction lifecycle: installed `agent-session.js`, `AgentSession.compact()`.
- DCP lifecycle split: `src/dcp/index.ts` and `src/dcp/compress-tool.ts`.
- Result-stage decision: `docs/context-gateway-p00-adr.md`.
- Installed OpenAI-completions serialization:
  `@earendil-works/pi-ai/api/openai-completions`, real params before `onPayload`.

Executable capture evidence is in `capture-contracts.test.ts`; lifecycle separation
is additionally covered by `lifecycle-contracts.test.ts`, wire serialization by
`provider-serialization.test.ts`, and the root `tests/tabs-controller.test.ts`
late-origin test.

## Known limitations after P00

- OpenAI-completions wire serialization is covered. Other provider families are
  not automatically certified by that test; add per-family compatibility
  coverage if their payload semantics are included in a support claim.
- P00 chooses no durable store primitive. Publication/no-clobber/fsync and
  cross-process quota semantics remain P02 work. Current development evidence
  runs on macOS; Linux/Windows durability is not certified by P00.
- Keep unknown third-party late `tool_result` modifiers outside the supported
  strict-enforce combination until a final boundary test proves them safe.

## P01-R native recovery addendum

The table below separates an execution surface from a claim that a particular
live model run actually used that surface. P01-R recovery validator v2 requires
producer-call/result correlation plus a transient probe of the exact native
continuation/handle. Raw handles exist only inside the disposable synthetic
project and are never copied into the final eval report.

| Surface | Source boundary / completeness | Native recovery | Lifetime / invalidation | Error / timeout / abort | Provider / renderer coverage | Current evidence status |
| --- | --- | --- | --- | --- | --- | --- |
| Built-in `Read` | SDK returns the requested text view after its own head truncation; no pre-truncation hook is claimed. | Same-path `offset` continuation parsed from the actual producer result; validator requires the next `Read` to use that exact offset and a successful result containing the hidden fact. | Reads the current file, not a historical snapshot. A changed file can change later pages. | A failed continuation is an explicit recovery failure; no retry is inferred from matching args. | Generic OpenAI-completions serialization of delivered tool text is covered; renderer-specific continuation UX is not certified here and remains R-B/R-F work. | SDK/offline validator supported. The old live run is historical evidence only until a validator-v2 run is explicitly authorised. |
| Built-in `bash` / shell aliases | Successful truncation can publish `details.fullOutputPath`; generic `tool_result` still sees only the truncated delivered result. | Validator requires exactly one producer call, its successful result, a transient probe proving that **that exact issued path** contains the hidden fact, verified deletion of the synthetic source, then a successful `Read` of the same path containing the fact. | Temp file only; no resume/export/durable guarantee. Missing/expired/replaced files are recovery-unavailable/failure, not snapshots. | Timeout/abort/error paths can lose structured details; absence of a trusted handle remains explicit and never causes command replay. | OpenAI-completions does not serialize tool-result `details`; the handle is therefore a host/tool recovery capability, not provider-visible evidence. Existing SDK renderer behavior is not promoted to a general UI contract until R-B/R-F. | SDK handle contract and offline provenance validator supported. Previous live `Bash → Read` report did not persist enough provenance to certify the strategy under validator v2. |
| `ast_grep` | Suite wrapper owns complete combined stdout/stderr before truncation and writes complete temp `output.txt` when truncated. | Same exact-handle correlation as shell; a different temp-looking path or path mentioned only in visible text is rejected. | Temp artifact lifetime belongs to the producer; no cross-session guarantee. | Missing/unreadable artifact is explicit unavailable; producer is not rerun merely for recovery. | Provider receives only delivered result text in the checked OpenAI-completions path; suite renderer/full-output affordance needs its own R-B/R-F coverage before a UI support claim. | Suite/offline contract supported. Previous live `ast_grep → Read` report remains historical task evidence, not validator-v2 strategy proof. |
| Persisted session text / future `session-recovery` | Separate source: bytes already stored in session history, not a tool temp handle. | Addressability belongs to plan 32 and produces a new tool result. | Session-format lifecycle, not temp-output lifetime. | Governed by the future session-recovery contract, not Context Gateway temp-handle logic. | Provider/UI behavior belongs to plan 32's new-session recovery contracts. | Out of P01-R recovery implementation scope; do not substitute it for a native-handle proof. |
| Future durable Gateway snapshot | Not implemented. Would require a separately published permitted snapshot with stable identity. | Future `artifact_read/search` only after P02/P03 Go. | Durable lifetime/grants/export require P02/P03/P08 contracts. | Publication/recovery faults are future store work. | No provider/renderer support claim exists before P02/P03/P09. | Blocked by current P02 No-Go. |

The historical recovery reports under `test/evals/artifacts/context-gateway-recovery-*`
are not rewritten. In particular, the `2026-09-07T18-32-36-215Z` report recorded
task success and tool-name sequences but its v1 validator did not correlate
`Read.file_path` with the exact producer-issued handle. Validator v2 fixes that
offline contract; it does **not** retroactively convert the old report into a
new live pass.
