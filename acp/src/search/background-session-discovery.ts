import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { SessionMapRecord } from "../acp/session-map.js";
import { SessionCandidateCatalog, readSessionTitle } from "./session-discovery.js";

export interface BackgroundSessionRecord extends SessionMapRecord { nativeOnly?: boolean; createdAt?: number }
/** Metadata supply is deliberately separate from interactive/manual SDK discovery. */
export class BackgroundSessionDiscovery {
  private readonly catalog = new SessionCandidateCatalog();
  constructor(private readonly records: (cwd: string) => Promise<readonly SessionMapRecord[]>,
    private readonly agentDir = getAgentDir()) {}
  dispose(): void { this.catalog.dispose(); }
  async snapshot(cwd: string, signal: AbortSignal): Promise<string> {
    const records = await this.records(cwd);
    return this.catalog.snapshot(cwd, this.agentDir, signal, records.map(r => r.piSessionPath), records);
  }
  async list(cwd: string, signal: AbortSignal): Promise<BackgroundSessionRecord[]> {
    const records = await this.records(cwd);
    signal.throwIfAborted();
    const saved = new Map(records.map(r => [resolve(r.piSessionPath), r]));
    const byPath = new Map<string, BackgroundSessionRecord>();
    for (const candidate of await this.catalog.list(cwd, this.agentDir, signal, records.map(r => r.piSessionPath))) {
      const record = saved.get(candidate.path);
      byPath.set(candidate.path, record?.piSessionId === candidate.id ? { ...record, createdAt: candidate.createdAt } : {
        sessionId: candidate.id, piSessionId: candidate.id, piSessionPath: candidate.path,
        cwd, updatedAt: "", nativeOnly: true, createdAt: candidate.createdAt,
      });
    }
    return [...byPath.values()];
  }
}
export async function hydrateBackgroundTitle(cwd: string, record: BackgroundSessionRecord, signal: AbortSignal) {
  const title = await readSessionTitle(cwd, { id: record.piSessionId, path: record.piSessionPath }, signal);
  if (!title) return;
  const name = title.name?.trim();
  const prefix = name?.replace(/(?:\.\.\.|…)+$/u, "").trim();
  const explicit = name && prefix && !title.firstMessage.trim().startsWith(prefix)
    && (record.nativeOnly || (record.namedTitle?.trim() === name && record.title?.trim() === name));
  return { record: { ...record, title: name, namedTitle: explicit ? name : undefined }, snapshot: title };
}
