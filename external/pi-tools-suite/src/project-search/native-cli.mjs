let request;
const policyOperation = () => request?.operation === "source-policy" || request?.operation === "set-source-policy";
const failed = notice => policyOperation()
  ? { enabled: { settings: false, code: false, knowledge: false, sessions: false, tasks: false, commits: false }, error: notice }
  : request?.operation === "rerank-prepare" ? {}
  : request?.operation === "rerank" ? { notices: ["Search reranking unavailable; original ranking retained."] }
  : request?.operation === "index-control" ? { accepted: false, error: notice }
  : request?.operation === "snapshot-probe"
  ? { observations: {}, error: "Cheap change check unavailable; freshness is unchecked." }
  : request?.operation === "index"
  ? { source: request.source === "knowledge" ? "knowledge" : "code", complete: false, message: notice }
  : { hits: [], notices: [notice], status: { backend: "native", complete: false, stale: true } };
// Bound input/retrieval, but explicit indexing drains until completion or cancellation.
const timer = setTimeout(() => {
  process.stdout.write(JSON.stringify(failed(policyOperation()
    ? "Search source selection timed out; refresh before retrying."
    : request?.operation === "index"
    ? "Native indexing timed out; coverage is unverified. Cached embeddings are retained."
    : "Native search timed out; results are incomplete.")), () => process.exit(0));
}, 40_000);
try {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new Error("Request too large");
    chunks.push(chunk);
  }
  request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (bytes > 16_384 && request?.operation !== "rerank") throw new Error("Request too large");
  if (request?.operation === "rerank-prepare" || request?.operation === "rerank") {
    const { prepareFederatedRerank, rerankFederated } = await import("./federation-reranker.mjs");
    const result = request.operation === "rerank-prepare"
      ? await prepareFederatedRerank(process.argv[2], request.sources)
      : await rerankFederated(process.argv[2], request);
    clearTimeout(timer);
    process.stdout.write(JSON.stringify(result));
  } else if (request?.operation === "snapshot-probe") {
    const { probeSnapshots } = await import("./snapshot-probe.mjs");
    const { readManualRuns } = await import("./index-control.mjs");
    const result = await probeSnapshots(process.argv[2], request);
    result.runs = await readManualRuns(process.argv[2]).catch(() => ({}));
    clearTimeout(timer);
    process.stdout.write(JSON.stringify(result));
  } else if (request?.operation === "index-control") {
    const { controlManualIndex } = await import("./index-control.mjs");
    const result = await controlManualIndex(process.argv[2], request);
    clearTimeout(timer);
    process.stdout.write(JSON.stringify(result));
  } else if (policyOperation()) {
    const { readSourcePolicy, writeSourcePolicy } = await import("./source-policy.mjs");
    const { SourcePolicyLockError } = await import("./source-policy-lock.mjs");
    let result;
    try {
      result = request.operation === "source-policy" ? await readSourcePolicy(process.argv[2])
        : await writeSourcePolicy(process.argv[2], request.source, request.enabled);
    } catch (error) {
      result = failed(error instanceof SourcePolicyLockError ? error.message
        : "Search source selection could not be saved. Check .pi/workspace.jsonc and retry.");
    }
    clearTimeout(timer);
    process.stdout.write(JSON.stringify(result));
  } else {
    if (request?.operation === "index") clearTimeout(timer);
    const { searchNative, indexNative } = await import("./native-engine.mjs");
    const response = await (request?.operation === "index" ? indexNative : searchNative)(process.argv[2], request);
    clearTimeout(timer);
    process.stdout.write(JSON.stringify(response));
  }
} catch {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify(failed(policyOperation()
    ? "Search source selection unavailable; refresh and retry."
    : request?.operation === "index"
    ? "Native indexing failed; coverage is unverified. Cached embeddings are retained."
    : "Native search failed; results are incomplete.")));
}
