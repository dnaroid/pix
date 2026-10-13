/** Host-neutral lifecycle wrapper for the shell and Desktop native bridge. */
export async function runManagedIndex(control, source, signal, run, settingsDigest, heartbeatMs = 5000) {
  signal.throwIfAborted();
  const started = await control({ action: "begin", source, settingsDigest });
  if (!started.accepted || !started.token) throw new Error("Could not own manual indexing run");
  const owner = new AbortController();
  let stopping;
  const abort = () => {
    owner.abort();
    stopping ??= control({ action: "stop", source, token: started.token }).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let pending, result;
  const beat = () => {
    if (pending) return pending;
    pending = control({ action: "heartbeat", source, token: started.token }).then(reply => {
      if (!reply.accepted || reply.stop) owner.abort();
    }, () => owner.abort()).finally(() => { pending = undefined; });
    return pending;
  };
  const timer = setInterval(beat, heartbeatMs);
  try {
    owner.signal.throwIfAborted();
    result = await run(owner.signal, async () => { await beat(); owner.signal.throwIfAborted(); });
    owner.signal.throwIfAborted();
  } finally {
    clearInterval(timer);
    await pending;
    await stopping;
    try {
      const finished = await control({ action: "finish", source, token: started.token, settingsDigest,
        result, cancelled: owner.signal.aborted });
      if (result && !owner.signal.aborted) {
        if (!finished.accepted) throw new Error("Manual indexing ownership expired; coverage unverified");
        // Preserve a useful backend diagnostic, but never override shared cancellation.
        result = { ...result, ...finished.result,
          ...(finished.state === "partial" && result.message ? { message: result.message } : {}) };
        if (finished.state === "cancelled") owner.abort();
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await stopping;
    }
  }
  owner.signal.throwIfAborted();
  return result;
}
