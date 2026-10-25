import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beginWrite, openDatabase, safeDirectory } from "./source-work.mjs";

/** Only fixed, actionable lock messages are safe to cross the native boundary. */
export class SourcePolicyLockError extends Error {}

// Protocol twin: acp/src/search/source-policy-lock.js (import extensions only).
// Shared by Desktop workspace CAS, source selection, and Registry workspace pull.
// Never delete/recreate this directory or its SQLite file while processes run:
// different inodes would let two writers each believe they own the same lock.
export async function withSourcePolicyWriteLock(root, run) {
  const parent = join(resolve(root), ".pi"), directory = join(parent, "workspace.jsonc.lock");
  await safeDirectory(parent);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SourcePolicyLockError("Workspace configuration lock unavailable; check .pi/workspace.jsonc.lock and retry");
  const db = await openDatabase(join(directory, "writer.sqlite"));
  let locked = false;
  try {
    try { await beginWrite(db, new AbortController().signal); }
    catch (error) {
      if (/locked|busy/i.test(error.message)) throw new SourcePolicyLockError("Workspace configuration busy; retry after the other writer finishes");
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
