import { lstat } from "node:fs/promises";
import { claimWork, openDatabase, sourceDirectories, sourcePath } from "./source-work.js";
import { classifyIndexFailure } from "./search-logging.js";

/** Durable lease shared by the Desktop/ACP and Pi-suite background session passes.
 * Distinct from the `documents` lease: title/chunk writes claim `documents`
 * inside a pass, so one pass never waits on its own nested writes. */
export const SESSION_PASS_WORK = "session-pass";

/** Lock contention and another owner's lease are expected coordination between
 * hosts, not index failures. Callers defer and retry on the ordinary cadence. */
export function isSessionIndexBusy(error) {
  return classifyIndexFailure(error).cause === "busy";
}

async function openExisting(root) {
  for (const directory of sourceDirectories(root, "sessions")) {
    const info = await lstat(directory).catch(e => { if (e.code !== "ENOENT") throw e; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe search directory");
  }
  const path = sourcePath(root, "sessions");
  if (!await lstat(path).catch(e => { if (e.code !== "ENOENT") throw e; })) return;
  return openDatabase(path);
}

/** Run one automatic session pass while owning the pass lease. Never waits:
 * a held lease or a locked database yields `{ deferred }` without running.
 * Before the first index exists there is no shared cache to contend for; the
 * first `documents` claim creates it. */
export async function withSessionPass(root, signal, run) {
  signal.throwIfAborted();
  const db = await openExisting(root);
  if (!db) return { value: await run() };
  try {
    let work;
    try { work = await claimWork(db, signal, { id: SESSION_PASS_WORK, waitMs: 0, retry: true }); }
    catch (error) {
      signal.throwIfAborted();
      if (!isSessionIndexBusy(error)) throw error;
      return { deferred: /^Search source busy/.test(error?.message ?? "") ? "lease_held" : "busy" };
    }
    let success = false;
    try {
      const value = await run();
      success = true;
      return { value };
    } finally {
      // Heartbeat is already stopped; TTL expiry recovers a lease whose release was busy.
      try { await work.release(success); } catch { /* bounded by WORK_TTL_MS */ }
    }
  } finally { db.close(); }
}
