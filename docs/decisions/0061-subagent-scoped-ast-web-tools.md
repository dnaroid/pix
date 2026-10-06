# 0061 — Scoped AST and public web tools for subagents

- Status: accepted
- Recorded: 2026-10-06
- Decided: 2026-10-06
- Owner / approval evidence: the user selected “1 и 2” after the parent proposed
  read-only AST for coding investigators/executors and public web for research,
  not LSP. This is conversation-only evidence; no durable transcript is cited.
  The parent chose tool-driven launch integration and specific bundled defaults.
- Governing specs: [Async subagents](../../specs/async-subagents.md),
  [Council workflow](../../specs/brainstorm.md)
- Replaces / replaced by: supersedes only council web-loader placement from
  [0011](0011-council-research-tools.md) / [0060](0060-subagent-read-only-repo-tools.md).
  Universal private todo/repo and existing council restrictions remain.

## Context

Children disable automatic extensions. Optional role tool names therefore need
explicit registration, and the builtin alias mapper previously dropped custom
names. These capabilities should not be granted to every role or inherited by
project-local full replacements.

## Observations and sources

Verified: [spawn](../../external/pi-tools-suite/src/async-subagents/core/spawn.ts)
owns isolated launch, [model aliases](../../external/pi-tools-suite/src/lib/tool-args.ts)
map Codex grep to shell, and existing AST registration includes search and apply.
The SDK treats CLI tools as a registry allowlist. Web registration includes an
interactive credential command; children must omit it. Council already has
canonical selection and a strict call guard.

Evidence: [work capability tests](../../external/pi-tools-suite/test/async-subagents/work-tools.test.ts),
[offline child inventory](../../external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts),
and [council SDK composition](../../external/pi-tools-suite/test/brainstorm/research-extension.test.ts).
These prove composition/isolation, not model quality or live network access.

## Decision

Bundled research/implement/implement-core/mechanical/frontier-review request
read-only `ast_grep`; only bundled research adds `web_search`/`web_fetch`.
Executors retain all seven existing builtin work tools. Do not add `ast_apply`
or LSP. Project replacements retain full replacement semantics.

Common launch preserves supported extension names, derives optional grants from
the final normalized CLI selection/exclusions and loads one tools-only facade
only when needed. No optional grant survives empty/no-tools or explicit removal.
Overwrite child capability environment state on every attempt. Reuse existing
AST execution and web credential/provider/timeout/cancellation behavior; omit
setup commands. Read-only optional selections use canonical builtins and restore
only permitted available tools on lifecycle events, with a call guard against
mutation/shell/recursion. Executing selections retain existing rights.

Move council web registration to the same loader to prevent duplicate SDK tools.
The dedicated council guard still denies AST, mutations, shell and recursion.
Research web instructions prohibit secrets/private data and local-discovery web
queries, require attribution/access gaps, and forbid credential setup.

## Alternatives

- Universal grants unnecessarily broaden non-research role tools.
- Role-name checks bypass full replacements and caller tool restrictions.
- Full AST/suite extensions expose mutation/setup tools not requested.
- Two web registration owners cause duplicate SDK registration.
- Global alias changes affect unrelated parent tools; scope preservation and
  canonical read-only selection to the child boundary instead.

## Consequences

Coding children inspect syntax without a new mutation tool. Research retrieves
public evidence with existing credentials and possible network costs. Existing
web behavior, including local Ollama startup, is unchanged. Missing AST executable
or unavailable web credentials/services is an access gap, not permission to
install tools or configure credentials. Privacy is guidance, not a network/filesystem sandbox;
executor shell rights are unchanged. Running parents need reload/restart after
source-to-live sync; existing children are not upgraded.

## Revisit when

SDK tool selection changes, roles need different capabilities, AST gains
mutating search flags, network isolation becomes required, or measured tool
overhead/quality suggests a new policy.
