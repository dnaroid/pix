import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listSearchSessions } from "./session-list.js";
import { resolve } from "node:path";
import { parseGitHistory, safeGit } from "./engine.js";
import { indexNativeProject } from "./native.js";
import { requireSemanticIdentity, semanticConfiguration, semanticKey, type SemanticSearchOptions } from "./semantic-provider.js";
import { indexMissingSessionVectors } from "./semantic-session-indexer.js";
import { syncSessionChunks } from "./semantic-session-chunks.js";
import { syncSavedTaskVectors } from "./semantic-task-indexer.js";
import { indexCommitVectors, type CommitSemanticServices } from "./semantic-commit-indexer.js";
import { commitIdentity } from "./semantic-commit-provider.js";
import { beginSessionSweep, completeSessionSweep } from "./session-watermark.mjs";

export const INDEX_SOURCES = ["code", "knowledge", "sessions", "tasks", "commits"] as const;
export type IndexSource = typeof INDEX_SOURCES[number];
export interface IndexResult { complete: boolean; indexed?: number; message?: string }
export interface IndexServices {
  semantic?: SemanticSearchOptions;
  commits?: CommitSemanticServices;
  sessions?: typeof SessionManager.list;
  git?: typeof safeGit;
  native?: typeof indexNativeProject;
}

/** Explicit document-only adapters; never manufacture a search query. */
export async function runSourceIndex(root: string, source: IndexSource, signal: AbortSignal,
  services: IndexServices = {}): Promise<IndexResult> {
  return withSourcePolicy(root, signal, async owned => {
    await requireSourceEnabled(root, source, owned);
    return runEnabledSourceIndex(root, source, owned, services);
  });
}
async function runEnabledSourceIndex(root: string, source: IndexSource, signal: AbortSignal,
  services: IndexServices): Promise<IndexResult> {
  if (source === "code" || source === "knowledge") return (services.native ?? indexNativeProject)(root, source, signal);
  const options = services.semantic ?? {};
  const config = await semanticConfiguration(options, signal);
  if (!config) return { complete: false, message: "Configure the global provider with /search-semantic configure first." };
  const key = config.provider === "openrouter" ? await semanticKey(options, signal) : undefined;
  if (config.provider === "openrouter" && !key) return { complete: false, message: "OpenRouter credentials are unavailable." };
  if (source === "tasks") {
    const result = await syncSavedTaskVectors(root, key, options, signal, config, true);
    return { complete: true, indexed: result.indexed };
  }
  if (source === "sessions") {
    const pass = await beginSessionSweep(root,commitIdentity(config),signal);
    const candidates = (await (services.sessions ? services.sessions(root, undefined, undefined, signal) : listSearchSessions(root, signal, true)))
      .filter(session => resolve(session.cwd) === root);
    signal.throwIfAborted();
    const result = await syncSessionChunks(root,candidates,signal,options,true);
    // Saved-title freshness is authenticated against the current indexed
    // session metadata. Reconcile transcripts first; otherwise a cold index
    // silently skips every title, then only embeds them on a later Continue.
    const titles = await indexMissingSessionVectors(root, candidates, key, options, signal, config, true);
    const complete = result.complete && titles.remaining === 0;
    if (complete) {
      await requireSemanticIdentity(options,config,signal);
      await requireSourceEnabled(root,"sessions",signal);
      await completeSessionSweep(root,pass,signal);
    }
    return { complete,indexed:result.indexed,
      message:`Public user/assistant text chunks: ${result.indexed}/${result.total}; unreadable sessions: ${result.skipped}.` };
  }
  const git = services.git ?? safeGit;
  const readHead = (s: AbortSignal) => git(root, ["rev-parse", "--verify", "HEAD"], s);
  const head = (await readHead(signal)).trim();
  let indexed = 0;
  // Page the entire pinned reachable history, retaining bounded Git output per
  // subprocess. No overall search count/time budget applies to manual work.
  for (let skip = 0; ; skip += 256) {
    signal.throwIfAborted();
    const records = parseGitHistory(await git(root, ["log", head, "--no-decorate", "--no-show-signature",
      "--no-renames", "--no-ext-diff", "--no-textconv", "-z", "--max-count=256", `--skip=${skip}`,
      "--format=PIX-PROJECT-COMMIT:%H%x00%h%x00%s%x00%an%x00%aI%x00%B%x00", "--name-only"], signal));
    const result = await indexCommitVectors(root, records, head, readHead, signal, config, key,
      { loadConfig: () => semanticConfiguration(options, signal), ...services.commits }, Infinity, skip === 0);
    indexed += result.indexed;
    if ((await readHead(signal)).trim() !== head) throw new Error("HEAD changed");
    if (records.length < 256) return { complete: true, indexed };
  }
}
import { requireSourceEnabled, withSourcePolicy } from "./source-policy.mjs";
