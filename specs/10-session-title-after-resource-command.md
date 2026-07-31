# Spec: Name sessions after a leading resource command

## Type

Change

## Goal

Generate a session title from the first regular user request when a new session starts with a skill or prompt resource slash command.

## Scope

- Remember that the title extension skipped a leading resource slash command in the current new session.
- Allow the next non-slash user input to generate the title even though the expanded resource command is already persisted as a user message.
- Preserve the existing rule that arbitrary existing unnamed sessions are not renamed from later prompts.

## Non-goals

- Naming a session from the resource command or its expanded contents.
- Backfilling titles for previously persisted unnamed sessions.
- Changing SDK skill or prompt-template expansion.

## Behavior

1. A leading resource slash command does not itself generate a title.
2. The first subsequent regular user input generates the provisional and model title normally.
3. An unnamed resumed session with a prior regular user request remains unchanged by later prompts.
4. Deferred title eligibility is session-local and resets on session replacement or shutdown.

## Related files

- `src/bundled-extensions/session-title/index.ts`
- `tests/session-title.test.ts`

## Verification

- Regression test reproduces `/skill:...` expansion being present in the branch before the first regular prompt.
- Existing resumed-session and fork title tests continue to pass.
- `npm run check`

## Risks / unknowns

- The extension input event identifies resource invocations only by their leading slash; Pix validates resource commands before forwarding them to `AgentSession.prompt()`.
- Reloading or restarting between the resource command and the regular request intentionally loses the transient eligibility state.

## Evidence

- Confirmed by persisted sessions: both recent unnamed sessions started with an expanded `<skill>` user message and received the actual task as the next user message.
- Confirmed by SDK code: the `input` event receives the original slash command before skill/template expansion and persistence.
- Confirmed by Pix code: resource commands are forwarded through the normal queued-message prompt path after command validation.
