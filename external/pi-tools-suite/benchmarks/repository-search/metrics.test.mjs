import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { judge, percentile, summarize, parseTime, tokens, sha256 } from "./metrics.mjs";

const contents = { "a.ts": "first\nexport function expected() {}\nlast", "b.ts": "irrelevant" };
const query = { gold: [{ path: "a.ts", startLine: 2, endLine: 2, anchor: "expected" }] };
const correct = { path: "a.ts", startLine: 2, endLine: 2, snippet: "Lines 2–2 · export function expected() {}" };
test("gold requires correct path AND overlapping lines, not a matching path alone", () => {
  const wrongRange = { ...correct, startLine: 1, endLine: 1, snippet: "first" };
  const quality = judge([wrongRange, correct], query, contents);
  assert.equal(quality.mrr, .5);
  assert.equal(quality.recallAt5, 1);
  assert.equal(quality.precisionAt10, .1);
  assert.equal(quality.anchorVisible, 1);
});
test("multiple gold files and top-k cutoff", () => {
  const q = { gold: [...query.gold, { path: "b.ts", startLine: 1, endLine: 1, anchor: "irrelevant" }] };
  const hits = [correct, ...Array.from({ length: 4 }, () => ({ path: "missing.ts", startLine: 1, endLine: 1 })),
    { path: "b.ts", startLine: 1, endLine: 1, snippet: "irrelevant" }];
  assert.equal(judge(hits, q, contents).recallAt5, .5);
  assert.equal(judge(hits, q, contents).recallAt10, 1);
});
test("zero hits do not fabricate 100% accuracy; nonexistent/out-of-range/text drift rejected", () => {
  assert.equal(judge([], query, contents).mrr, 0);
  const quality = judge([{ ...correct, snippet: "fabricated text" }, { ...correct, path: "missing.ts" },
    { ...correct, endLine: 99 }], query, contents);
  assert.equal(quality.validRanges, 1);
  assert.equal(quality.textAccurate, 0);
  const summary = summarize([{ quality: judge([], query, contents), measurement: { wallMs: 10 } }]);
  assert.equal(summary.validRangeRate, null);
  assert.equal(summary.anchorVisibility, null);
});
test("nearest-rank percentiles and OS-specific resource units", () => {
  assert.equal(percentile([4, 1, 3, 2], .5), 2);
  assert.equal(percentile([], .95), null);
  assert.deepEqual(parseTime("0.40 real 0.21 user 0.03 sys\n1048576 maximum resident set size", "darwin"),
    { cpuMs: 240, peakRssBytes: 1048576 });
  assert.deepEqual(parseTime("BENCH_RESOURCE 0.21 0.03 1024", "linux"), { cpuMs: 240, peakRssBytes: 1048576 });
});
test("no-token-overlap includes Unicode and underscores", () => {
  assert.deepEqual([...tokens("ТЕКСТ api_key")], ["текст", "api_key"]);
});
test("preview ellipsis is formatting, but text from outside the declared range is inaccurate", () => {
  assert.equal(judge([{ ...correct, snippet: "Lines 2–2 · export function ex…" }], query, contents).textAccurate, 1);
  assert.equal(judge([{ ...correct, startLine: 1, endLine: 1 }], query, contents).textAccurate, 0);
});
test("offline analysis distinguishes completed findings from truncated runs and rejects snapshot drift", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const temporary = await mkdtemp(path.join(root, ".pi/artifacts/search-analysis-test-"));
  const filename = path.join(temporary, "native/a.ts");
  const script = fileURLToPath(new URL("./analyze.mjs", import.meta.url));
  try {
    await mkdir(path.dirname(filename));
    await writeFile(filename, contents["a.ts"]);
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify({ paid: false, repeats: 1,
      files: [{ path: "a.ts", sha256: sha256(contents["a.ts"]) }],
      queries: [{ ...query, id: "example", source: "code" }] }));
    const row = { backend: "native", mode: "lexical", query: "example", hits: [], measurement: { wallMs: 1 } };
    const raw = { rows: [{ ...row, phase: "cold" }, { ...row, phase: "warm", repeat: 0 }],
      measurements: [{ code: 0 }], lifecycle: Array.from({ length: 6 }, () => ({ passed: false })), coverage: [] };
    await writeFile(path.join(temporary, "results.json"), JSON.stringify(raw));
    const run = () => promisify(execFile)(process.execPath, [script, temporary], { env: { ...process.env, NODE_OPTIONS: "" } });
    await run();
    const analysis = JSON.parse(await readFile(path.join(temporary, "analysis.json"), "utf8"));
    assert.equal(analysis.executionComplete, true);
    assert.equal(analysis.freshnessPassed, false);
    assert.equal(analysis.phases.native.lexical.warm.n, 0);
    await writeFile(path.join(temporary, "results.json"), JSON.stringify({ ...raw, rows: [raw.rows[0]] }));
    await assert.rejects(run(), e => e.code === 1);
    await writeFile(filename, "changed");
    await assert.rejects(run(), /Snapshot drift/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test("network meter blocks nonapproved calls, enforces reservations, and redacts bodies/usage", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const temporary = await mkdtemp(path.join(root, ".pi/artifacts/search-meter-test-"));
  const meter = path.join(temporary, "meter.jsonl");
  const hook = new URL("./network-meter.mjs", import.meta.url).href;
  const script = `
    import {writeFileSync, readFileSync} from 'node:fs';
    import assert from 'node:assert/strict';
    writeFileSync(process.env.SEARCH_BENCH_METER, '');
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({usage:{total_tokens:2,cost:0.0001,secret:'NEVER_LOG'}})); };
    await import(${JSON.stringify(hook)});
    await assert.rejects(fetch('https://unapproved.invalid/'), /network policy/);
    const request = input => ({body:JSON.stringify({model:'test-model',input})});
    await assert.rejects(fetch('https://openrouter.ai/api/v1/embeddings',{body:JSON.stringify({model:'wrong',input:'ab'})}), /model mismatch/);
    await fetch('https://openrouter.ai/api/v1/embeddings', request('abc'));
    await assert.rejects(fetch('https://openrouter.ai/api/v1/embeddings',request('abcd')), /byte cap/);
    assert.equal(calls, 1);
    const text = readFileSync(process.env.SEARCH_BENCH_METER,'utf8');
    assert(!text.includes('NEVER_LOG'));
    assert(!text.includes('abc'));
    assert(text.includes('total_tokens'));
  `;
  try {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env,
      NODE_OPTIONS: "", SEARCH_BENCH_METER: meter, SEARCH_BENCH_MODEL: "test-model", SEARCH_BENCH_PAID: "yes", SEARCH_BENCH_BYTE_CAP: "5" } });
    assert.equal((await readFile(meter, "utf8")).trim().split("\n").length, 3);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
