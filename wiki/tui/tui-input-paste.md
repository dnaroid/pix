---
kind: spec
status: active
---

# TUI input paste classification

## Behavior

At the start of an empty editor, a single-line unquoted `/name` (optionally
followed by space/tab-separated arguments) is command text, not a dropped file.
Names start with an ASCII letter and continue with letters, digits, underscores,
hyphens or colons. This applies to plain terminal chunks and bracketed paste,
including extension commands such as `/pi-claude-code-provider-doctor`.
Plain chunks follow normal synchronous editor handling; bracketed command paste
is inserted verbatim. Neither adds quotes or submits the command automatically.

File-shaped text still uses path insertion: nested absolute paths, paths with
extensions, quoted paths, `file://` URLs, and paths pasted after existing prompt
text. File paths inside the working directory become relative; inserted paths
are quoted. A root-level file whose name looks like a command can be pasted with
explicit quotes or a `file://` prefix.

## Constraints and failure cases

Command syntax takes precedence without filesystem probes or command-registry
lookups, including before extensions finish loading. Unknown commands retain
normal command-dispatch behavior. Newline-containing chunks retain multiline
paste handling; text plus Enter must not be sent as a single paste to execute a
command. Asynchronous path insertion and bracketed paste must not land in a
different active input scope. Classification does not bypass those guards.

## Implementation

- `src/app/input/input-paste-handler.ts`
- `src/app/input/input-controller.ts`
- `src/input-editor-files.ts`

## Tests

- `tests/input-paste-handler.test.ts`
- `tests/input-controller.test.ts`

## Verification

Run the input paste and controller tests. In the real TUI, enter the provider
doctor command after startup: the editor must show the command without quotes,
and a separate Enter must invoke the command rather than submit a model prompt.
