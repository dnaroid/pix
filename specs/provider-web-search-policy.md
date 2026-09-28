---
kind: spec
status: active
---

# Claude provider search tool policy

## Behavior

Pi may load `pi-claude-code-provider` for Claude subscription models. Its
`pi_claude_code_provider_web_search` tool must not be offered to or executed by
the parent agent or sub-agents: it consumes the provider's metered allowance.
The Claude model provider remains available. The suite's separate `web_search`
and `web_fetch` tools are unaffected.

## Constraints and failure cases

The provider registers its search tool during `session_start`, and extension
handler order can vary. The parent suite removes it from active tools after
session initialization and before each agent turn, as well as after model
selection; an execution guard rejects it if another actor reactivates it.
Sub-agents also exclude it in their isolated tool guard. A session must reload
the updated suite extension to adopt this policy.

## Implementation

- `external/pi-tools-suite/src/index.ts`
- `external/pi-tools-suite/src/provider-web-search-guard.ts`
- `external/pi-tools-suite/src/async-subagents/core/tool-guard.ts`

## Tests

- `external/pi-tools-suite/test/provider-web-search-guard.test.ts`
- `external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts`

## Verification

The parent active tool list excludes provider web search after registration,
on model selection, and before a turn; direct calls are blocked. The separate
suite search remains active, and child inventories exclude provider search.
