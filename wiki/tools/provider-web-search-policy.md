---
kind: spec
status: active
---

# Claude provider search tool policy

## Behavior

Pi may load `pi-claude-code-provider` for Claude subscription models. The
`pi_claude_code_provider_web_search` tool is **never registered** by the
Pix-maintained provider and must not be offered to or executed by the parent
agent or sub-agents: it consumes the provider's metered allowance. The Claude
model provider and its OAuth-account rotation remain available. The suite's
separate `web_search` and `web_fetch` tools are unaffected.

## Constraints and failure cases

The provider's extension omits search-tool registration entirely, including on
subsequent `session_start`/reloads. The retained suite guard is defense in depth
for legacy independently installed providers or another extension attempting to
activate this name: it removes the tool from active tools after initialization,
on model selection and before each turn, and blocks direct execution.
Sub-agents also exclude this tool in their isolated tool guard. Existing running
sessions need a suite reload/restart to discard the prior registration.

## Verification

The provider never exposes/registers the banned tool; a legacy registration is
removed from the active tool list after startup, on model selection and before
each turn, and direct calls are blocked. The separate suite search remains
active, and child inventories exclude provider search.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"0229a733643fb1f3bc551eff83076757e672e5a00cf277f89b7197672f3cb4ba","checkedAt":"2026-10-30T23:13:22.820Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":53,"reportLanguage":"ru"} -->
