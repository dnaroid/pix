import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { sessionByteLines } from "./session-byte-lines.js";
import { parseSessionRecord } from "./session-record.js";
import { SESSION_TEXT_VERSION } from "./session-text.js";

// Protocol twin in acp/src/search; parity is tested. Only public conversation text.
export const CHUNK_CHARS = 1600;
const MAX_BYTES = 64 * 1024 * 1024;
const hash = text => createHash("sha256").update(text).digest("hex");
const stamp = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export function messageChunks(text) {
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    const content = text.slice(start, end);
    chunks.push({ start, end, text: content, hash: hash(content) });
    start = end;
  }
  return chunks;
}

/** A stable, authenticated active JSONL branch. Never tools, thinking or attachments.
 * Reject incomplete/corrupt/oversized branches, rather than hiding a late reversal. */
export async function readSessionTranscript(root, candidate, signal, onSkip = () => {}) {
  signal.throwIfAborted();
  const path = resolve(candidate.path);
  const skip = (reason, extra = {}) => { onSkip({ sessionId: candidate.id, path, reason, ...extra }); return undefined; };
  let before;
  try { before = await lstat(path); }
  catch (error) { signal.throwIfAborted(); return skip("stat_failed", { code: error.code }); }
  if (!path.endsWith(".jsonl")) return skip("unsupported_extension");
  if (before.isSymbolicLink()) return skip("symbolic_link");
  if (!before.isFile()) return skip("not_regular_file");
  if (before.nlink !== 1) return skip("multiple_hard_links");
  if (before.size > MAX_BYTES) return skip("file_exceeds_64_mib");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const nodes = new Map();
  let header, leaf, name = "";
  const digest = createHash("sha256").update(SESSION_TEXT_VERSION).update("\n");
  let stream;
  try {
    if (stamp(await file.stat()) !== stamp(before)) return skip("file_changed");
    // Bound the actual read, not just the initial stat, if a writer appends.
    stream = file.createReadStream({ autoClose: false, signal, end: MAX_BYTES });
    let lineNumber = 0;
    for await (const { line, byteOffset, byteLength } of sessionByteLines(stream, signal)) {
      lineNumber++;
      signal.throwIfAborted();
      if (!line.trim()) continue;
      digest.update(line).update("\n");
      const parsed = await parseSessionRecord(line, signal);
      signal.throwIfAborted();
      if (parsed.reason) return skip(parsed.reason, { line: lineNumber });
      const entry = parsed.entry;
      if (!header) {
        if (entry.type !== "session") return skip("missing_session_header", { line: lineNumber });
        if (entry.id !== candidate.id) return skip("session_id_mismatch", { line: lineNumber });
        if (typeof entry.cwd !== "string" || resolve(entry.cwd) !== resolve(root)) return skip("workspace_mismatch", { line: lineNumber });
        header = entry;
        continue;
      }
      if (typeof entry.id !== "string" || !(entry.parentId === null || typeof entry.parentId === "string")
        || nodes.has(entry.id)) return skip("invalid_or_duplicate_entry", { line: lineNumber });
      if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name.trim();
      nodes.set(entry.id, { parent: entry.parentId, message: entry.message && { ...entry.message, byteOffset, byteLength }, line: lineNumber });
      leaf = entry.id;
    }
    if (!header) return skip("empty_transcript");
    if (stamp(await file.stat()) !== stamp(before)
      || stamp(await lstat(path)) !== stamp(before)) return skip("file_changed");
  } finally {
    stream?.destroy(); await file.close();
  }
  const messages = [], seen = new Set();
  let cursor = leaf;
  while (cursor) {
    if (seen.has(cursor)) return skip("cyclic_parent_chain");
    if (!nodes.has(cursor)) return skip("missing_parent", { parentId: cursor });
    seen.add(cursor);
    const node = nodes.get(cursor);
    if (node.parent !== null && !nodes.has(node.parent)) {
      return skip("missing_parent", { line: node.line, entryId: cursor, parentId: node.parent });
    }
    if (node.message) messages.push(node.message);
    cursor = node.parent;
  }
  messages.reverse();
  const firstMessage = messages.find(message => message.role === "user")?.text.slice(0, 4096) ?? "";
  return { id: candidate.id, path, cwd: resolve(root), name, firstMessage,
    title: name || firstMessage.slice(0, 140) || candidate.id,
    fileStamp: stamp(before), revision: digest.digest("hex"), head: leaf ?? "", messages,
    chunks: messages.flatMap((message, ordinal) => messageChunks(message.text).map(chunk => ({ ...chunk,
      messageId: message.id, ordinal, role: message.role, status: message.status,
      byteOffset: message.byteOffset, byteLength: message.byteLength, active: true }))) };
}

/** The validated file incarnation is unchanged; callers still rank a fresh parse.
 * Avoid reparsing megabytes of unrelated history after every small paid batch. */
export async function transcriptUnchanged(snapshot, signal) {
  signal.throwIfAborted();
  const current = await lstat(snapshot.path).catch(() => undefined);
  signal.throwIfAborted();
  return Boolean(current?.isFile() && !current.isSymbolicLink() && current.nlink === 1
    && stamp(current) === snapshot.fileStamp);
}

/** Entire downstream suffix or an explicit gap notice: never silently drop late instructions. */
export function sessionContext(snapshot, messageId, budget = 28000) {
  const index = messageId ? snapshot.messages.findIndex(m => m.id === messageId) : 0;
  if (index < 0) return undefined;
  const messages = snapshot.messages.slice(Math.max(0, index - 1));
  const text = messages.map(m => `[${m.role} message=${m.id} status=${m.status}]\n${m.text}`).join("\n\n");
  if (text.length > budget) return "INCOMPLETE SESSION CONTEXT: the entire downstream branch exceeds the evidence budget. No conversation excerpt is supplied. Do not infer a current or final decision from this source; ask to narrow the question/session.";
  return `Active branch head=${snapshot.head}. Chronological downstream context; earlier messages may be omitted. Assistant reports are not independent proof of executed changes.\n${text}`;
}
