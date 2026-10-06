import type { Socket } from "node:net";

// Covers the existing 45s initialization plus sequential diagnostics fallbacks.
export const LSP_RPC_TIMEOUT_MS = 90_000;
export const LSP_RPC_MAX_BYTES = 1024 * 1024;
export const LSP_RPC_MAX_PENDING = 128;

/** Newline-delimited JSON, bounded before parsing (including unterminated frames). */
export function receiveLspFrames(socket: Socket, receive: (message: any) => void): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) {
        if (buffer.length > LSP_RPC_MAX_BYTES) socket.destroy(new Error("LSP RPC frame too large"));
        return;
      }
      if (newline > LSP_RPC_MAX_BYTES) { socket.destroy(new Error("LSP RPC frame too large")); return; }
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      try { receive(JSON.parse(frame.toString("utf8"))); }
      catch { socket.destroy(new Error("Invalid LSP RPC frame")); return; }
      if (socket.destroyed) return;
    }
  });
}

export function sendLspFrame(socket: Socket, message: unknown): void {
  const frame = JSON.stringify(message) + "\n";
  if (Buffer.byteLength(frame) > LSP_RPC_MAX_BYTES) throw new Error("LSP RPC frame too large");
  if (socket.destroyed) throw new Error("LSP broker disconnected");
  if (socket.writableLength > LSP_RPC_MAX_BYTES * 2) throw new Error("LSP RPC backpressure limit");
  socket.write(frame);
}
