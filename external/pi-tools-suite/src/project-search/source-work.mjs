import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";

const workContext = new AsyncLocalStorage();
function heartbeat(db, sql, args, ttl) {
  let expiry = Date.now() + ttl;
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      const changed = db.prepare(sql).run(now + ttl, ...args, now).changes;
      if (!changed) clearInterval(timer);
      else expiry = now + ttl;
    } catch {
      // Busy is transient; closed/lost/expired ownership must not retain a timer.
      if (Date.now() >= expiry) clearInterval(timer);
    }
  }, Math.max(10, Math.floor(ttl / 3)));
  timer.unref?.();
  return () => clearInterval(timer);
}

// Protocol twin: acp/src/search/source-work.js. Keep byte-identical; tested.
export const SOURCE_FILES = Object.freeze({ code: "code.sqlite", knowledge: "knowledge.sqlite",
  settings: "settings.sqlite", sessions: "sessions.sqlite", tasks: "tasks.sqlite", commits: "git-commits.sqlite" });
export const WORK_TTL_MS = 90_000;
export const PROVIDER_CONCURRENCY = 4;
export function sourcePath(root, source) {
  if (!Object.hasOwn(SOURCE_FILES, source)) throw new Error("Unknown search source");
  return join(resolve(root), ".pi/search", SOURCE_FILES[source]);
}
export async function safeFile(filename) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const info = await lstat(filename + suffix).catch(e => { if (e.code !== "ENOENT") throw e; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 512 * 1024 * 1024)) {
      throw new Error("Unsafe search storage");
    }
  }
}
export async function safeDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe search directory");
}
export async function openDatabase(filename) {
  await safeFile(filename);
  try {
    const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  } catch (e) { if (e.code !== "EEXIST") throw e; }
  await safeFile(filename);
  if ("Bun" in globalThis) { const { Database } = await import("bun:sqlite"); return new Database(filename, { create: false, readwrite: true }); }
  const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(filename);
}
export function ensureWorkSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pix_search_work (
    id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL,
    failures INTEGER NOT NULL, network INTEGER NOT NULL)`);
}
export async function beginWrite(db, signal, budget = 600) {
  const deadline = Date.now() + budget;
  db.exec("PRAGMA busy_timeout=5");
  while (true) {
    signal.throwIfAborted();
    try { db.exec("BEGIN IMMEDIATE"); return; }
    catch (e) {
      if (!/locked|busy/i.test(e.message) || Date.now() >= deadline) throw e;
      await delay(15, undefined, { signal });
    }
  }
}
/** Durable per-source ownership; expiry fences a late completion in the SAME
 * transaction as publication. No remote call owns a SQLite transaction. */
export async function claimWork(db, signal, options = {}) {
  const id = options.id ?? "documents", ttl = options.ttl ?? WORK_TTL_MS;
  const deadline = Date.now() + (options.waitMs ?? WORK_TTL_MS);
  while (true) {
    await beginWrite(db, signal);
    let token;
    try {
      ensureWorkSchema(db);
      const row = db.prepare("SELECT * FROM pix_search_work WHERE id=?").get(id);
      const now = Date.now();
      if (!row || row.expires <= now) {
        const failures = (row?.failures ?? 0) + (row?.token && row.network ? 1 : 0);
        if (failures >= 2 && !options.retry) throw new Error("Search work needs Continue after repeated interrupted provider requests");
        token = randomUUID();
        db.prepare(`INSERT INTO pix_search_work VALUES(?,?,?,?,0) ON CONFLICT(id)
          DO UPDATE SET token=excluded.token,expires=excluded.expires,failures=excluded.failures,network=0`)
          .run(id, token, now + ttl, options.retry ? 0 : failures);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    if (token) {
      const pending = new Set();
      const stopHeartbeat = heartbeat(db, "UPDATE pix_search_work SET expires=? WHERE id=? AND token=? AND expires>?", [id, token], ttl);
      const assert = connection => {
        signal.throwIfAborted();
        const row = connection.prepare("SELECT token,expires FROM pix_search_work WHERE id=?").get(id);
        if (row?.token !== token || row.expires <= Date.now()) throw new Error("Search work ownership expired");
      };
      return {
        assert,
        run(operation) { return workContext.run({ db, assert, pending }, operation); },
        // Called inside the planning transaction, before releasing it for HTTP.
        network(connection) { assert(connection); connection.prepare("UPDATE pix_search_work SET network=1,expires=? WHERE id=? AND token=?").run(Date.now() + ttl, id, token); },
        async release(success = true) {
          // Cancellation wrappers can finish before their transport. Retain ownership and
          // its connection until every real provider operation in this work scope settles.
          await Promise.allSettled([...pending]);
          stopHeartbeat();
          // Cancellation must not prevent cleanup. Token predicate cannot release a successor.
          await beginWrite(db, new AbortController().signal);
          try {
            db.prepare(`UPDATE pix_search_work SET token='',expires=CASE WHEN ? OR network=0 THEN 0 ELSE ? END,
              failures=CASE WHEN network=0 THEN failures WHEN ? THEN 0 ELSE failures+1 END,network=0 WHERE id=? AND token=?`)
              .run(success ? 1 : 0, Date.now() + 250, success ? 1 : 0, id, token);
            db.exec("COMMIT");
          } catch (e) { db.exec("ROLLBACK"); throw e; }
        },
      };
    }
    if (Date.now() >= deadline) throw new Error("Search source busy; update deferred");
    await delay(25, undefined, { signal });
  }
}

/** Global slots across projects, Pi/ACP/Desktop processes and worker threads.
 * Slots remain occupied until transport settles, even after caller cancellation.
 * Heartbeats keep live slots occupied. Missing heartbeats (including terminated
 * threads in a live process) recover after TTL; remote completion is then uncertain.
 * @template T
 * @param {AbortSignal} signal
 * @param {() => Promise<T>} operation
 * @param {{directory?: string, ttl?: number}} [options]
 * @returns {Promise<T>}
 */
export function withProviderSlot(signal, operation, options = {}) {
  const work = workContext.getStore();
  const promise = providerSlot(signal, operation, options, work);
  work?.pending.add(promise);
  void promise.finally(() => work?.pending.delete(promise)).catch(() => {});
  return promise;
}
async function providerSlot(signal, operation, options, work) {
  const home = process.env.HOME?.trim() || homedir();
  const directory = options.directory ?? join(home, ".config/pi");
  if (!options.directory) await safeDirectory(join(home, ".config"));
  await safeDirectory(directory);
  const db = await openDatabase(join(directory, "search-provider-work.sqlite"));
  const token = randomUUID();
  const ttl = options.ttl ?? WORK_TTL_MS;
  let acquired = false;
  let stopHeartbeat;
  try {
    while (!acquired) {
      await beginWrite(db, signal);
      try {
        db.exec("CREATE TABLE IF NOT EXISTS provider_slots(token TEXT PRIMARY KEY,pid INTEGER NOT NULL,expires INTEGER NOT NULL)");
        const now = Date.now();
        db.prepare("DELETE FROM provider_slots WHERE expires<=?").run(now);
        if (db.prepare("SELECT count(*) AS n FROM provider_slots").get().n < PROVIDER_CONCURRENCY) {
          db.prepare("INSERT INTO provider_slots VALUES(?,?,?)").run(token, process.pid, now + ttl);
          acquired = true;
        }
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      if (!acquired) await delay(25, undefined, { signal });
    }
    stopHeartbeat = heartbeat(db, "UPDATE provider_slots SET expires=? WHERE token=? AND expires>?", [token], ttl);
    signal.throwIfAborted();
    work?.assert(work.db);
    const result = await operation();
    const row = db.prepare("SELECT expires FROM provider_slots WHERE token=?").get(token);
    if (!row || row.expires <= Date.now()) throw new Error("Search provider ownership expired");
    return result;
  } finally {
    stopHeartbeat?.();
    try {
      if (acquired) {
        await beginWrite(db, new AbortController().signal);
        try { db.prepare("DELETE FROM provider_slots WHERE token=?").run(token); db.exec("COMMIT"); }
        catch (e) { db.exec("ROLLBACK"); throw e; }
      }
    }
    finally { db.close(); }
  }
}
