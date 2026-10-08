import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { lock } from "proper-lockfile";

export interface SearchAuth {
  available(signal: AbortSignal): Promise<boolean>;
  key(signal: AbortSignal): Promise<string | undefined>;
  save(key: string, signal: AbortSignal): Promise<void>;
}
export function sharedSearchAuth(agentDir = getAgentDir()): SearchAuth {
  // Create SDK storage lazily. Merely connecting ACP must not create/read credentials synchronously.
  let runtime: Promise<ModelRuntime> | undefined;
  const path = join(agentDir, "auth.json");
  const getRuntime = () => runtime ??= ModelRuntime.create({ authPath: path, modelsPath: null, refreshOnCreate: false });
  const key = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    // Require a persisted shared credential, never ambient OPENROUTER_API_KEY/config.
    let source: string;
    try { source = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const stored = JSON.parse(source)?.openrouter;
    if (stored?.type !== "api_key" || typeof stored.key !== "string" || !stored.key.trim()) return undefined;
    return (await (await getRuntime()).getAuth("openrouter", { signal }))?.auth.apiKey;
  };
  return {
    available: async signal => Boolean(await key(signal)),
    key,
    save: async (key, signal) => {
      if (key) await (await getRuntime()).login("openrouter", "api_key", { prompt: async () => key, notify: () => {}, signal });
      else await (await getRuntime()).logout("openrouter", { signal });
    },
  };
}
export const desktopSearchConfigPath = () => join(homedir(), ".config", "pi", "pix-desktop.jsonc");
export class SearchPreferences {
  constructor(readonly path = desktopSearchConfigPath()) {}
  private async source(): Promise<string> {
    try { return await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}\n"; throw new Error("Search preferences unavailable"); }
  }
  private validate(source: string): Record<string, unknown> {
    const errors: ParseError[] = [];
    const value: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Search preferences unavailable");
    return value as Record<string, unknown>;
  }
  async enabled(): Promise<boolean> {
    const value = this.validate(await this.source());
    const search = value.search as Record<string, unknown> | undefined;
    return search?.semanticEnabled === true;
  }
  async sessionTitlesEnabled(): Promise<boolean> {
    const value = this.validate(await this.source());
    const search = value.search as Record<string, unknown> | undefined;
    return search?.sessionTitlesEnabled === true;
  }
  async setSessionTitlesEnabled(enabled: boolean): Promise<void> {
    await this.setFlag("sessionTitlesEnabled", enabled);
  }
  async setEnabled(enabled: boolean): Promise<void> {
    await this.setFlag("semanticEnabled", enabled);
  }
  private async setFlag(flag: string, enabled: boolean): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Shared with native Desktop writers: atomic mkdir of this directory owns
    // the entire read/modify/rename. Never steal by mtime: a native writer (or
    // a suspended ACP) can still own an old lock. Crash leftovers fail closed.
    const release = await lock(dirname(this.path), {
      realpath: true,
      lockfilePath: `${this.path}.search.lock`,
      stale: Infinity,
      update: 1000,
      retries: { retries: 10, minTimeout: 20, maxTimeout: 100 },
    }).catch(() => { throw new Error("Search preferences could not be saved: config busy or unavailable"); });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const source = await this.source();
      this.validate(source);
      const next = applyEdits(source, modify(source, ["search", flag], enabled, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      await writeFile(temporary, next, { mode: 0o600 });
      await rename(temporary, this.path);
    } catch { throw new Error("Search preferences could not be saved"); }
    finally { await rm(temporary, { force: true }).catch(() => {}); await release(); }
  }
}
