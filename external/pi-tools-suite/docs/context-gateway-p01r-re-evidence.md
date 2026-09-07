# Context Gateway P01-R / R-E evidence

<!-- markdownlint-disable MD013 -->

> Date: 7 September 2026.
> Repository HEAD during deterministic gate: `daa1b06` with a dirty tested tree.
> Scope: mutation/LSP outcome integrity and storeless capability inventory for web/docs, structured JSON, subagents and visual results. No archival adapter, fetcher, grant or lifetime extension was added.

## Mutation and LSP

R-E keeps mutations as native passthrough. An actual `applyPatch` run in a temporary fixture proves that its returned `changedFiles`/summary contain only the file changed by that invocation while an unrelated dirty file remains untouched and absent from the result. `getEventPaths` prefers `details.changedFiles` over broader input/patch-shaped paths, so downstream LSP refresh does not derive a whole-workspace diff.

The pre-approved patch string is not rewritten by Context Gateway. Errored/cancelled mutation results are no-ops for LSP enrichment and storeless metadata cleanup, preserving their original result object/outcome. Existing LSP integration tests continue to cover successful post-edit diagnostics, changed-file deduplication, deleted-file behavior and aliases. R-B SDK-chain tests separately prove that enrichment/protocol fields survive later storeless cleanup/security stages.

No new “partial mutation” inference is introduced. If a producer reports partial/error/cancelled state, Gateway preserves that producer outcome rather than constructing a synthetic success or retry.

## Capability matrix

`src/context-gateway/storeless-capabilities.ts` records the current non-archival decisions. It is metadata only; importing it registers no tools/readers/adapters.

| Surface | Status | Storeless strategy | Lifetime claim |
| --- | --- | --- | --- |
| test/build | limited | pure-parser candidate in observe only | current result |
| mutation/LSP | supported | native passthrough | current result |
| web/document | limited | native passthrough | current result |
| structured JSON | limited | native passthrough | current result |
| subagent result | limited | native passthrough | producer-managed |
| visual/image | supported | native passthrough | visual message |
| direct browser | unsupported | none | none |
| direct MCP | unsupported | none | none |

The matrix is a claim boundary, not feature discovery by name. Unsupported paths do not become supported merely because an output resembles JSON/HTML or contains a filesystem path.

## Web/document path

Existing web tool tests cover actual producer-owned HTTP behavior: request metadata, content/link metadata, Ollama→Tavily fallback, auth/API errors, invalid JSON, cancellation and timeout. Storeless Gateway adds no fetch callback and does not reinterpret headings/code or producer pagination/truncation metadata. A bounded R-E fixture confirms that `web_fetch` content remains byte-equivalent through observation.

There is no storeless historical page reader. Producer truncation/pagination remains producer-owned, which is why web/document is `limited` rather than an archive-capable adapter.

## Structured JSON

No generic JSON parser/field selector is registered. A fixture containing the exact literal `9007199254740993123456789` remains opaque text and is not parsed into a JavaScript number, rounded, ranked or field-selected. Upstream pagination metadata is left on the producer result. A dedicated typed adapter requires a future concrete use case and precision contract.

## Subagents

The existing async-subagent result tool already emits a bounded summary plus paths to producer artifacts and explicitly avoids inlining raw logs. Its tests cover missing/running/completed states, structured result generation, artifact paths, cleanup and session lifecycle.

P01-R does not read internal subagent history, does not turn an artifact path into an authorization grant and does not extend artifact lifetime. A completed path therefore remains `producer-managed`; it is not promised to survive producer cleanup/resume/export.

## Visual and unsupported direct paths

Image parts remain image parts and are accounted separately from text. No textual placeholder replaces them as a context optimization.

P00 did not prove a direct parent Context Gateway boundary for browser DOM/network/console or a current direct MCP execution adapter. Both remain explicitly `unsupported`; R-E does not add placeholder adapters to make the matrix look complete.

## Deterministic gate

```text
bun test \
  test/context-gateway/storeless-format-contracts.test.ts \
  test/lsp.test.ts \
  test/web-search.test.ts \
  test/async-subagents/tools.test.ts \
  test/context-gateway/sdk-pipeline.test.ts
```

Result: **107 pass, 0 fail, 689 assertions**.

Additional checks:

- `npm run typecheck` — pass.
- `git diff --check` — pass.

No live model call, manual sync, user-config change or result-shaping adapter was added for R-E.
