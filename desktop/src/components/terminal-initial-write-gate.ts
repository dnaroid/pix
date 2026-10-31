/**
 * Orders a terminal's one-time initial replay before live output.
 *
 * The replay snapshot is captured when xterm is attached, but written after the
 * first fit frame so it renders at the real geometry. Live chunks that arrive in
 * between are already absent from that snapshot, so they are queued and written
 * after it instead of being dropped or duplicated.
 */
export function createTerminalInitialWriteGate(sink: (data: string) => void) {
  let opened = false;
  let pending: string[] = [];

  return {
    write(data: string): void {
      if (!data) return;
      if (opened) sink(data);
      else pending.push(data);
    },
    /** Writes the captured snapshot, then any live chunks queued since it was taken. Idempotent. */
    open(initialContent: string): void {
      if (opened) return;
      opened = true;
      const queued = pending;
      pending = [];
      if (initialContent) sink(initialContent);
      for (const chunk of queued) sink(chunk);
    },
  };
}

export type TerminalInitialWriteGate = ReturnType<typeof createTerminalInitialWriteGate>;
