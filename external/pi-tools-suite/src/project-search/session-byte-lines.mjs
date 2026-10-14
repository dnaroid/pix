/** Byte-exact JSONL record spans, including LF/CRLF. Never confuse UTF-16 text
 * offsets with file offsets (JSON escaping and attachments change both). */
export async function* sessionByteLines(stream, signal) {
  let parts = [], length = 0, offset = 0;
  for await (const buffer of stream) {
    signal.throwIfAborted();
    let start = 0;
    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
      const part = buffer.subarray(start, end + 1);
      parts.push(part); length += part.length;
      const bytes = Buffer.concat(parts, length);
      yield { line: bytes.toString("utf8").replace(/\r?\n$/u, ""), byteOffset: offset, byteLength: length };
      offset += length; parts = []; length = 0; start = end + 1;
    }
    if (start < buffer.length) { parts.push(buffer.subarray(start)); length += buffer.length - start; }
  }
  if (length) yield { line: Buffer.concat(parts, length).toString("utf8"), byteOffset: offset, byteLength: length };
}
