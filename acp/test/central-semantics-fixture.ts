import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SearchPreferences } from "../src/search/config.js";
import { SEARCH_EMBEDDING_MODEL } from "../src/search/contract.js";

/** Only test-owned paths. Simulates an external native/ordinary-Pi configuration editor. */
export class FixtureSearchPreferences extends SearchPreferences {
  async configure(enabled = true, embedding: Record<string, unknown> = {}): Promise<void> {
    if (!enabled) { await rm(this.path, { force: true }); return; }
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ search: { embedding: { embeddingProvider: "openrouter", embeddingModel: SEARCH_EMBEDDING_MODEL, vectorSize: 1024, ...embedding } } }));
  }
}
