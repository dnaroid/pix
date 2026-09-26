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
- If the user selects another session while draft materialization is pending,
  the original composer draft is restored before switching owners so it remains
  available when the user returns to the draft. Any late ACP session created by
  the abandoned materialization is closed and must not replace the selected
  session.
- Successful materialization must adopt the optimistic transcript rather than
  replacing it with an empty transcript.

## Implementation

- `desktop/src/app/prompt-submit.ts::createPromptSubmit`
- `desktop/src/app/draft-session.svelte.ts::createDraftSession`
- `desktop/src/app/desktop-prompt-action-services.ts::createDesktopPromptActionServices`
- `desktop/src/app/desktop-session-transition-services.ts::createDesktopSessionTransitionServices`
- `desktop/src/app/session-tab-selection.ts::createSessionTabSelection`

## Tests

- `desktop/src/app/prompt-submit.test.ts`
- `desktop/src/app/draft-tab-selection.test.ts`
- `desktop/src/components/DesktopDraftSessionConcurrency.test.ts`

## Verification

- The first draft prompt is visible and the composer is empty while the
  materialization promise is still unresolved.
- After successful materialization, the prompt request runs once against the
  real session id and the optimistic message remains in the transcript.
- Failed or abandoned materialization restores draft input without leaking a
  late-created session into the active workbench.
- Desktop Svelte/TypeScript checks complete with zero errors and warnings.
