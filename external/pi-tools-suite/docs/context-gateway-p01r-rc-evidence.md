# Context Gateway P01-R / R-C evidence

<!-- markdownlint-disable MD013 -->

> Date: 7 September 2026.
> Repository HEAD during deterministic gate: `daa1b06` with a dirty tested tree.
> Installed Pi SDK: `@earendil-works/pi-coding-agent` `0.85.1`.
> Scope: native paging/current-view semantics and temporary full-output lifetime. No durable snapshot, artifact reader, shell rewrite or live model call was added.

## Read is a current decoded text view, not a snapshot reader

Installed SDK `Read` uses 1-based line `offset`/`limit` over `Buffer.toString("utf-8").split("\n")`.
R-C contracts verify:

- CRLF and Unicode survive relative to that decoded SDK text view;
- explicit `limit` produces an actionable next line offset;
- empty files and EOF/out-of-range offsets are distinguishable;
- a very large limit does not create a separate byte pagination protocol;
- a single line larger than the SDK byte limit is an honest **limited** case: the result points at a shell fallback and does not fabricate `Use offset=` recovery;
- the Read schema exposes no `byteOffset` or generic cursor;
- re-executing the same path after the source changes returns the new file view. Same path/offset is therefore not an immutable historical snapshot.

This project does not claim byte-for-byte source-file coordinates beyond the SDK's decoded text semantics.

## Repo Native Compact cursors are current-index cursors

The checked native cursor surface exists only on `repo_structure` and `repo_ast`.
`repo_search` has no cursor flag in the current wrapper policy and is not described as if it did.

R-C tightens integer native flags to `Number.isSafeInteger`: negative or unsafe integer cursors are refused before `idx`. Re-running the same `repo_structure --cursor 20` executes `idx` again; a deterministic fake backend returning version 1 and then version 2 produces two different results for the same cursor. The cursor is therefore a continuation token for current backend/index state, not a snapshot identifier.

No command execution is suppressed because args/cursor match an earlier call.

## Successful temp output versus error paths

For a successful large built-in Bash result, the installed SDK returns a structured `details.fullOutputPath`. The file contains the complete emitted output and a normal Read can recover an omitted head fact.

The same path has no durability guarantee. The test replaces its contents and a later Read sees the replacement; after deletion a later Read fails. A native temp path is thus an ephemeral current file handle, not historical snapshot identity.

Bash timeout, abort and non-zero exit preserve their visible status and captured visible output but reject the tool execution. The current exception bridge does not expose a structured `fullOutputPath` result. SDK-formatted error text may itself mention its generated temp path when the partial output was truncated; R-C does **not** parse such text into a trusted capability, because look-alike paths in arbitrary text are not authorization/provenance.

The suite `ast_grep` path behaves similarly but is suite-owned: successful truncated output returns a structured full-output handle containing the complete combined output. Cancelled/killed output returns an explicit cancelled result without a full-output handle, and a real tool error throws instead of publishing a successful artifact capability.

## Broad-output decision

R-C does not introduce another generic cap for built-in Read or rewrite user shell commands. Current evidence already shows successful native recovery for ordinary line-based Read and successful Bash/ast-grep temp-output cases, while long single-line Read and error-path handles remain explicitly limited.

For repo tools the existing opt-in Native Compact profile remains the only new scope/budget enforcement: narrow native defaults, explicit same-call bounded `outputMode=full`, and current-index cursors where the backend exposes them. Search without a native cursor is not given a synthetic one.

A stricter broad-read/search delivery policy requires a demonstrated task where its required facts remain recoverable under the claimed mechanism. Until then small/exact/instruction reads and shell execution stay unchanged.

## Deterministic gate

```text
bun test \
  test/context-gateway/native-recovery-contracts.test.ts \
  test/repo-native-compact.test.ts \
  test/context-gateway/capture-contracts.test.ts \
  test/context-gateway/sdk-pipeline.test.ts
```

Result: **46 pass, 0 fail, 352 assertions**.

Additional checks:

- `npm run typecheck` — pass.
- `git diff --check` — pass.

Session-history recovery remains plan 32 work. R-C creates neither `artifact_read` nor a catalog and makes no resume/export guarantee for native temp files or current-index cursors.
