import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadSemanticEmbeddingConfig, semanticSearchConfigPath, type SemanticEmbeddingConfig } from "./semantic-config.js";
export { loadSemanticEmbeddingConfig, semanticSearchConfigPath, semanticEmbeddingIdentity, type SemanticEmbeddingConfig } from "./semantic-config.js";

export interface SearchAuth {
  available(signal: AbortSignal): Promise<boolean>;
  key(signal: AbortSignal): Promise<string | undefined>;
  save(key: string, signal: AbortSignal): Promise<void>;
}
export function sharedSearchAuth(agentDir = getAgentDir(), env: NodeJS.ProcessEnv = process.env): SearchAuth {
  let runtime: Promise<ModelRuntime> | undefined;
  const path = join(agentDir, "auth.json");
  const getRuntime = () => runtime ??= ModelRuntime.create({ authPath: path, modelsPath: null, refreshOnCreate: false });
  const key = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const ambient = env.OPENROUTER_API_KEY?.trim();
    if (ambient) return ambient;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512 * 1024) return undefined;
      const handle = await open(path, "r");
      try {
        const actual = await handle.stat();
        if (actual.dev !== before.dev || actual.ino !== before.ino || !actual.isFile() || actual.nlink !== 1 || actual.size > 512 * 1024) return undefined;
        const bytes = Buffer.alloc(512 * 1024 + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        signal.throwIfAborted();
        if (bytesRead > 512 * 1024) return undefined;
        const stored = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))?.openrouter;
        return stored?.type === "api_key" && typeof stored.key === "string" && stored.key.trim() && stored.key.length <= 10000 ? stored.key : undefined;
      } finally { await handle.close(); }
    } catch { signal.throwIfAborted(); return undefined; }
  };
  return {
    available: async signal => Boolean(await key(signal)), key,
    save: async (key, signal) => {
      if (key) await (await getRuntime()).login("openrouter", "api_key", { prompt: async () => key, notify: () => {}, signal });
      else await (await getRuntime()).logout("openrouter", { signal });
    },
  };
}
// RAG's answer-model preferences are unrelated to semantic-search consent.
export const desktopSearchConfigPath = () => join(process.env.HOME || homedir(), ".config", "pi", "pix-desktop.jsonc");
/** Compatibility name; enabled booleans are computed from one configuration. No ACP writes. */
export class SearchPreferences {
  constructor(readonly path = semanticSearchConfigPath()) {}
  embedding(): Promise<SemanticEmbeddingConfig | undefined> { return loadSemanticEmbeddingConfig(this.path); }
  async enabled(): Promise<boolean> { return Boolean(await this.embedding()); }
  sessionTitlesEnabled(): Promise<boolean> { return this.enabled(); }
  tasksSemanticEnabled(): Promise<boolean> { return this.enabled(); }
}
