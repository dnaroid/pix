import { resolve } from "node:path";
import { setImmediate as yieldTask } from "node:timers/promises";
import type { SessionMapRecord } from "../acp/session-map.js";
import type { SearchIndexStore } from "./index-store.js";
import type { SessionBoundaryRow } from "./session-boundary-index.js";
import { readSessionBoundaries, sessionFileFingerprint } from "./session-boundary-reader.js";
import { verifySessionBoundaryIndexPath } from "./session-boundary-paths.js";

/** Incremental, project-local FTS refresh. No transcript or query leaves this process. */
export async function synchronizeSessionBoundaries(
  store: SearchIndexStore, cwd: string, records: readonly SessionMapRecord[], signal: AbortSignal,
): Promise<void> {
  await verifySessionBoundaryIndexPath(cwd);
  const saved = await store.readSessionBoundaryState(cwd, signal);
  const unique = new Map(records.filter(record => resolve(record.cwd) === cwd)
    .map(record => [record.sessionId, record]));
  const live: string[] = [];
  const changed: SessionBoundaryRow[] = [];
  let count = 0;
  for (const record of unique.values()) {
    signal.throwIfAborted();
    const path = resolve(record.piSessionPath);
    const fingerprint = await sessionFileFingerprint(path);
    if (!fingerprint) continue;
    const previous = saved.get(record.sessionId);
    if (previous?.path === path && previous.fingerprint === fingerprint) {
      live.push(record.sessionId);
      continue;
    }
    const texts = await readSessionBoundaries(path, signal).catch(error => {
      signal.throwIfAborted();
      return undefined;
    });
    if (!texts) continue;
    live.push(record.sessionId);
    changed.push({ sessionId: record.sessionId, path, ...texts });
    if (++count % 8 === 0) await yieldTask();
  }
  signal.throwIfAborted();
  if (changed.length === 0 && saved.size === live.length) return;
  await verifySessionBoundaryIndexPath(cwd);
  await store.write(cwd, signal, async tx => tx.sessionBoundaries(live, changed));
}
