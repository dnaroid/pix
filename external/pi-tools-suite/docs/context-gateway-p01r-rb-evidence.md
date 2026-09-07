# Context Gateway P01-R / R-B evidence

<!-- markdownlint-disable MD013 -->

> Date: 7 September 2026.
> Repository HEAD during deterministic gate: `daa1b06` with an explicitly dirty tested source tree.
> Installed Pi SDK: `@earendil-works/pi-coding-agent` `0.85.1`.
> Scope: storeless result-pipeline ordering and optional truncation-metadata cleanup. No durable store, Gateway enforce mode, DCP redesign or live model run was introduced here.

## Result

R-B is complete for the currently claimed storeless combinations. The optional
`truncation-metadata-normalizer` remains disabled by default and returns only a
`details` patch. Context Gateway `off`/`observe` semantics remain unchanged.

The verified result order is:

1. LSP/comment result enrichment;
2. passive Context Gateway observe;
3. optional truncation metadata normalization;
4. downstream result observers/modifiers;
5. opt-in credential-firewall session-hygiene redaction.

For provider hooks the credential firewall runs before the final
`codex-reasoning-fix` sanitizer, which remains last in `MODULES`.

No suite-local result coordinator was added. The ADR now treats a coordinator as
conditional future enforce/store work only if an actual enabled-handler conflict
cannot be expressed safely through the tested event-specific order.

## Normalizer scope and invariants

The normalizer is restricted to the measured `Read`/shell/`ast_grep` names and a
complete SDK truncation shape. It removes only `details.truncation.content` when
that string is a prefix of the actually delivered text. It preserves the rest of
the truncation fields and any native `fullOutputPath`.

Deterministic contracts cover:

- actual installed SDK `Read` and `Bash` truncation results;
- the real suite `ast_grep` truncation result and its native full-output handle;
- `bash` / `shell` / `shell_command` aliases;
- Unicode duplicate text and multipart text + image content;
- idempotence and no mutation of the original content/details objects;
- no-op for unknown tool names, malformed shapes and non-matching metadata;
- collapsed/expanded rendering equivalence for installed Bash, installed Read and suite `ast_grep` renderers;
- persisted JSONL removal of the duplicate metadata copy while structural fields remain;
- an exactly equal checked OpenAI-completions provider payload before/after metadata normalization.

The generic `tool_result` event cannot prove that a separately loaded replacement
using the same measured tool name and exact SDK-looking shape is the original SDK
definition. The ADR therefore marks same-name replacement provenance as limited;
name+shape is not promoted to a strict-enforce trust primitive.

## Result/security composition

An executable installed `ExtensionRunner` contract uses an enrichment stage,
Context Gateway observe, the normalizer, a DCP-free fake downstream observer and
the real credential firewall. It proves that:

- tool call ID observed downstream is unchanged;
- `content`, image parts, `isError`, usage and structural completeness metadata survive normalization;
- enrichment diagnostics survive until the later firewall;
- the downstream observer sees normalized metadata before firewall redaction;
- with session hygiene enabled, synthetic secrets are removed from final result content/details without restoring the deleted duplicate;
- with session hygiene disabled, visible content is not redacted while metadata-only normalization still occurs;
- the input result object itself is not mutated.

A headless AgentSession contract separately proves that the normalized/redacted
result, rather than the earlier secret-bearing result, is what reaches JSONL and
the next model context. The provider-hook contract proves that credential
redaction followed by the final Codex sanitizer neither restores the secret nor
restores rejected reasoning/prompt-cache fields.

Tool-result `details` bytes are therefore reported as JSONL/metadata overhead,
not as provider-token savings. The checked OpenAI-completions serializer already
omits tool-result details.

## Deterministic gate

```text
bun test test/context-gateway \
  test/evals/recovery-corpus.test.ts \
  test/evals/recovery-run-identity.test.ts \
  test/evals/recovery-report.test.ts \
  test/evals/recovery-validation.test.ts \
  test/evals/harness.test.ts \
  test/config.test.ts \
  test/evals/extension-contracts.test.ts
```

Result: **88 pass, 0 fail, 667 assertions**.

Additional checks:

- `npm run typecheck` — pass.
- `git diff --check` — pass.

No manual suite sync was run; the user-owned watcher remains the synchronization
mechanism and is not evidence of which bytes a future live run loads.
