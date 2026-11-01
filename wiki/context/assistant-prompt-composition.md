---
kind: spec
status: active
---

# Assistant prompt composition

## Behavior

The suite removes the upstream SDK's automatic **Pi documentation** reference
block from provider-bound assistant prompts for every model, not only GLM.
Removal covers tagged `<docs>` sections, the legacy flat block, initial requests,
subsequent tool-loop requests and new turns. The suite registers sanitization
after its other prompt hooks. Structured prompts remain structured: the request
transform removes only the upstream `docs` section. Existing forced/opaque prompt
overrides are sanitized before the SDK's later forced-prompt projection.

Project instructions, skill metadata/content, custom documentation sections,
conversation messages and tool declarations are preserved. No replacement Pi
documentation primer or recursive/full-document-reading instruction is added.
Explicit project-owned Pi SDK skills are not the SDK boilerplate and remain
available when the task calls for them.

The full delegation policy has one emitted authority: the `subagents` tool
description. The tool snippet refers there; strategy and role catalog do not
repeat the full policy. Short local role-selection, UI-QA/credentials/evidence,
knowledge-audit and worker-briefing reminders remain. Disabling the strategy does
not remove the policy. Conditional review gates stay conditional on the effective
role catalog; this does not change role/model selection or authorize new gates.

The delegation policy instructs parents to write sub-agent task prompts and
instructions in English for token economy, regardless of the user's language.
This covers task, scope, parentObjective, promptAppend, promptOverride and
focus/attention text. Exact quotes, code, paths, identifiers and required
user-facing text retain their original language. Replies to the user stay in
the user's language. This is prompt guidance, not automatic translation or
language validation of tool arguments.

Related behavior: [search routing](../search/repo-knowledge-agent-workflow.md),
[todo statuses and blocked-work handoff](../work-management/todos/todo-initial-status.md),
[parent-first delegation and nonblocking spawn](../tools/agents/parent-first-subagent-routing.md).
Rationale: [decision 0033](../decisions/0033-assistant-prompt-hygiene.md).

## Constraints and failure cases

Recognition is intentionally limited to the SDK's documentation header/block,
not arbitrary mentions of Pi. Unknown future SDK formats require regression
updates rather than broad deletion of project text. Sanitization is request-time;
it does not rewrite persisted historical transcripts. A later external extension
that replaces the prompt after the suite can override the suite's result.

## Verification

Run focused tests and suite typecheck, then the broad suite and smoke checks.
The installed-SDK test uses a local deterministic provider and exercises both
structured and forced prompts over tool-loop and new-turn requests. Assert docs
absence, preserved custom/skill text and tool declarations, and a single full
delegation policy with strategy enabled or disabled. Sync the source suite into
the live extension and check drift. Existing processes require reload/restart.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"df110766586c546a6eccda85a2732ff05d7ac45f51002d78dd6f86c0049308d6","checkedAt":"2026-10-30T23:17:23.358Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":68,"reportLanguage":"ru"} -->
