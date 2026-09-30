---
kind: spec
status: active
---

# Claude Code provider attachment-read recovery

## Behavior

Pix carries an explicitly applied local compatibility patch for npm
`pi-claude-code-provider@0.5.0`. If Claude proposes only `Read`/`read` calls with
one `file_path`/`path` argument equal to an image attachment in the **current
effective payload**, the adapter rejects the proposal internally and retries
once with a system instruction to inspect already attached images directly.
No Pi tool executes during recovery. Historical images still present in the
effective context qualify; images introduced by `onPayload` qualify too.

Image-bearing attempts buffer their stream until validation and finalization;
rejected proposals and first-attempt text never reach Pi's transcript. Text-only
requests preserve live streaming. Accepted second-attempt tools are published
normally. Buffered failures publish a coherent terminal snapshot without tool
calls, not stale progress indices. Token and cost accounting includes both
attempts; underlying request metrics remain per subprocess.

## Constraints and failure cases

Recovery requires verified process death, an accepted provider-terminated exit,
successful private-request cleanup, and no MCP execution marker. A second bad
proposal fails explicitly; arbitrary private paths, shell commands, nested or
extra arguments, mixed image/non-image proposals and unknown attachments never
qualify. Existing private-state and MCP guards are not relaxed.

The original session resolution is reused across attempts. Each attempt leases
its image store; the prior attempt fully finalizes before the next acquires its
lease. Session shutdown must not redirect the retry into a newly started session.
Abort or an exhausted timeout prevents retry. Retry launch uses the remaining
original monotonic timeout budget, subtracting preparation time; cleanup still
must finish even after the budget is exhausted. Payload/response hooks run once
per attempt, following the upstream lifecycle. This is a bounded recovery, not a
guarantee that Claude can interpret any image.

The installer accepts only the characterized 0.5.0 `provider.ts` SHA256, preserves
the original source, installs the recovery module before atomically replacing its
importer, and refuses to overwrite unrelated edits or different versions. It is
serialized with an exclusive installer lock; temporary file names are unique
and their contents are flushed before rename. Recovery-module edits are also
protected. A stale lock after a killed installer requires checking its recorded
PID is no longer running before manual removal. The two-file install is not a
transactional filesystem operation; `--check` detects incomplete installation.
It is explicit, not automatically applied at startup. An npm reinstall/update can
remove the local patch; restart Pi after applying it. Future provider versions
require a fresh review rather than bypassing the version/source checks.

## Implementation

- `patches/claude-image-read/image-read-recovery.ts`
- `scripts/claude-image-read-patch.mjs`

## Tests

- `tests/claude-image-read-recovery.test.ts`
- `tests/claude-image-read-provider.test.ts`

## Verification

Run `node --import tsx --test --test-reporter=tap tests/claude-image-read-recovery.test.ts`.
For subprocess simulations, set `PIX_CLAUDE_PROVIDER_TEST_DIR` to a patched
upstream 0.5.0 checkout whose dependencies resolve to the installed Pi SDK, then
run the same command with `tests/claude-image-read-provider.test.ts`. The opt-in
suite uses fake Claude CLI protocol output and real provider/process/image-store
code without credentials, network calls, quota consumption or actual Pi tools.
Also run upstream provider unit tests and typecheck against the installed SDK.

Apply with `node scripts/claude-image-read-patch.mjs <provider-directory>`;
verify with `node scripts/claude-image-read-patch.mjs --check <provider-directory>`.
