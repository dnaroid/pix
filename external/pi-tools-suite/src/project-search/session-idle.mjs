import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { beginWrite, openDatabase, safeDirectory, sourcePath } from "./source-work.mjs";
import { SESSION_MIN_AGE_MS } from "./session-revisions.mjs";

export const SESSION_IDLE_MS = 60 * 60 * 1000;
export class SessionIndexDeferred extends Error {
  constructor() { super("Session became active before indexing"); }
}
const HEARTBEAT_MS = 30_000;
const LEASE_MS = 90_000;

async function database(root) {
  for (const path of [join(root, ".pi"), join(root, ".pi/search")]) await safeDirectory(path);
  const db = await openDatabase(sourcePath(root, "sessions"));
  return db;
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pix_session_activity (
      session_id TEXT PRIMARY KEY, active_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pix_session_running (
      owner TEXT NOT NULL, session_id TEXT NOT NULL, expires INTEGER NOT NULL,
      PRIMARY KEY(owner, session_id))`);
}

/** Activity is separate from document ownership: a live agent can fence a paid
 * batch without waiting for the indexer's documents lease or provider. */
export class SessionIdlePolicy {
  constructor(root, now = Date.now) {
    this.root = resolve(root); this.now = now; this.token = randomUUID();
    this.running = new Set(); this.queue = Promise.resolve(); this.stopped = false;
    this.activity = new Map(); this.pending = new Map();
    this.timer = setInterval(() => {
      if (this.running.size) void this.write([...this.running], true).catch(() => {});
      else if (this.pending.size) void this.flush().catch(() => {});
    }, HEARTBEAT_MS);
    this.timer.unref?.();
  }
  write(ids, running, touch = true) {
    const at = this.now();
    if (touch) for (const id of ids) this.activity.set(id, at);
    for (const id of ids) this.pending.set(id, { running, at: this.activity.get(id) });
    return this.flush();
  }
  flush() {
    const operation = this.queue.catch(() => {}).then(async () => {
      if (!this.pending.size) return;
      const db = await database(this.root);
      try {
        await beginWrite(db, new AbortController().signal);
        try {
          ensureSchema(db);
          const committedAt = this.now();
          const activity = db.prepare(`INSERT INTO pix_session_activity VALUES(?,?)
            ON CONFLICT(session_id) DO UPDATE SET active_at=MAX(active_at,excluded.active_at)`);
          const lease = db.prepare(`INSERT INTO pix_session_running VALUES(?,?,?)
            ON CONFLICT(owner,session_id) DO UPDATE SET expires=excluded.expires`);
          for (const [id, record] of this.pending) {
            if (record.at !== undefined) activity.run(id, record.at);
            if (record.running) lease.run(this.token, id, committedAt + LEASE_MS);
            else db.prepare("DELETE FROM pix_session_running WHERE owner=? AND session_id=?").run(this.token, id);
          }
          db.prepare("DELETE FROM pix_session_running WHERE expires<=?").run(committedAt);
          db.exec("COMMIT");
          this.pending.clear();
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      } finally { db.close(); }
    });
    this.queue = operation.then(() => { this.error = undefined; }, error => { this.error = error; throw error; });
    void this.queue.catch(() => {});
    return operation;
  }
  async observe(id, running, touch = true) {
    if (this.stopped || !id) return;
    if (running) this.running.add(id); else this.running.delete(id);
    await this.write([id], running, touch);
  }
  /** Reuse a single SQLite connection for a metadata sweep. Opening the DB for
   * each of thousands of sessions blocks ACP/TUI requests for seconds. This
   * read is only a candidate filter: eligible() still rechecks live activity
   * before provider work and publication. */
  async states(candidates, signal) {
    const states = [];
    let db, activity, running;
    try {
      for (const candidate of candidates) {
        signal.throwIfAborted();
        // Never await a pending writer: the local state fences it immediately.
        if (this.error) throw this.error;
        const info = await lstat(candidate.path).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
        signal.throwIfAborted();
        if (!info) { states.push({ eligible: false, revision: "missing" }); continue; }
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
          states.push({ eligible: false, revision: "unsafe" }); continue;
        }
        if (!db) {
          db = await database(this.root);
          const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='pix_session_activity'").get();
          if (exists) {
            activity = db.prepare("SELECT active_at FROM pix_session_activity WHERE session_id=?");
            running = db.prepare("SELECT MAX(expires) AS expires FROM pix_session_running WHERE session_id=?");
          }
        }
        const persisted = Number(activity?.get(candidate.id)?.active_at ?? 0);
        const at = Math.max(persisted, this.activity.get(candidate.id) ?? 0);
        const expires = Number(running?.get(candidate.id)?.expires ?? 0);
        const now = this.now(), due = Math.max(info.mtimeMs, at) + SESSION_IDLE_MS;
        states.push({ eligible: !this.running.has(candidate.id) && expires <= now && due <= now,
          changedAt: Math.max(info.mtimeMs, info.ctimeMs, at),
          revision: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${at}` });
      }
    } finally { db?.close(); }
    return states;
  }
  async state(candidate, signal) { return (await this.states([candidate], signal))[0]; }
  async eligible(candidate, signal) { return (await this.state(candidate, signal)).eligible; }
  async dispose() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer);
    const ids = [...this.running]; this.running.clear();
    if (ids.length) await this.write(ids, false);
    else await this.flush();
  }
}

/** Only metadata is polled. An unchanged revision is attempted once, including
 * failures; activity/config changes or explicit manual indexing can retry it. */
export class IdleSessionSelection {
  constructor(policy) { this.policy = policy; this.attempted = new Map(); this.successful = new Map(); }
  reset() { this.attempted.clear(); this.successful.clear(); }
  useCache(revision) { if (this.cacheRevision !== revision) this.reset(); this.cacheRevision = revision; }
  succeeded(candidate) { this.successful.set(candidate.id, this.attempted.get(candidate.id)); }
  /** An attempted revision that never succeeded is still a live failure, even
   * when later passes skip it as unchanged. */
  hasUnresolvedFailures() {
    for (const [id, revision] of this.attempted) if (this.successful.get(id) !== revision) return true;
    return false;
  }
  async select(candidates, signal, since = 0) {
    const selected = [];
    this.complete = true;
    const ids = new Set(candidates.map(c => c.id));
    for (const id of this.attempted.keys()) if (!ids.has(id)) { this.attempted.delete(id); this.successful.delete(id); }
    // Test doubles and integrations with only state() still work.
    let states;
    if (typeof this.policy.states === "function") states = await this.policy.states(candidates, signal);
    else {
      states = [];
      for (const candidate of candidates) states.push(await this.policy.state(candidate, signal));
    }
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i], state = states[i];
      const revision = `${state.revision}:${candidate.createdAt ?? 0}:${candidate.changedAt ?? 0}`;
      const admittedAt = candidate.createdAt ? candidate.createdAt + SESSION_MIN_AGE_MS : Infinity;
      if (since > 0 && Math.max(state.changedAt ?? Infinity, admittedAt, candidate.changedAt ?? 0) < since) continue;
      if (!state.eligible) { this.complete = false; continue; }
      if (this.attempted.get(candidate.id) === revision) {
        if (this.successful.get(candidate.id) !== revision) this.complete = false;
        continue;
      }
      this.attempted.set(candidate.id, revision);
      selected.push(candidate);
    }
    return selected;
  }
}
