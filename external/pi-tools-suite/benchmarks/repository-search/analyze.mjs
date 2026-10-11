// Re-score retained responses offline; never overwrite the original evidence.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { judge, sha256, summarize } from "./metrics.mjs";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("Usage: node analyze.mjs <retained-run-directory>");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const raw = JSON.parse(await readFile(path.join(root, "results.json"), "utf8"));
const queries = new Map(manifest.queries.map(q => [q.id, q]));
const backends = [...new Set(raw.rows.map(r => r.backend))];
const contents = {};
for (const file of manifest.files) {
  for (const backend of backends) {
    const bytes = await readFile(path.join(root, backend, file.path));
    if (sha256(bytes) !== file.sha256) throw Error(`Snapshot drift: ${backend}/${file.path}`);
    contents[file.path] = bytes.toString("utf8");
  }
}
const rows = raw.rows.map(r => ({ ...r, quality: judge(r.hits, queries.get(r.query), contents) }));
const modes = manifest.paid ? ["lexical", "hybrid", "semantic"] : ["lexical"];
const expectedRows = manifest.queries.length * backends.length * (1 + modes.length * manifest.repeats)
  + (manifest.paid && backends.includes("native") ? 1 : 0);
const phases = Object.fromEntries(backends.map(backend => [backend, Object.fromEntries(modes.map(mode => {
  const matching = rows.filter(r => r.backend === backend && r.mode === mode && r.phase === "warm");
  const fullyWarm = matching.filter(r => r.repeat > 0);
  return [mode, { firstIndexWarm: summarize(matching.filter(r => r.repeat === 0)), warm: summarize(fullyWarm),
    groups: Object.fromEntries(["identifier", "contract", "no-token-overlap"].map(group => [group,
      summarize(fullyWarm.filter(r => r.group === group))])),
    domains: Object.fromEntries(["code", "knowledge"].map(source => [source,
      summarize(fullyWarm.filter(r => queries.get(r.query).source === source))])) }];
}))]));
const output = { executionComplete: !raw.error && rows.length === expectedRows
    && raw.measurements.every(m => m.code === 0) && raw.lifecycle.length === backends.length * 6
    && (!manifest.paid || raw.coverage.at(-1)?.status.complete),
  originalCompleteFlag: raw.complete, expectedRows, actualRows: rows.length,
  freshnessPassed: raw.lifecycle.every(r => r.passed), phases, embedding: raw.embedding,
  lexicalSize: raw.lexicalSize, fullSize: raw.fullSize,
  coverage: raw.coverage.map(r => ({ status: r.status, measurement: r.measurement })),
  lifecycle: raw.lifecycle.map(({ backend, stage, passed, update, measurement }) => ({ backend, stage, passed, update, measurement })),
  cold: rows.filter(r => r.phase !== "warm" && r.query === manifest.queries[0].id)
    .map(({ backend, phase, quality, measurement, nativeStatus }) => ({ backend, phase, quality, measurement, nativeStatus })),
  initialIndex: raw.measurements.filter(m => m.phase === "initial-index") };
await writeFile(path.join(root, "analysis.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
if (!output.executionComplete) process.exitCode = 1;
