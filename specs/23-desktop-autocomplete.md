# Spec: Desktop prompt autocomplete

## Type

Change

## Goal

Give Pix Desktop the same best-effort LLM prompt autocomplete behavior as the TUI without mutating the active conversation.

## Scope

- Reuse the Pix `autocomplete` configuration and configured provider credentials.
- Request completions through a private ACP extension method backed by `ModelRuntime`, not `session/prompt`.
- Debounce eligible drafts, cancel superseded requests, and ignore stale responses.
- Render the returned suffix as muted inline ghost text in the composer.
- Accept the current suffix with Tab and dismiss it with Escape.
- Keep attachment, submission, and native textarea editing behavior intact.

## Non-goals

- Exposing autocomplete settings in the desktop status bar.
- Completing slash commands, shell commands, selections, or drafts whose caret is not at the end.
- Surfacing transient model, authentication, timeout, or transport errors while the user types.
- Changing TUI autocomplete behavior or configuration defaults.

## Behavior

- Autocomplete is disabled when `autocomplete.modelRef` is empty.
- A request starts after the configured debounce only for an active session, no attachments, a collapsed selection at the end, at least three non-whitespace characters, and a draft not starting with `/` or `!`.
- The ACP request carries the active session id and exact draft. The agent may read recent active-session user/assistant messages according to `includeRecentMessages`, but never sends a normal session prompt.
- The completion uses the configured model, timeout, output-token limit, prompt budget, and optional thinking suffix.
- Changing the session, draft, selection, attachment state, or eligibility cancels pending work and clears the ghost suffix.
- Late or failed requests cannot replace the current suggestion and do not show an application error.
- Tab appends the visible suffix, keeps focus in the textarea, and does not move focus. Escape clears it. Enter continues to submit normally.
- Ghost text mirrors textarea wrapping and scrolling, is not announced as editable content, and a screen-reader status announces that Tab can accept it.

## Related files

- `acp/src/acp/autocomplete.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/autocomplete.ts`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/App.svelte`

## Verification

- ACP tests cover request parsing, active-session routing, history access, completion output, and request cancellation.
- Desktop tests cover eligibility, debounce, stale/cancelled requests, dismissal, acceptance, and ACP cancellation.
- `npm --prefix acp run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm run check`

## Evidence

- Confirmed by code: TUI autocomplete uses `ModelRuntime.streamSimple`, Pix autocomplete config, suffix cleanup, debounce, timeout, and abort/stale-result protection.
- Confirmed by SDK types: ACP custom request handlers receive an abort signal and `$/cancel_request` aborts it.
- Confirmed by desktop structure: the composer owns caret, selection, keyboard, resize, and scroll behavior while `App.svelte` owns the ACP client and active-session identity.
