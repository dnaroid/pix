import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { safeDirectory, safeFile } from "./source-work.js";

const run = `search-diagnostics-${process.pid}-${randomUUID()}`;
/** Local diagnostics only: callers supply metadata, never transcript/provider bodies. */
export async function logSearchDiagnostic(root, diagnostic) {
  try {
    const base = join(resolve(root), ".pi");
    const artifacts = join(base, "artifacts"), directory = join(artifacts, run);
    for (const path of [base, artifacts, directory]) await safeDirectory(path);
    const path = join(directory, "events.jsonl");
    await safeFile(path);
    const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) return;
      // Bound a process log; diagnostics must never block indexing on disk exhaustion.
      if (stat.size < 4 * 1024 * 1024) await file.writeFile(JSON.stringify({ time: new Date().toISOString(), ...diagnostic }) + "\n");
    } finally { await file.close(); }
  } catch { /* A diagnostics failure must not create a chat notification or fail search. */ }
}
