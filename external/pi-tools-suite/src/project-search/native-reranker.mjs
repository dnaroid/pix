import { digest, parseSemanticConfiguration, semanticConfigurationText, repositoryEmbeddingKey } from "./native-embedding-provider.mjs";
import { withProviderSlot } from "./source-work.mjs";
import { rerankerDocuments, MAX_RERANK_INPUT_BYTES } from "./reranker-documents.mjs";

export const MAX_RERANK_CANDIDATES = 100;
export async function repositoryRerankerSettings() {
  try {
    const model = parseSemanticConfiguration(await semanticConfigurationText()).search?.rerankerModel;
    if (typeof model !== "string" || !model.trim() || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) return;
    return { model: model.trim(), signature: digest(model.trim()) };
  } catch { return; }
}

/** Dedicated endpoint, not a chat completion. Never expose provider error bodies. */
export async function rerankRepository(query, documents, model, key, signal) {
  if (!key || !documents.length || documents.length > MAX_RERANK_CANDIDATES
    || documents.some(text => typeof text !== "string" || !text || text.length > 8192)
    || Buffer.byteLength(query) + documents.reduce((total, text) => total + Buffer.byteLength(text), 0) > MAX_RERANK_INPUT_BYTES) throw new Error("Reranking prerequisites unavailable");
  signal.throwIfAborted();
  const response = await fetch("https://openrouter.ai/api/v1/rerank", {
    method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, query, documents, top_n: documents.length }),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Reranking unavailable"); }
  const reader = response.body.getReader(), parts = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 128 * 1024) throw new Error("Reranking response too large");
      parts.push(part.value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(parts).toString("utf8")).results;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function orderedHits(hits, results) {
  const indices = new Set();
  if (!Array.isArray(results) || results.length !== hits.length) throw new Error("Invalid reranking response");
  for (const result of results) {
    if (!Number.isInteger(result?.index) || result.index < 0 || result.index >= hits.length || indices.has(result.index)
      || typeof result.relevance_score !== "number" || !Number.isFinite(result.relevance_score)
      || result.relevance_score < 0 || result.relevance_score > 1) throw new Error("Invalid reranking response");
    indices.add(result.index);
  }
  return [...results].sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
    .map(result => ({ ...hits[result.index], score: result.relevance_score }));
}

/** The caller owns freshness/source checks. Errors retain the entire original list. */
export async function rerankNativeHits(query, hits, settings, dependencies, checkCurrent) {
  if (!settings || !hits.length) return { hits, notices: [], limitNotices: [], completeForSelection: true };
  const caller = dependencies.signal ?? new AbortController().signal;
  const owner = new AbortController();
  const signal = AbortSignal.any([caller, owner.signal, AbortSignal.timeout(4000)]);
  let checking = false, closed = false;
  const current = async (verifyContent = false) => {
    signal.throwIfAborted();
    if ((await repositoryRerankerSettings())?.signature !== settings.signature) throw new Error("Reranker configuration changed");
    const lifecycles = await checkCurrent(signal, verifyContent);
    signal.throwIfAborted();
    return lifecycles;
  };
  const timer = setInterval(() => {
    if (checking || closed) return;
    checking = true;
    void current().catch(() => { if (!closed) owner.abort(); }).finally(() => { checking = false; });
  }, 200);
  try {
    const lifecycles = await current(true);
    const key = await (dependencies.rerankerKey ?? repositoryEmbeddingKey)();
    if (!key) throw new Error("Reranking credentials unavailable");
    const candidates = hits.slice(0, MAX_RERANK_CANDIDATES);
    const documents = rerankerDocuments(query, candidates, lifecycles);
    const results = await withProviderSlot(signal, async () => {
      await current(true);
      return (dependencies.rerank ?? rerankRepository)(query, documents, settings.model, key, signal);
    });
    await current(true);
    const limitNotices = hits.length > candidates.length
      ? ["Native reranking candidate limit reached; results are partial."] : [];
    return { hits: orderedHits(candidates, results), notices: limitNotices, limitNotices, completeForSelection: true };
  } catch {
    caller.throwIfAborted();
    return { hits, notices: ["Native reranking unavailable or its context changed; original ranking retained."], limitNotices: [], completeForSelection: false };
  } finally { closed = true; clearInterval(timer); }
}
