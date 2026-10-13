import { runSearchSource } from "./search-source-deadline";

/** Unlike source enrichment, a reranker deadline discards late completions.
 * Bounds the wait even if an adapter ignores AbortSignal. */
export async function requestFederatedSearch<T>(signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const owner = new AbortController();
  let value: T | undefined;
  let failure: unknown;
  const outcome = await runSearchSource(AbortSignal.any([signal, owner.signal]), async owned => {
    const response = await operation(owned);
    if (!owned.aborted) value = response;
  }, () => owner.abort(new Error("Search reranking timed out")), error => { failure = error; }, timeoutMs);
  if (outcome !== "completed" || failure || value === undefined) throw new Error("Search reranking unavailable");
  return value;
}
