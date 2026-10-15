import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseSessionRecord } from "./session-record.js";
import { SessionRevisionCatalog, sessionRevisionDigest } from "./session-revisions.js";
import { SessionReadCache } from "./session-read-cache.js";

const stamp = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const regular = s => s?.isFile() && !s.isSymbolicLink() && s.nlink === 1;
const MAX_BYTES = 64 * 1024 * 1024;
const titleCache = new SessionReadCache();
export function nativeSessionDirectory(root, agentDir) {
  return join(agentDir, "sessions", `--${resolve(root).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}
/** Header-only identity discovery, cached by file incarnation. Never SDK list(),
 * which parses every message in every file before the idle gate can run. */
export class SessionCandidateCatalog {
  constructor(options) { this.cache = new Map(); this.revisions = new SessionRevisionCatalog(options); }
  dispose() { this.revisions.dispose(); this.cache.clear(); }
  async snapshot(root, agentDir, signal, extraPaths = [], mapping = []) {
    const rows = await this.revisions.list(nativeSessionDirectory(root, agentDir), extraPaths, signal);
    const live = new Set(rows.map(r => r.path));
    const aliases = mapping.filter(r => live.has(resolve(r.piSessionPath)))
      .map(r => [resolve(r.piSessionPath), r.sessionId, r.piSessionId, r.namedTitle, r.title]).sort();
    return sessionRevisionDigest(["sessions-created-24h-v1", rows.map(r => [r.path, r.createdAt, r.revision]), aliases]);
  }
  async list(root, agentDir, signal, extraPaths = []) {
    signal.throwIfAborted();
    const rows = await this.revisions.list(nativeSessionDirectory(root, agentDir), extraPaths, signal);
    const live = new Set(), candidates = [];
    for (const row of rows) {
      signal.throwIfAborted();
      const { path, revision } = row; live.add(path);
      let cached = this.cache.get(path);
      if (cached?.revision !== revision) {
        const info = await lstat(path).catch(e => { if (e.code !== "ENOENT") throw e; });
        if (!regular(info) || stamp(info) !== revision) { this.revisions.invalidate(path); continue; }
        const id = await this.header(root, path, info, signal);
        cached = { revision, id }; this.cache.set(path, cached);
      }
      if (cached.id) candidates.push({ id: cached.id, path, createdAt: row.createdAt });
    }
    for (const path of this.cache.keys()) if (!live.has(path)) this.cache.delete(path);
    signal.throwIfAborted();
    return candidates;
  }
  async header(root, path, before, signal) {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (stamp(await file.stat()) !== stamp(before)) return;
      // Fixed bound even for a corrupt header or a huge attachment on line two.
      const bytes = Buffer.alloc(16 * 1024);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      signal.throwIfAborted();
      const end = bytes.subarray(0, bytesRead).indexOf(10);
      if (end < 0) return;
      let header;
      try { header = JSON.parse(bytes.subarray(0, end).toString("utf8")); } catch { return; }
      if (header?.type !== "session" || typeof header.id !== "string" || !header.id || header.id.length > 4096
        || typeof header.cwd !== "string" || resolve(header.cwd) !== resolve(root)) return;
      if (stamp(await file.stat()) !== stamp(before)) return;
      return header.id;
    } finally { await file.close(); }
  }
}
/** Hydrate saved-title authority for ONE admitted idle session. No synchronous
 * SessionManager.open(), no all-session rediscovery, and no retained transcript. */
export async function readSessionTitle(root, candidate, signal) {
  signal.throwIfAborted();
  const before = await lstat(candidate.path).catch(e => { if (e.code !== "ENOENT") throw e; });
  if (!regular(before) || before.size > MAX_BYTES) return;
  signal.throwIfAborted();
  const cacheKey = JSON.stringify([resolve(root), candidate.id, candidate.path]);
  const cached = titleCache.get(cacheKey, stamp(before));
  if (cached) return { ...candidate, ...cached };
  const file = await open(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let stream, lines;
  try {
    if (stamp(await file.stat()) !== stamp(before)) return;
    stream = file.createReadStream({ encoding: "utf8", autoClose: false, signal, end: MAX_BYTES });
    lines = createInterface({ input: stream, crlfDelay: Infinity });
    let header, name, firstMessage = "";
    for await (const line of lines) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      // Only the first public user message and saved session_info names belong
      // to title discovery. The remaining message/tool payloads are validated
      // by transcript indexing; parsing them here can take longer than the
      // entire discovery budget for a large project.
      if (header && firstMessage && !line.includes("session_info")) continue;
      const parsed = await parseSessionRecord(line, signal);
      if (parsed.reason) return;
      const entry = parsed.entry;
      if (!header) {
        if (entry.type !== "session" || entry.id !== candidate.id || typeof entry.cwd !== "string"
          || resolve(entry.cwd) !== resolve(root)) return;
        header = entry;
      } else {
        if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
        if (!firstMessage && entry.message?.role === "user") firstMessage = entry.message.text;
      }
    }
    const after = await lstat(candidate.path).catch(() => undefined);
    signal.throwIfAborted();
    if (!header || !regular(after) || stamp(after) !== stamp(before) || stamp(await file.stat()) !== stamp(before)) return;
    const snapshot = { name, firstMessage, fileStamp: stamp(before) };
    titleCache.set(cacheKey, stamp(before), snapshot);
    return { ...candidate, ...snapshot };
  } finally { lines?.close(); stream?.destroy(); await file.close(); }
}
