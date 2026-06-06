/**
 * Jsonl reader + writer for the dispatcher.
 *
 * We split incoming bytes on `\n` only (NOT using readline, which also splits
 * on U+2028 / U+2029 — see SDK rpc.md "Framing" notes).
 */

import { StringDecoder } from "node:string_decoder";

export type LineHandler = (line: string) => void;

/** Attach a strict-LF line reader to a binary/utf8 stream. Returns a detach fn. */
export function attachJsonlLineReader(stream: NodeJS.ReadableStream, onLine: LineHandler): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let detached = false;

  const onData = (chunk: Buffer | string): void => {
    if (detached) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  };

  const onEnd = (): void => {
    if (detached) return;
    buffer += decoder.end();
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
    buffer = "";
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    if (detached) return;
    detached = true;
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

/** Serialize a value as a single JSON line with trailing `\n`. */
export function serializeJsonLine(value: unknown): string {
  // JSON.stringify never emits literal newlines (they become \n escapes),
  // so the result is safe to write as one record.
  return JSON.stringify(value) + "\n";
}
