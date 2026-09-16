// 16K UTF-16 units encode to at most 48 KiB, below the native 64 KiB limit.
const MAX_INPUT_CHARS = 16 * 1024;

/** Ordered, backpressured writes per PTY; unrelated terminals remain independent. */
export function createTerminalInputWriter(send: (terminalId: string, data: string) => Promise<void>) {
  const tails = new Map<string, Promise<void>>();

  function write(terminalId: string, data: string): Promise<void> {
    const previous = tails.get(terminalId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + MAX_INPUT_CHARS, data.length);
        // Do not turn an astral character into two replacement characters when
        // chunks are serialized separately through JSON/UTF-8 IPC.
        if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1)) && isLowSurrogate(data.charCodeAt(end))) end -= 1;
        await send(terminalId, data.slice(offset, end));
        offset = end;
      }
    });
    const pending = operation.finally(() => {
      if (tails.get(terminalId) === pending) tails.delete(terminalId);
    });
    tails.set(terminalId, pending);
    return pending;
  }

  return { write };
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
