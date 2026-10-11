let request;
const failed = notice => request?.operation === "index"
  ? { source: request.source === "knowledge" ? "knowledge" : "code", complete: false, message: notice }
  : { hits: [], notices: [notice], status: { backend: "native", complete: false, stale: true } };
// A process-level ceiling bounds requests independently of the Node/Bun caller.
const timer = setTimeout(() => {
  process.stdout.write(JSON.stringify(failed(request?.operation === "index"
    ? "Native indexing timed out; coverage is unverified. Cached embeddings are retained."
    : "Native search timed out; results are incomplete.")), () => process.exit(0));
}, 40_000);
try {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16_384) throw new Error("Request too large");
    chunks.push(chunk);
  }
  request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { searchNative, indexNative } = await import("./native-engine.mjs");
  const response = await (request?.operation === "index" ? indexNative : searchNative)(process.argv[2], request);
  clearTimeout(timer);
  process.stdout.write(JSON.stringify(response));
} catch {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify(failed(request?.operation === "index"
    ? "Native indexing failed; coverage is unverified. Cached embeddings are retained."
    : "Native search failed; results are incomplete.")));
}
