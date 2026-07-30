# Spec: Bind session extensions before prompting

## Type

Change

## Goal

Prevent the first user prompt from bypassing extension input handlers while a new active session is still binding extensions.

## Scope

- Wait for the active runtime's current extension bind before calling `AgentSession.prompt()`.
- Preserve existing prompt, steering, queue, and background-session behavior.

## Non-goals

- Backfilling extension events after a prompt was already persisted.
- Generating titles from later prompts in an existing unnamed session.

## Behavior

1. A prompt targeting the active runtime waits for its current extension bind to settle.
2. `AgentSession.prompt()` is not called before that wait completes.
3. A prompt targeting a non-active session does not wait on the active runtime's bind.
4. Existing prompt options and queue handling remain unchanged.

## Related files

- `src/app/session/queued-message-controller.ts`
- `src/app/session/session-lifecycle-controller.ts`
- `src/app/app.ts`
- `tests/queued-message-controller.test.ts`

## Verification

- Regression test holds extension binding open and verifies the first prompt remains blocked.
- `npm run check`

## Risks / unknowns

- A failed extension bind now rejects the prompt submission instead of allowing the prompt to bypass extensions.

## Evidence

- Confirmed by code: session binding may be deferred by one event-loop turn, and prompt submission previously did not await it.
- Confirmed by tests: the queued-message controller waits for extension readiness before invoking `prompt()`.
