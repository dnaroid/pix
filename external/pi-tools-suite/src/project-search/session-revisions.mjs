import { watch, constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const SESSION_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const SESSION_RECONCILE_MS = 5 * 60 * 1000;
export const sessionFileRevision = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export const sessionRevisionDigest = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
export const regularSessionFile = s => s?.isFile() && !s.isSymbolicLink() && s.nlink === 1;

/** Native filenames encode creation time. For non-native names, creationTime
 * checks the bounded header before falling back to birth time, never mtime. */
export function sessionCreatedAt(filename, info) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)[.-](\d{3})Z_/.exec(basename(filename));
  const encoded = match && Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
  return Number.isFinite(encoded) && encoded > 0 ? encoded
    : Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : undefined;
}
async function creationTime(filename, info, signal) {
  if (/^\d{4}-\d\d-\d\dT/.test(basename(filename))) return sessionCreatedAt(filename, info);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(16 * 1024);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    signal.throwIfAborted();
    if (sessionFileRevision(await file.stat()) !== sessionFileRevision(info)) throw new Error("Session changed during check");
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0) throw new Error("Session creation time unavailable");
    let header;
    try { header = JSON.parse(text.slice(0, newline)); } catch { throw new Error("Session creation time unavailable"); }
    const timestamp = header?.type === "session" && typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : sessionCreatedAt(filename, info);
  } finally { await file.close(); }
}

/** One directory watcher, not one watcher per transcript. Events only mark
 * paths dirty; polls coalesce them. Recovery walks are bounded and metadata-only. */
export class SessionRevisionCatalog {
  constructor({ now = Date.now, watching = true, watchDirectory = watch } = {}) {
    this.now = now; this.watching = watching; this.watchDirectory = watchDirectory;
    this.files = new Map(); this.dirty = new Set(); this.watchers = new Map();
    this.reconcileAt = 0; this.stopped = false; this.generation = 0;
    this.queue = Promise.resolve();
  }
  invalidate(filename) {
    if (this.stopped) return;
    if (!filename) { this.reconcileAt = 0; this.generation++; return; }
    const saved = this.files.get(filename);
    // Young files need only an age deadline. Appends do not move that deadline.
    if (saved?.createdAt && this.now() < saved.createdAt + SESSION_MIN_AGE_MS) return;
    if (this.dirty.size >= 10000) { this.reconcileAt = 0; this.generation++; return; }
    this.dirty.add(filename); this.generation++;
  }
  async observe(directory) {
    if (await realpath(directory) !== directory) throw new Error("Unsafe session directory");
    if (!this.watching || this.watchers.has(directory)) return;
    try {
      const scope = this.scope;
      const watcher = this.watchDirectory(directory, { persistent: false }, (_event, name) => {
        if (scope !== this.scope) return;
        const value = name?.toString();
        if (!value || basename(value) !== value) this.invalidate();
        else if (value.endsWith(".jsonl")) this.invalidate(join(directory, value));
      });
      watcher.on("error", () => { watcher.close(); this.watchers.delete(directory); this.invalidate(); });
      this.watchers.set(directory, watcher);
    } catch { /* No watcher: every request reconciles instead of certifying stale data. */ }
  }
  list(directory, extraPaths, signal) {
    const operation = this.queue.catch(() => {}).then(() => this.refresh(directory, extraPaths, signal));
    this.queue = operation;
    return operation;
  }
  async refresh(directory, extraPaths, signal) {
    signal.throwIfAborted();
    if (this.stopped) throw new Error("Session observer disposed");
    directory = resolve(directory);
    const extras = [...new Set(extraPaths.map(p => resolve(p)))].sort();
    const scope = JSON.stringify([directory, extras]);
    if (extras.length > 10000) throw new Error("Session bound");
    if (scope !== this.scope) {
      for (const watcher of this.watchers.values()) watcher.close();
      this.watchers.clear(); this.files.clear(); this.dirty.clear(); this.reconcileAt = 0; this.scope = scope;
    }
    const dirs = new Set([directory, ...extras.map(dirname)]);
    if (dirs.size > 128) throw new Error("Session bound");
    let missingDirectory = false;
    for (const dir of dirs) {
      try { await this.observe(dir); }
      catch (error) { if (error.code !== "ENOENT") throw error; missingDirectory = true; }
    }
    const now = this.now(), generation = this.generation;
    const full = !this.watching || now >= this.reconcileAt || missingDirectory || this.watchers.size !== dirs.size;
    let paths;
    if (full) {
      const names = [];
      try {
        for await (const entry of await opendir(directory)) {
          signal.throwIfAborted();
          if (names.length >= 10000) throw new Error("Session bound");
          names.push(entry.name);
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      paths = new Set([...names.filter(n => n.endsWith(".jsonl")).map(n => join(directory, n)), ...extras]);
    } else paths = new Set([...this.dirty].filter(p => dirname(p) === directory || extras.includes(p)));
    // Age admission happens even without an event at the 24h boundary.
    for (const [filename, row] of this.files) if (!row.mature && row.createdAt && now >= row.createdAt + SESSION_MIN_AGE_MS) paths.add(filename);
    if (paths.size > 10000) throw new Error("Session bound");
    const next = new Map(this.files);
    if (full) for (const filename of next.keys()) if (!paths.has(filename)) next.delete(filename);
    for (const filename of paths) {
      signal.throwIfAborted();
      const info = await lstat(filename).catch(e => { if (e.code !== "ENOENT") throw e; });
      if (!regularSessionFile(info)) { next.delete(filename); continue; }
      const previous = this.files.get(filename);
      const createdAt = previous?.identity === `${info.dev}:${info.ino}` ? previous.createdAt : await creationTime(filename, info, signal);
      if (!createdAt) throw new Error("Session creation time unavailable");
      const mature = now >= createdAt + SESSION_MIN_AGE_MS;
      next.set(filename, { path: filename, createdAt, identity: `${info.dev}:${info.ino}`, mature, ...(mature ? { revision: sessionFileRevision(info) } : {}) });
    }
    signal.throwIfAborted();
    if (this.stopped) throw new Error("Session observer disposed");
    if (next.size > 10000) throw new Error("Session bound");
    this.files = next;
    // Events delivered during awaited stats must survive for another pass.
    if (generation === this.generation) { this.dirty.clear(); this.reconcileAt = now + SESSION_RECONCILE_MS; }
    else { this.reconcileAt = 0; throw new Error("Session changed during check"); }
    return [...next.values()].filter(row => row.mature).sort((a, b) => a.path.localeCompare(b.path));
  }
  dispose() {
    this.stopped = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear(); this.files.clear(); this.dirty.clear();
    this.queue = Promise.resolve();
  }
}
