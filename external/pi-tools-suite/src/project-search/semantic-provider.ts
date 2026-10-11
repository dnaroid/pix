import { commitIdentity, embedCommits, loadCommitConfig, loadCommitKey, validCommitVector,
  type CommitEmbeddingConfig } from "./semantic-commit-provider.js";

export interface SemanticSearchOptions {
  /** Isolated service substitutions. Production uses central configuration/auth. */
  loadConfig?: () => Promise<CommitEmbeddingConfig | undefined>;
  loadKey?: () => Promise<string | undefined>;
  sessionMapPath?: string;
  embedQuery?: (query: string, key: string | undefined, signal: AbortSignal,
    config: CommitEmbeddingConfig) => Promise<readonly number[]>;
  embedTasks?: (texts: readonly string[], key: string | undefined, signal: AbortSignal,
    config: CommitEmbeddingConfig) => Promise<readonly (readonly number[])[]>;
}

export async function semanticConfiguration(options: SemanticSearchOptions, signal: AbortSignal): Promise<CommitEmbeddingConfig | undefined> {
  signal.throwIfAborted();
  const config = await (options.loadConfig ?? (() => loadCommitConfig("")))();
  signal.throwIfAborted();
  return config;
}

export async function requireSemanticIdentity(options: SemanticSearchOptions, config: CommitEmbeddingConfig,
  signal: AbortSignal): Promise<void> {
  const current = await semanticConfiguration(options, signal);
  if (!current || commitIdentity(current) !== commitIdentity(config)) throw new Error("Semantic configuration changed");
}

export async function semanticKey(options: SemanticSearchOptions, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  const key = await (options.loadKey ?? loadCommitKey)();
  signal.throwIfAborted();
  return key;
}

export const validSearchVector = validCommitVector;

/** Only bounded task title/description or explicitly saved name projections. */
export async function embedTaskTexts(texts: readonly string[], key: string | undefined, signal: AbortSignal,
  config: CommitEmbeddingConfig): Promise<number[][]> {
  if (!texts.length || texts.length > 16 || texts.some(text => !text.trim() || text.length > 2000)) {
    throw new Error("Invalid semantic embedding batch");
  }
  return embedCommits(texts.map(text => config.documentPrefix + text), config, key, signal);
}

/** One query vector; no task/session bodies. */
export async function embedSemanticQuery(query: string, key: string | undefined, signal: AbortSignal,
  config: CommitEmbeddingConfig): Promise<number[]> {
  if (!query.trim() || query.length > 2048) throw new Error("Invalid semantic query");
  return (await embedCommits([config.queryPrefix + query], config, key, signal))[0]!;
}
