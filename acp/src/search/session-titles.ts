import { resolve } from "node:path";
import type { SessionMapRecord } from "../acp/session-map.js";
import type { SessionSearchHit } from "./contract.js";
import { lexicalScore } from "./documents.js";

/** The same project-scoped titles shown in the session list; never open message files. */
export function sessionTitleHits(records: readonly SessionMapRecord[], cwd: string, query: string): SessionSearchHit[] {
  const unique = new Map<string, SessionSearchHit>();
  for (const record of records) {
    if (resolve(record.cwd) !== cwd) continue;
    const title = record.title?.trim();
    if (!title) continue;
    const score = lexicalScore(title, query);
    if (score > 0) unique.set(record.sessionId, { kind: "sessions", id: `sessions:${record.sessionId}`,
      sessionId: record.sessionId, title, snippet: "", score });
  }
  return [...unique.values()];
}
