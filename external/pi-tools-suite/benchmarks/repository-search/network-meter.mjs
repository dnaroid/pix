// Loaded in every measured Node child (including native subprocesses and IDX).
// Records amounts/usage only, never request text, headers, keys or response bodies.
import { appendFileSync, readFileSync } from "node:fs";

const original = globalThis.fetch;
const filename = process.env.SEARCH_BENCH_METER;
if (filename) {
  const record = row => appendFileSync(filename, JSON.stringify({ backend: process.env.SEARCH_BENCH_BACKEND,
    phase: process.env.SEARCH_BENCH_PHASE, ...row }) + "\n", { mode: 0o600 });
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://openrouter.ai/api/v1/embeddings" || process.env.SEARCH_BENCH_PAID !== "yes") {
      record({ blocked: true });
      throw new Error("Benchmark network policy: only explicitly approved saved embeddings are allowed");
    }
    const body = JSON.parse(init?.body ?? "{}");
    if (body.model !== process.env.SEARCH_BENCH_MODEL) throw new Error("Benchmark model mismatch");
    const input = Array.isArray(body.input) ? body.input : [body.input];
    if (!input.every(s => typeof s === "string")) throw new Error("Invalid embedding inputs");
    const bytes = input.reduce((s, t) => s + Buffer.byteLength(t), 0);
    // Synchronous reservation before fetch also covers concurrent IDX batches/retries.
    const prior = readFileSync(filename, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const used = prior.reduce((s, r) => s + (r.reservedBytes ?? 0), 0);
    if (used + bytes > Number(process.env.SEARCH_BENCH_BYTE_CAP)) throw new Error("Benchmark embedding byte cap reached");
    if (prior.reduce((s, r) => s + (r.inputs ?? 0), 0) + input.length > 1000) throw new Error("Benchmark 1000-input cap reached");
    record({ reservedBytes: bytes, inputs: input.length });
    const response = await original(url, init);
    try {
      const data = await response.clone().json();
      const usage = data.usage && Object.fromEntries(["prompt_tokens", "total_tokens", "cost"].filter(k => Number.isFinite(data.usage[k])).map(k => [k, data.usage[k]]));
      record({ status: response.status, usage: usage ?? null });
    } catch { record({ status: response.status, usage: null }); }
    return response;
  };
}
