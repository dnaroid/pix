# 0060 — Read-only repository queries for every subagent

- Status: accepted
- Recorded: 2026-10-06
- Decided: 2026-10-06
- Owner / approval evidence: the user selected “Read-only repo_* всем” in this
  conversation. The parent chose common launch integration rather than role
  edits. No separate durable conversation artifact is cited.
- Governing specs: [Async subagents](../../specs/async-subagents.md),
  [Repository knowledge workflow](../../specs/repo-knowledge-agent-workflow.md),
  [Council workflow](../../specs/brainstorm.md)
- Replaces / replaced by: supersedes the council-only repo-loader placement in
  [0011](0011-council-research-tools.md) and the todo-only empty-selection rule in
  [0059](0059-subagent-private-todos.md); their other decisions remain in force.
  Council web-loader placement alone is superseded by
  [0061](0061-subagent-scoped-ast-web-tools.md); universal repo/todo policy remains.

## Context

Ordinary children disable automatic extensions. Role tool names alone cannot
load indexed repository capabilities. Every current and future role should be
able to retrieve contracts, code, tests and dependencies without adding general
mutation, setup, web or recursive orchestration authority.

## Observations and sources

Verified: [common spawn](../../external/pi-tools-suite/src/async-subagents/core/spawn.ts)
owns extension loading and [CLI normalization](../../external/pi-tools-suite/src/async-subagents/core/child-tools.ts).
The SDK's CLI allowlist also restricts registered extension tools. The existing
[repo adapter](../../external/pi-tools-suite/src/repo-discovery/index.ts) gates
registration on an indexed project and executable idx; commands are separate
from query tools. Actual SDK integration tests exposed duplicate registration
when both general and council entrypoints loaded the same repo tools.

Evidence: [child facade tests](../../external/pi-tools-suite/test/async-subagents/repo-tools.test.ts),
[offline child inventory](../../external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts),
and [council SDK composition](../../external/pi-tools-suite/test/brainstorm/research-extension.test.ts).
These are capability/isolation checks, not measurements of model research quality.

## Decision

Load one tools-only repo entrypoint for every child attempt through common spawn,
reusing the eight current adapters, prerequisite gate and configured output
profile. Omit setup/update commands; do not implicitly install or initialize.
Add the eight queries alongside private todo to restricted CLI allowlists and
remove their exclusions, preserving restrictions on other tools. Lifecycle
selection adds only registered queries and does not replace work-tool selection.
Child audit instructions report evidence/gaps to the parent, not nested agents.

Council children use this common repo entrypoint; their dedicated extension
registers only web tools and retains the strict read-only call guard, allowing
private todo. Prior council web approval, privacy instructions, protocol, roster
and model policy are unchanged. Todo state isolation and lifecycle are unchanged.

## Alternatives

- Per-role edits duplicate policy and omit hidden or future roles.
- Loading the full suite grants unnecessary setup and parent-facing features.
- Keeping council repo registration alongside the shared loader causes SDK
  duplicate-tool diagnostics; a single registration owner avoids them.
- Allowing CLI exclusions to remove common queries would not satisfy universal
  capabilities; other work-tool exclusions remain supported.

## Consequences

Tool-less roles now have private planning plus gated read-only queries. Missing
prerequisites leave planning/work tools usable and must be reported as access
gaps. Read-only describes product-source authority, not an OS sandbox: idx may
refresh indexes/caches. Model usage, research quality and latency are not proven
by inventory tests. Existing parents require reload/restart to use the new spawn
code; already running children are not upgraded.

## Revisit when

Repo tools gain mutating operations, SDK registry/lifecycle semantics change,
strict filesystem isolation is required, or measured capability overhead warrants
a new policy approved by the user.
