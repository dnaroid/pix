---
kind: spec
status: active
---

# Desktop draft-session optimistic submit

## Behavior

When a user sends the first normal prompt from the Desktop `New conversation`
draft, the UI responds immediately instead of waiting for ACP session startup.
The composer clears and the local user message appears in the active transcript
before model routing, `newSession`, and `loadSession` finish.

The draft keeps its draft identity while startup is pending. Once ACP returns a
real session id and runtime configuration, Desktop promotes the draft to that
session, preserves the already-rendered transcript, and sends the prepared
prompt exactly once without appending a duplicate local user message.

Attachments are part of the optimistic user message and their count is included
in first-prompt model routing just as it is for non-optimistic materialization.

## Constraints and failure cases

- Only the first normal prompt from the active draft uses optimistic submit.
  Existing terminal-command paths retain their command-specific behavior.
- Draft materialization remains single-flight. A second submit or conflicting
  session mutation must not start another materialization concurrently.
- If materialization fails while the draft is still active, the original text
  and attachments are restored to the composer and the optimistic transcript
  message is rolled back.
- If the user selects another session after the optimistic first prompt has been
  accepted, that selection does not abandon the send. Materialization continues
  in the background, the real session adopts the captured optimistic transcript,
  and the prepared prompt is sent to that real session without replacing the
  session the user selected or overwriting its composer/runtime/config state.
- Explicit draft discard/close, workspace/client invalidation, or another stale
  materialization generation still cancels startup. Any ACP session created by a
  stale generation is closed instead of being promoted.
- If background materialization fails after the user has selected another
  session, the original text and attachments are stored under the draft owner
  for retry without replacing the currently selected composer.
- Successful materialization must adopt the optimistic transcript rather than
  replacing it with an empty transcript.
- Startup notices already cached for the real session are retained after the
  optimistic user row during adoption. Notices arriving after adoption append to
  the same transcript. Background adoption must not replace the selected chat.

## Verification

- The first draft prompt is visible and the composer is empty while the
  materialization promise is still unresolved.
- After successful materialization, the prompt request runs once against the
  real session id and the optimistic message remains in the transcript.
- Switching to another conversation while startup is pending leaves that
  conversation selected while the accepted prompt materializes and sends in the
  background.
- Failed materialization keeps retry input with the draft owner; explicitly
  abandoned or stale materialization does not leak a late-created session into
  the active workbench.
- Desktop Svelte/TypeScript checks complete with zero errors and warnings.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"34b26f65ac830aad95a423438d3fe0b34b0357c2a23f280ea38581b47cdc4062","checkedAt":"2026-10-31T00:40:21.995Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":66,"reportLanguage":"ru"} -->
