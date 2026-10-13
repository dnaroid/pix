import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SessionCandidateCatalog, readSessionTitle } from "./session-discovery.mjs";

/** Search-only discovery. Interactive session navigation remains SDK-owned. */
export async function listSearchSessions(cwd: string, signal: AbortSignal, strict = false) {
  const catalog = new SessionCandidateCatalog({ watching: false });
  try {
    const records = [];
    for (const candidate of await catalog.list(cwd, getAgentDir(), signal)) {
      const title = await readSessionTitle(cwd, candidate, signal);
      if (!title && strict) throw new Error("Session title could not be read");
      if (title) records.push({ ...title, cwd });
    }
    return records;
  } finally { catalog.dispose(); }
}
