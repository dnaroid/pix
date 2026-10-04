# 0033 — Assistant prompt hygiene

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user asked in the current prompt-audit conversation
  to fix the findings sequentially and explicitly remove upstream Pi docs again.
- Governing spec: [assistant prompt composition](../../specs/assistant-prompt-composition.md)
- Replaces / replaced by: none

## Context

The prompt audit found unavailable text/path tool assumptions, contradictory
blocked-task guidance, a five-minute default spawn watch, repeated delegation
policy and upstream SDK documentation instructions in the active prompt. The
user reports those documentation instructions had previously been removed; no
historical full prompt was available to date that change.

## Observations and sources

Current source and deterministic tests show that the old documentation stripping
was tied to GLM coding-discipline injection and a legacy flat format. The installed
SDK emits structured sections; its forced-prompt projection also runs after
request-context transforms. See the [SDK regression](../../external/pi-tools-suite/test/prompt-sanitizer-sdk.test.ts).
The delegation string was emitted by four surfaces; strategy can be disabled.
The todo reducer ignored creation status despite guidance allowing activation on
create. No token-cost or model-quality improvement has been measured.

## Decision

Remove the upstream documentation block for all suite models at request assembly,
including pre-sanitizing existing forced overrides. Preserve project instructions,
skills and tool declarations; do not edit SDK dependencies or force structured
prompts into opaque strings. Keep the full delegation policy only in the tool
description, with concise safety/selection reminders elsewhere.

Use available-tool fallbacks for text/path lookup without weakening AST-first
routing. Honor valid initial todo statuses and thinking lifecycle; blocked work
can return to pending with its blocker when switching current work. Default spawn
watch to zero, retaining explicit bounded waits and mandatory QA/audit gates.

The user also requested inspection of a real Pix prompt dump. The TUI QA
runner rejected its existing `PI_DEBUG_PROMPT` flag before app launch. Permit
only an explicit string `0` or `1` for that flag, without inheriting it or
allowing arbitrary `PI_*` variables, shell wrappers or runtime injection flags.
See the [UI QA contract](../../specs/ui-qa-agent.md).

## Alternatives

Shortening the upstream Pi docs conflicts with the explicit user request. A
provider-specific regex alone does not cover structured or non-GLM prompts.
Patching the installed SDK creates upstream drift. Making the strategy the sole
policy authority loses the rules when disabled. Adding a blocked status is
unnecessary because existing pending/deferred states support the workflow.

## Consequences

Expected benefits are less duplicated instruction text and consistent runtime
behavior; these are not measured quality or token-cost claims. Prompt-hook order
and SDK format changes remain integration risks, covered by installed-SDK tests.
Existing loaded extension processes need reload/restart after synchronization.

## Revisit when

SDK prompt reconstruction or section semantics change; another extension replaces
the prompt after the suite; evidence shows the single policy authority is missed;
or deterministic and live routing evaluations reveal regressions.
