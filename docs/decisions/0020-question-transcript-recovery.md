# 0020 — Recover interrupted questions from the transcript

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: user requested restoration of unanswered questions after Desktop/TUI restart, explicitly accepting fresh answers rather than persisted drafts in this task conversation.
- Governing spec: [Desktop Question Tool](../../specs/desktop-question-tool.md)
- Replaces / replaced by: none

## Context

An unanswered question should remain answerable after a runtime restart. The question invocation and arguments already exist in the session history; only partially filled UI state is ephemeral. Explicit user cancellation must stay distinct from shutdown or connection loss.

## Observations and sources

- The session manager restores unresolved assistant tool calls without synthesizing tool results; `tests/question-recovery.test.ts` exercises this with saved SDK sessions.
- SDK 1.0.0 has no public pending-tool resume method; its agent rejects continuing directly from the last assistant message. The adapter in `src/bundled-extensions/question/recovery.ts` uses the pinned SDK tool execution and lifecycle paths.
- Desktop previously resolved pending questions as Cancel during teardown (`desktop/src/app/elicitation.svelte.ts` and `acp/src/acp/pix-acp-agent.ts`).
- User-approved scope: fresh answers, original invocation/result ID, then agent continuation. Draft persistence is intentionally excluded. Live UI verification is a separate evidence track, not inferred from unit tests.

## Decision

Use the existing transcript as the sole durable source. After extension binding, recover only valid unanswered question calls in the latest assistant tool-use turn, and only if every remaining unanswered call is a question. Reopen with empty selections/drafts, persist the normal result under the original call ID, and continue through the session lifecycle. Never replay unrelated tools.

Distinguish explicit Cancel from runtime interruption. Desktop emits a private interruption marker when clearing question UI; ACP leaves that call unanswered and stops the RPC process during teardown instead of canceling the questionnaire or awaiting an abort that can block on UI. Ordinary forms and malformed/unsupported requests retain their previous behavior. Late completions from replaced sessions are discarded.

Keep SDK-private integration in one adapter, protected by real-SDK regression tests and runtime compatibility checks; UI components do not write the transcript.

## Alternatives

- A separate persisted questionnaire/draft store: unnecessary duplication of invocation data, and draft persistence was explicitly declined by the user.
- Synthesize a new user prompt or invoke a new question call: changes conversation semantics and loses the original call identity.
- Replay all missing tool calls: unsafe for side-effect tools; intentionally excluded.
- Require an upstream public SDK recovery API first: preferable long-term boundary, but unavailable in the installed SDK.

## Consequences

Recovery needs no extra session file format and preserves original IDs. Partial answer text and image drafts are intentionally lost on restart. Mixed unanswered tool turns are not automatically recovered. The private SDK lifecycle dependency requires verification on SDK upgrades; UI teardown must continue distinguishing interruption from explicit Cancel.

## Revisit when

The SDK adds a supported pending-tool resume API, lifecycle compatibility tests fail on upgrade, users require persisted drafts, or mixed-tool recovery becomes a product requirement.
