import { repositoryRerankerSettings, rerankNativeHits, MAX_RERANK_CANDIDATES } from "./native-reranker.mjs";
import { verifyRerankerCandidates } from "./native-reranker-context.mjs";
import { probeSnapshots } from "./snapshot-probe.mjs";
import { readSourcePolicy } from "./source-policy.mjs";

const SOURCES = ["sessions", "tasks", "commits", "code", "knowledge"];
const history = source => ["sessions", "tasks", "commits"].includes(source);
const fallback = () => ({ notices: ["Search reranking unavailable or its context changed; original ranking retained."] });

/** Capture history BEFORE retrieval. Never accept a caller-supplied session revision.
 * @returns {Promise<{context?: import('./native-contract.js').FederatedRerankContext}>} */
export async function prepareFederatedRerank(root, sources, signal = AbortSignal.timeout(4000)) {
  const settings = await repositoryRerankerSettings();
  if (!settings) return {};
  const policy = await readSourcePolicy(root);
  signal.throwIfAborted();
  const selected = SOURCES.filter(source => sources.includes(source) && policy.enabled[source]);
  const histories = selected.filter(history);
  const { observations } = histories.length ? await probeSnapshots(root, { operation: "snapshot-probe", sources: histories }, signal) : { observations: {} };
  signal.throwIfAborted();
  return { context: { signature: settings.signature, policyRevision: policy.revision, sources: selected,
    history: Object.fromEntries(selected.filter(history).map(source => [source, observations[source]?.source])) } };
}

/** Shared by the agent federation and Desktop's native transport. Return identities
 * only: callers retain original navigation metadata and apply the order once.
 * @returns {Promise<import('./native-contract.js').FederatedRerankResponse>} */
export async function rerankFederated(root, request, dependencies = {}) {
  const signal = dependencies.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const settings = await repositoryRerankerSettings();
  if (!settings) return { notices: [] };
  try {
    const { context, candidates, nativeContext } = request;
    if (!context || context.signature !== settings.signature || typeof request.query !== "string"
      || request.query.length > 2048 || !Array.isArray(candidates) || !candidates.length
      || candidates.length > MAX_RERANK_CANDIDATES || new Set(candidates.map(hit => `${hit.kind}:${hit.id}`)).size !== candidates.length) throw new Error("Invalid context");
    const allHits = candidates.map(hit => {
      if (!SOURCES.includes(hit.kind) || !context.sources?.includes(hit.kind) || typeof hit.id !== "string"
        || typeof hit.title !== "string" || typeof hit.snippet !== "string"
        || (hit.score !== undefined && (!Number.isFinite(hit.score) || hit.score < 0 || hit.score > 1))) throw new Error("Invalid candidate");
      // Historical candidates never upload full sessions, task attachments or diffs.
      return { kind: hit.kind, id: hit.id, path: typeof hit.path === "string" ? hit.path : hit.kind,
        title: hit.title.slice(0, 512), snippet: hit.snippet.slice(0, 4096), score: hit.score ?? 0,
        ...(!history(hit.kind) && typeof hit.content === "string" ? { content: hit.content.slice(0, 7500) } : {}) };
    });
    const allHistories = [...new Set(allHits.map(hit => hit.kind).filter(history))];
    let observations = {};
    if (allHistories.length) {
      try { ({ observations } = await probeSnapshots(root, { operation: "snapshot-probe", sources: allHistories }, AbortSignal.any([signal, AbortSignal.timeout(2000)]))); }
      catch { signal.throwIfAborted(); }
    }
    // Missing or changed history snapshots cannot authorize bytes. Keep these
    // hits local rather than disabling independently current native candidates.
    const excluded = allHits.filter(hit => history(hit.kind)
      && (!context.history?.[hit.kind] || observations[hit.kind]?.source !== context.history[hit.kind]));
    const excludedSet = new Set(excluded);
    const hits = allHits.filter(hit => !excludedSet.has(hit));
    const partialNotices = excluded.length ? ["Search reranking skipped unverified history sources; their local results were retained."] : [];
    if (!hits.length) return { notices: [...partialNotices, ...fallback().notices] };
    const histories = [...new Set(hits.map(hit => hit.kind).filter(history))];
    const natives = hits.filter(hit => !history(hit.kind));
    const states = new Map(Object.entries(nativeContext ?? {}).map(([source, state]) => [source,
      { generation: state.generation, hashes: new Map(Object.entries(state.hashes)) }]));
    const checkCurrent = async (owned, verifyContent) => {
      const policy = await readSourcePolicy(root);
      if (policy.error || policy.revision !== context.policyRevision || allHits.some(hit => !policy.enabled[hit.kind])) throw new Error("Source selection changed");
      const lifecycles = natives.length ? await verifyRerankerCandidates(root, natives, states, owned, verifyContent) : undefined;
      if (verifyContent && histories.length) {
        const { observations } = await probeSnapshots(root, { operation: "snapshot-probe", sources: histories }, owned);
        if (histories.some(source => !context.history?.[source] || observations[source]?.source !== context.history[source])) throw new Error("History changed");
      }
      owned.throwIfAborted();
      return lifecycles;
    };
    const ranked = await rerankNativeHits(request.query, hits, settings, { ...dependencies, signal }, checkCurrent);
    if (ranked.notices.length) return fallback();
    return { order: [...ranked.hits, ...excluded].map(hit => ({ kind: hit.kind, id: hit.id, score: hit.score })), notices: partialNotices };
  } catch {
    signal.throwIfAborted();
    return fallback();
  }
}
