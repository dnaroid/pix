import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beginWrite, openDatabase, safeDirectory } from "./source-work.js";

/** Only fixed, actionable lock messages are safe to cross the native boundary. */
export class SourcePolicyLockError extends Error {}

// Protocol twin: acp/src/search/source-policy-lock.js (import extensions only).
// The permanent directory also fences older writers, whose O_EXCL file open
// must fail. Never delete/recreate it or its SQLite file while processes run:
// different inodes would let two writers each believe they own the same lock.
export async function withSourcePolicyWriteLock(root, run) {
  const parent = join(resolve(root), ".pi"), directory = join(parent, "search-sources.json.lock");
  await safeDirectory(parent);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  if (info.isFile() && !info.isSymbolicLink()) {
    // An old empty marker has no owner identity. Age, even with a watchdog,
    // cannot distinguish a dead writer from a suspended live one.
    throw new SourcePolicyLockError("Legacy search source lock: close all older Pix/Pi processes, then remove only the file .pi/search-sources.json.lock and retry. Do not remove a lock directory.");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe search source lock directory");
  const db = await openDatabase(join(directory, "writer.sqlite"));
  let locked = false;
  try {
    try { await beginWrite(db, new AbortController().signal); }
    catch (error) {
      if (/locked|busy/i.test(error.message)) throw new SourcePolicyLockError("Search source policy busy; retry after the other writer finishes");
      throw error;
    }
    locked = true;
    return await run();
  } finally {
    // The database stores no policy data; BEGIN IMMEDIATE is only a kernel-
    // maintained mutex around read -> atomic JSON rename. There is no lease,
    // heartbeat, timeout takeover or stale-lock reaper. Process death releases
    // ownership even when finally cannot execute, including before initialization.
    try { if (locked) db.exec("ROLLBACK"); }
    finally { db.close(); }
  }
}
