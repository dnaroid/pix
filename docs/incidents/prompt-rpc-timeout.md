# Deferred investigation: prompt RPC acknowledgement timeout

Status: observed once in a user report; root cause unknown; investigate on recurrence.
No runtime fix or retry-policy change was made for this report.

## Symptom

Pix displayed:

```text
pi prompt failed: Error: Timeout waiting for response to prompt. Stderr:
at Timeout._onTimeout (.../acp/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js:465:24)
```

The screenshot contained no child-process stderr detail after `Stderr:`.
No incident logs or reproduction were collected, so the initiating action,
preflight duration, and eventual outcome of the original prompt are unknown.

## Verified code path at triage

Inspected installed SDK version: `@earendil-works/pi-coding-agent` **1.0.2**.
Recheck these implementation details against the installed version on recurrence.

- SDK `dist/modes/rpc/rpc-client.js`, `send`: pending RPC commands time out
  after **30,000 ms**. Timeout removes the pending request and rejects its
  promise; it does not itself abort the child-side prompt.
- SDK `dist/modes/rpc/rpc-mode.js`, `prompt` handler: successful acknowledgement
  is emitted through `preflightResult`, after prompt preflight succeeds.
  This is not a timeout measuring the complete model turn.
- `acp/src/pi/pi-rpc-client.ts`, `PiRpcClient.prompt`: forwards to SDK
  `RpcClient.prompt` without a retry loop.
- `acp/src/acp/pix-acp-agent.ts`: the prompt catch clears the matching
  `activeRun` and propagates `pi prompt failed` to the client.
- SDK `dist/core/agent-session.js`, `_isRetryableError` / `_prepareRetry`:
  model-error retries are a separate mechanism and do not wrap this RPC timeout.
  The retry UI contract in [retry-toast-action](../../specs/retry-toast-action.md)
  must not be read as coverage for RPC acknowledgement failures.

The observed error originates at the local Pix/SDK-to-Pi RPC boundary.
It does **not** establish whether the underlying delay was local, an extension
waiting for external work, or another cause. Slow input hooks/preflight and an
unresponsive child are investigation hypotheses, not diagnosed causes.

## On recurrence

1. Preserve timestamp, session ID, initiating action (ordinary prompt or slash
   command), model/provider, SDK version, and enabled extensions. Redact secrets
   and private prompt content from shared evidence.
2. Collect ACP/child logs around the event, including stderr, process exit
   signals, and any subsequent agent events. Record whether the original prompt
   continues or produces output after the error, before sending it again.
3. Trace RPC request ID, command write, preflight/input-hook start and finish,
   acknowledgement, and agent start/end. If instrumentation is missing, add
   bounded diagnostics to distinguish blocked preflight from transport failure.
4. Check late acknowledgement and event handling after `activeRun` is cleared:
   session state, UI state, cancellation, and the next prompt must remain coherent.
5. Reproduce with delayed preflight and with child failure before choosing a fix.
   Add deterministic coverage for timeout, late completion, cancellation, and
   absence of duplicate execution.

## Safety constraint for a future fix

Do not blindly resend `prompt`: a client-side timeout is not proof that the
child rejected or stopped the first request. A retry could execute the task
twice. First settle acknowledgement semantics and reconciliation/cancellation
of in-flight work; merely increasing the timeout is not a root-cause diagnosis.
