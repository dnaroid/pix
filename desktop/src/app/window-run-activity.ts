// Serialize IPC writes and coalesce intermediate activity updates. An older
// completion must never overwrite the current native close-warning state.
export function createWindowRunActivitySync(
  write: (running: boolean) => Promise<unknown>,
  reportError: (error: unknown) => void,
) {
  let pending: boolean | undefined;
  let writing = false;
  let disposed = false;

  async function flush() {
    writing = true;
    try {
      while (!disposed && pending !== undefined) {
        const running = pending;
        pending = undefined;
        await write(running);
      }
    } catch (error) {
      if (!disposed) reportError(error);
    } finally {
      writing = false;
      if (!disposed && pending !== undefined) void flush();
    }
  }

  return {
    update(running: boolean) {
      if (disposed) return;
      pending = running;
      if (!writing) void flush();
    },
    dispose() { disposed = true; pending = undefined; },
  };
}
