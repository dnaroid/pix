---
kind: spec
status: active
---

# Claude Code provider attachment-read recovery

## Behavior

Pix maintains recovery directly in the local suite Claude Code provider,
derived from `pi-claude-code-provider@0.5.0`. If Claude proposes only `Read`/`read` calls with
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

There is no patch installer or mutable npm source dependency. Recovery ships as
normal maintained source. Upstream updates require review and rerunning the
offline lifecycle/regression matrix; see [local provider](claude-code-provider.md).

## Implementation

- `external/pi-tools-suite/src/claude-code-provider/src/image-read-recovery.ts`
- `external/pi-tools-suite/src/claude-code-provider/src/provider.ts`

## Tests

- `external/pi-tools-suite/test/claude-code-provider/image-read-recovery.test.ts`
- `external/pi-tools-suite/test/claude-code-provider/image-read-provider.test.ts`

## Verification

Run `bun test external/pi-tools-suite/test/claude-code-provider`.
These always-on regressions use fake Claude CLI protocol output and the real
local provider/process/image-store code without credentials, network calls,
quota consumption or actual Pi tools. Also run the imported upstream unit tests
and suite source typecheck against the installed SDK.
