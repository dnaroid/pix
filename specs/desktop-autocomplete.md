# Desktop prompt autocomplete

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Give Pix Desktop the same best-effort LLM prompt autocomplete behavior as the TUI without mutating the active conversation.

## Scope

- Reuse the Pix `autocomplete` configuration, including its ordered `fallbackModels`, and configured provider credentials.
- Request completions through a private ACP extension method backed by `ModelRuntime`, not `session/prompt`.
- Debounce eligible drafts, cancel superseded requests, and ignore stale responses.
- Render the returned suffix as muted inline ghost text in the composer.
- Accept the current suffix with Tab and dismiss it with Escape.
- Keep attachment, submission, and native textarea editing behavior intact.

## Non-goals

- Exposing autocomplete settings in the desktop status bar.
- Completing slash commands, shell commands, selections, or drafts whose caret is not at the end.
- Surfacing transient model, authentication, timeout, or transport errors while the user types.
- Changing autocomplete eligibility, ghost-text UI behavior, or the default primary autocomplete model.

## Behavior

- Autocomplete is disabled when `autocomplete.modelRef` is empty.
- A request starts after the configured debounce only for an active session, no attachments, a collapsed selection at the end, at least three non-whitespace characters, and a draft not starting with `/` or `!`.
- The ACP request carries the active session id and exact draft. The agent may read recent active-session user/assistant messages according to `includeRecentMessages`, but never sends a normal session prompt.
- The completion tries `autocomplete.modelRef` and then `autocomplete.fallbackModels` in order, de-duplicating refs. Each candidate uses the configured timeout, output-token limit, prompt budget, and its optional thinking suffix; cancellation is terminal and does not advance the chain.
- Changing the session, draft, selection, attachment state, or eligibility cancels pending work and clears the ghost suffix.
- Late or failed requests cannot replace the current suggestion and do not show an application error.
- Tab appends the visible suffix, keeps focus in the textarea, and does not move focus. Escape clears it. Enter continues to submit normally.
- Ghost text mirrors the textarea's computed typography, line height, padding,
  wrapping and scrolling rather than relying on parallel CSS defaults. This keeps
  the suffix aligned with the caret across wrapped/multi-line prompts. It is not
  announced as editable content, and a screen-reader status announces that Tab
  can accept it.

## Related files

- `acp/src/acp/autocomplete.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-json-rpc.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/lib/autocomplete.ts`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/prompt-composer-textarea-controller.svelte.ts`
- `desktop/src/app/autocomplete.svelte.ts`
- `desktop/src/app/desktop-session-services.ts`

## Verification

- ACP tests cover request parsing, active-session routing, history access, completion output, and request cancellation.
- Desktop tests cover eligibility, debounce, stale/cancelled requests, dismissal, acceptance, and ACP cancellation.
- `desktop/scripts/autocomplete-ghost-smoke.mjs` checks real Chromium computed
  text metrics for the textarea and ghost overlay.
- `npm --prefix acp run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm run check`

## Evidence

- Confirmed by code: TUI autocomplete uses `ModelRuntime.streamSimple`, Pix autocomplete config, suffix cleanup, debounce, timeout, and abort/stale-result protection.
- Confirmed by SDK types: ACP custom request handlers receive an abort signal and `$/cancel_request` aborts it.
- Confirmed by desktop structure: the composer owns caret, selection, keyboard,
  resize, and scroll behavior; the autocomplete/session services provide the
  ACP request and active-session context through the composition root.
