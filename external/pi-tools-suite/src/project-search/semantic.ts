import { freshSemanticCandidates, readCachedProjectVectors, type CachedTaskCandidate, type CachedSessionCandidate } from "./semantic-cache.js";
import { embedSemanticQuery, semanticConsents, semanticKey, validSearchVector,
  type SemanticSearchOptions } from "./semantic-provider.js";
import { indexMissingTaskVectors, pruneEmptyTaskIndex } from "./semantic-task-indexer.js";
import { indexMissingSessionVectors } from "./semantic-session-indexer.js";

export type { SemanticSearchOptions } from "./semantic-provider.js";

export interface CachedSemanticScores {
  tasks: Map<string, number>;
  sessions: Map<string, number>;
  notices: string[];
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

/** Cache query vectors only (never task or session texts). Revalidate consent
 * and cached-source hashes on EVERY request, including cache hits. */
export async function cachedProjectSemantics(root: string, query: string,
  candidates: { tasks: readonly CachedTaskCandidate[]; sessions: readonly CachedSessionCandidate[]; tasksSelected?: boolean; tasksSafe?: boolean },
  signal: AbortSignal, options: SemanticSearchOptions = {}): Promise<CachedSemanticScores> {
  const result: CachedSemanticScores = { tasks: new Map(), sessions: new Map(), notices: [] };
  signal.throwIfAborted();
  try {
    const consent = await semanticConsents(options, signal);
    if (consent.tasks && candidates.tasksSelected && candidates.tasksSafe && candidates.tasks.length === 0) {
      await pruneEmptyTaskIndex(root, signal).catch(() => { signal.throwIfAborted(); });
    }
    if ((!consent.tasks || candidates.tasks.length === 0) && (!consent.sessions || candidates.sessions.length === 0)) return result;
    const key = await semanticKey(options, signal);
    if (key) {
      if (consent.tasks && candidates.tasks.length && candidates.tasks.length <= 10_000) {
        try {
          const outcome = await indexMissingTaskVectors(root, candidates.tasks, key, options, signal);
          if (outcome.remaining) result.notices.push(`Semantic Tasks: ${outcome.remaining} task texts still await indexing; search again to continue.`);
        } catch (error) {
          signal.throwIfAborted();
          result.notices.push("Semantic task indexing unavailable or interrupted; current local matches remain available.");
        }
      }
      if (consent.tasks && candidates.tasks.length > 10_000) result.notices.push(
        "Semantic Tasks: project exceeds the 10,000-task index bound; no task cache entries were changed.");
      if (consent.sessions && candidates.sessions.length) {
        try {
          const outcome = await indexMissingSessionVectors(root, candidates.sessions, key, options, signal);
          if (outcome.remaining) result.notices.push(`Semantic Sessions: ${outcome.remaining} saved names still await indexing; search again to continue.`);
        } catch (error) {
          signal.throwIfAborted();
          result.notices.push("Semantic session-name indexing unavailable or interrupted; local matches remain available.");
        }
      }
    }
    const cached = await readCachedProjectVectors(root, candidates, consent, options, signal);
    if (!cached.tasks.size && !cached.sessions.size) {
      if (cached.uncachedTasks || cached.uncachedSessions) result.notices.push(
        "Semantic task/session vectors are unavailable; local search was used. Enable the relevant opt-in and configure an embedding credential to index on demand.");
      return result;
    }
    if (!key) {
      result.notices.push("Semantic task/session query unavailable without a saved OpenRouter credential; local matches remain available.");
      return result;
    }
    const cacheKey = `${root}\0${query}`;
    let queryVector = options.embedQuery ? undefined : queryCache.get(cacheKey);
    if (!queryVector) {
      queryVector = [...await (options.embedQuery ?? embedSemanticQuery)(query, key, signal)];
      if (!validSearchVector(queryVector)) throw new Error("Invalid query vector");
      if (!options.embedQuery) {
        queryCache.delete(cacheKey);
        queryCache.set(cacheKey, queryVector);
        while (queryCache.size > QUERY_CACHE_LIMIT) queryCache.delete(queryCache.keys().next().value!);
      }
    }
    signal.throwIfAborted();
    // A revoked checkbox must not allow a stale query completion to be used.
    const after = await semanticConsents(options, signal);
    if (!after.tasks && !after.sessions) return result;
    const fresh = await freshSemanticCandidates(root, {
      tasks: after.tasks ? candidates.tasks.filter(task => cached.tasks.has(task.id)) : [],
      sessions: after.sessions ? candidates.sessions.filter(session => cached.sessions.has(session.id)) : [],
    }, options, signal);
    if (after.tasks) for (const [id, vector] of cached.tasks) {
      if (!fresh.tasks.has(id)) continue;
      const similarity = cosine(queryVector, vector);
      if (similarity >= 0.25) result.tasks.set(id, similarity);
    }
    if (after.sessions) for (const [id, vector] of cached.sessions) {
      if (!fresh.sessions.has(id)) continue;
      const similarity = cosine(queryVector, vector);
      if (similarity >= 0.25) result.sessions.set(id, similarity);
    }
    if (after.tasks && cached.uncachedTasks) result.notices.push(
      `Semantic Tasks: ${cached.uncachedTasks} task texts have no current cached vector; local matches remain available.`);
    if (after.sessions && cached.uncachedSessions) result.notices.push(
      `Semantic Sessions: ${cached.uncachedSessions} saved names lack a current vector; local matches remain available.`);
  } catch (error) {
    signal.throwIfAborted();
    // No raw provider/auth/index-path diagnostics in agent tool output.
    result.notices.push("Semantic task/session lookup unavailable; local project results remain available.");
  }
  return result;
}
