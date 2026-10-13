import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Existing multi-source regression fixtures explicitly opt in to their tested domains. */
export function enableSearchSources(root: string): void {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi/search-sources.json"), JSON.stringify({ version: 1,
    enabled: { settings: true, code: true, knowledge: true, tasks: true, sessions: true, commits: true } }));
}
