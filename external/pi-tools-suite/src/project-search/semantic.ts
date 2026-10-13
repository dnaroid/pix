import { freshSemanticCandidates, readCachedProjectVectors, type CachedTaskCandidate, type CachedSessionCandidate } from "./semantic-cache.js";
import { embedSemanticQuery, semanticConfiguration, requireSemanticIdentity, semanticKey, validSearchVector,
  type SemanticSearchOptions } from "./semantic-provider.js";
import { commitIdentity } from "./semantic-commit-provider.js";
import { indexMissingSessionVectors } from "./semantic-session-indexer.js";
import { syncSessionChunks } from "./semantic-session-chunks.js";
import { hasSessionChunkVectors, searchSessionChunks, type ChunkHit } from "./session-chunks.mjs";

export type { SemanticSearchOptions } from "./semantic-provider.js";

export interface CachedSemanticScores {
  tasks: Map<string, number>;
  sessions: Map<string, number>;
  notices: string[];
  chunks: Map<string,ChunkHit>;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, xx = 0, yy = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y;
    xx += x * x;
    yy += y * y;
  }
  const value = dot / Math.sqrt(xx * yy);
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

const QUERY_CACHE_LIMIT = 32;
const queryCache = new Map<string, number[]>();

/** Cache query vectors only (never task or session texts). Revalidate configuration
 * and cached-source hashes on EVERY request, including cache hits. */
export async function cachedProjectSemantics(root: string, query: string,
  candidates: { tasks: readonly CachedTaskCandidate[]; sessions: readonly CachedSessionCandidate[]; tasksSelected?: boolean; tasksSafe?: boolean },
  signal: AbortSignal, options: SemanticSearchOptions = {}): Promise<CachedSemanticScores> {
  const result: CachedSemanticScores = { tasks: new Map(), sessions: new Map(), notices: [], chunks:new Map() };
  signal.throwIfAborted();
  try {
    const config = await semanticConfiguration(options, signal);
    if (!config) return result;
    if (candidates.tasks.length === 0 && candidates.sessions.length === 0) return result;
    const key = config.provider === "openrouter" ? await semanticKey(options, signal) : undefined;
    if (key || config.provider === "ollama") {
      if (candidates.sessions.length) {
        try {
          const outcome = await indexMissingSessionVectors(root, candidates.sessions, key, options, signal, config);
          if (outcome.remaining) result.notices.push(`Semantic Sessions: ${outcome.remaining} saved names still await indexing; search again to continue.`);
          const chunks = await syncSessionChunks(root,candidates.sessions,signal,options);
          if(!chunks.complete) result.notices.push(`Session chunks: ${chunks.indexed}/${chunks.total} indexed; ${chunks.skipped} unreadable. Use /search-semantic index sessions to continue.`);
        } catch (error) {
          signal.throwIfAborted();
          result.notices.push("Semantic session-name indexing unavailable or interrupted; local matches remain available.");
        }
      }
    }
    await requireSemanticIdentity(options, config, signal);
    const cached = await readCachedProjectVectors(root, candidates, options, signal, config);
    const messageVectors = candidates.sessions.length > 0 && await hasSessionChunkVectors(root,candidates.sessions,signal,
      {identity:commitIdentity(config),dimension:config.dimension}).catch(()=>{signal.throwIfAborted();return false;});
    if (!cached.tasks.size && !cached.sessions.size && !messageVectors) {
      if (cached.uncachedTasks || cached.uncachedSessions) result.notices.push(
        "Semantic task/session vectors are unavailable or incompatible with the configured identity; local search was used. Check central embedding configuration and credentials.");
      return result;
    }
    if (!key && config.provider === "openrouter") {
      result.notices.push("Semantic task/session query unavailable without an OpenRouter credential; local matches remain available.");
      return result;
    }
    const cacheKey = `${root}\0${commitIdentity(config)}\0${query}`;
    let queryVector = options.embedQuery ? undefined : queryCache.get(cacheKey);
    if (!queryVector) {
      await requireSemanticIdentity(options, config, signal);
      queryVector = [...await withProviderSlot(signal, () => (options.embedQuery ?? embedSemanticQuery)(query, key, signal, config))];
      if (!validSearchVector(queryVector, config.dimension)) throw new Error("Invalid query vector");
      await requireSemanticIdentity(options, config, signal);
      if (!options.embedQuery) {
        queryCache.delete(cacheKey);
        queryCache.set(cacheKey, queryVector);
        while (queryCache.size > QUERY_CACHE_LIMIT) queryCache.delete(queryCache.keys().next().value!);
      }
    }
    signal.throwIfAborted();
    // Removed/changed central configuration invalidates even cached queries.
    await requireSemanticIdentity(options, config, signal);
    const fresh = await freshSemanticCandidates(root, {
      tasks: candidates.tasks.filter(task => cached.tasks.has(task.id)),
      sessions: candidates.sessions.filter(session => cached.sessions.has(session.id)),
    }, options, signal);
    await requireSemanticIdentity(options, config, signal);
    for (const [id, vector] of cached.tasks) {
      if (!fresh.tasks.has(id)) continue;
      const similarity = cosine(queryVector, vector);
      if (similarity >= 0.25) result.tasks.set(id, similarity);
    }
    for (const [id, vector] of cached.sessions) {
      if (!fresh.sessions.has(id)) continue;
      const similarity = cosine(queryVector, vector);
      if (similarity >= 0.25) result.sessions.set(id, similarity);
    }
    const chunks = await searchSessionChunks(root,candidates.sessions,query,signal,
      {identity:commitIdentity(config),dimension:config.dimension,query:queryVector});
    await requireSemanticIdentity(options,config,signal);
    for(const chunk of chunks) {
      result.chunks.set(chunk.id,chunk);
      result.sessions.set(chunk.id,Math.max(result.sessions.get(chunk.id)??0,chunk.score));
    }
    if (cached.uncachedTasks) result.notices.push(
      `Semantic Tasks: ${cached.uncachedTasks} task texts have no current cached vector; local matches remain available.`);
    if (cached.uncachedSessions) result.notices.push(
      `Semantic Sessions: ${cached.uncachedSessions} saved names lack a current vector; local matches remain available.`);
  } catch (error) {
    signal.throwIfAborted();
    // No raw provider/auth/index-path diagnostics in agent tool output.
    result.notices.push("Semantic task/session lookup unavailable; local project results remain available.");
  }
  return result;
}
import { withProviderSlot } from "./source-work.mjs";
