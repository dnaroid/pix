import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, readdir, stat, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { repositoryEmbeddingSettings, repositoryEmbeddingKey } from "../../src/project-search/native-embedding-provider.mjs";
import { judge, summarize, sha256, tokens, parseTime } from "./metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "../../../..");
const args = process.argv.slice(2);
const paid = args.includes("--paid");
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const source = path.resolve(value("--from", project));
const out = path.resolve(project, value("--out", `.pi/artifacts/search-benchmark-${Date.now()}`));
if (!out.startsWith(path.join(project, ".pi/artifacts") + path.sep)) throw Error("Output must be under project .pi/artifacts/");
const repeats = Number(value("--repeats", "3"));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw Error("repeats must be 1..5");
const exec = promisify(execFile);
await mkdir(out, { recursive: false });
const meter = path.join(out, "network.jsonl");
await writeFile(meter, "", { mode: 0o600 });
const fixture = JSON.parse(await readFile(path.join(here, "corpus.json"), "utf8"));
const contents = Object.fromEntries(await Promise.all(fixture.files.map(async p => [p, await readFile(path.join(source, p), "utf8")])));
const corpusBytes = Object.values(contents).reduce((n, text) => n + Buffer.byteLength(text), 0);
if (corpusBytes > 1024 * 1024) throw Error("Corpus exceeds 1 MiB consent scope");
const queries = fixture.queries.map(q => ({ ...q, gold: q.targets.map(([p, anchor]) => {
  const lines = contents[p].split(/\r?\n/u);
  const i = lines.findIndex(line => line.includes(anchor));
  if (i < 0) throw Error(`Missing gold anchor ${q.id}: ${p}`);
  if (q.group === "no-token-overlap" && [...tokens(q.query)].some(t => tokens(contents[p]).has(t)))
    throw Error(`No-token-overlap query overlaps target ${q.id}`);
  return { path: p, startLine: i + 1, endLine: i + 1, anchor };
}) }));
const settings = await repositoryEmbeddingSettings(project, false);
const config = JSON.parse(await readFile(path.join(project, ".indexer-cli/config.json"), "utf8"));
if (paid && (!settings || settings.configs.code.provider !== "openrouter"
  || settings.configs.knowledge.identity !== settings.configs.code.identity
  || settings.configs.code.baseUrl !== "https://openrouter.ai/api/v1")) throw Error("Paid harness supports identical saved OpenRouter domains only; never switches provider");
const key = paid ? await repositoryEmbeddingKey() : undefined;
if (paid && !key) throw Error("Saved OpenRouter credential unavailable");
const model = settings?.configs.code.model;
if (paid && model !== "perplexity/pplx-embed-v1-0.6b") throw Error("Reconfirm pricing/budget for this saved model before extending harness");
const safeConfig = Object.fromEntries(Object.entries(config).filter(([k]) =>
  /^(embedding|vectorSize|ollamaBaseUrl|documentEmbedding|knowledgeEmbedding|search|indexInclude|exclude|ignore|include)/u.test(k) && !/key|secret|token/iu.test(k)));
// Explicit original configuration, never overwrite the source project's provider.
const roots = Object.fromEntries(["native", "idx"].map(b => [b, path.join(out, b)]));
await mkdir(path.join(out, "home"));
const env = { ...process.env, HOME: path.join(out, "home"), XDG_CONFIG_HOME: path.join(out, "home/.config"),
  XDG_DATA_HOME: path.join(out, "home/.local/share"), GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null", NODE_OPTIONS: `--import=${path.join(here, "network-meter.mjs")}`,
  SEARCH_BENCH_METER: meter, SEARCH_BENCH_PAID: paid ? "yes" : "no", SEARCH_BENCH_MODEL: model ?? "",
  SEARCH_BENCH_BYTE_CAP: "8000000", OPENROUTER_API_KEY: key ?? "" };
// 8M UTF-8 bytes <= 8M tokens at $0.004/M => $0.032 upper estimate (well below approved $5).
delete env.JEV_API_KEY;
delete env.OPENAI_API_KEY;
const ignored = new Set([".gitignore"]);
for (const filename of fixture.files) {
  let parent = path.dirname(filename);
  while (parent !== ".") { ignored.add(path.join(parent, ".gitignore")); parent = path.dirname(parent); }
}
const ignoreContents = {};
for (const filename of ignored) {
  try { ignoreContents[filename] = await readFile(path.join(source, filename), "utf8"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
}
for (const root of Object.values(roots)) {
  await mkdir(root);
  for (const [p, text] of Object.entries({ ...contents, ...ignoreContents })) {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), text);
  }
  await writeFile(path.join(root, ".gitignore"), (ignoreContents[".gitignore"] ?? "") + "\n.pi/\n.indexer-cli/\n");
  await exec("git", ["init", "-q"], { cwd: root, env });
  await mkdir(path.join(root, ".indexer-cli"));
  await writeFile(path.join(root, ".indexer-cli/config.json"), JSON.stringify(safeConfig, null, 2));
  if (paid) {
    await mkdir(path.join(root, ".pi/search"), { recursive: true });
    await writeFile(path.join(root, ".pi/search/semantic.json"), JSON.stringify({ enabled: true, revision: "benchmark-consent" }));
  }
}
const manifest = { created: new Date().toISOString(), sourceRevision: (await exec("git", ["rev-parse", "HEAD"], { cwd: project })).stdout.trim(),
  workingTreeSnapshot: true, corpusBytes, files: Object.entries(contents).map(([p, t]) => ({ path: p, sha256: sha256(t), bytes: Buffer.byteLength(t) })),
  ignores: Object.entries(ignoreContents).map(([p, t]) => ({ path: p, sha256: sha256(t) })), queries,
  platform: { node: process.version, os: os.type(), release: os.release(), arch: os.arch(), cpus: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  provider: paid ? settings.configs : null, idxVersion: (await exec("idx", ["--no-auto-update", "--version"], { env })).stdout.trim(),
  paid, repeats, safeConfig, harnessFiles: await Promise.all(["run.mjs", "worker.mjs", "metrics.mjs", "network-meter.mjs", "corpus.json"].map(async p => ({ path: p, sha256: sha256(await readFile(path.join(here, p))) }))) };
const engineDirectory = path.resolve(here, "../../src/project-search");
manifest.engineFiles = await Promise.all((await readdir(engineDirectory)).filter(p => /\.(ts|mjs)$/u.test(p)).sort()
  .map(async p => ({ path: path.relative(project, path.join(engineDirectory, p)), sha256: sha256(await readFile(path.join(engineDirectory, p))) })));
await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
await mkdir(path.join(out, "commands"));
let sequence = 0;
const measurements = [], rows = [], coverage = [], lifecycle = [];
async function measured(backend, phase, command, argv) {
  const id = `${String(++sequence).padStart(4, "0")}-${backend}-${phase}`;
  const base = path.join(out, "commands", id);
  const flags = process.platform === "darwin" ? ["-l"] : ["-f", "BENCH_RESOURCE %U %S %M"];
  const start = performance.now();
  let result, code = 0;
  try { result = await exec("/usr/bin/time", [...flags, command, ...argv], { cwd: roots[backend],
    env: { ...env, SEARCH_BENCH_BACKEND: backend, SEARCH_BENCH_PHASE: phase }, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { result = e; code = e.code ?? "unknown"; }
  const m = { id, backend, phase, command, argv, code, wallMs: performance.now() - start,
    ...parseTime(result.stderr ?? "", process.platform), stdout: path.relative(project, base + ".stdout"), stderr: path.relative(project, base + ".stderr") };
  await writeFile(base + ".stdout", result.stdout ?? "");
  await writeFile(base + ".stderr", result.stderr ?? "");
  measurements.push(m);
  if (code !== 0) throw Error(`Measured command failed (${code}); ${m.stderr}`);
  return { measurement: m, stdout: result.stdout };
}
async function search(backend, phase, request) {
  const file = path.join(out, "commands", `${String(sequence + 1).padStart(4, "0")}-request.json`);
  await writeFile(file, JSON.stringify(request));
  const result = await measured(backend, phase, process.execPath, ["--import", path.join(project, "node_modules/tsx/dist/loader.mjs"), path.join(here, "worker.mjs"), roots[backend], file]);
  return { ...result, response: JSON.parse(result.stdout) };
}
async function indexSize(backend) {
  const walk = async dir => {
    let n = 0;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, entry.name);
      n += entry.isDirectory() ? await walk(p) : (await stat(p)).size;
    }
    return n;
  };
  return { nativeSearchBytes: await walk(path.join(roots[backend], ".pi/search")), idxStorageBytes: await walk(path.join(roots[backend], ".indexer-cli")) };
}
const request = (q, backend, mode) => ({ query: q.query, sources: [q.source], indexBackend: backend,
  indexMode: mode, limit: 10, maxFiles: 10, dedupeFile: true, includeContent: true });
async function save(extra = {}) {
  await writeFile(path.join(out, "results.json"), JSON.stringify({ measurements, rows, coverage, lifecycle, ...extra }, null, 2));
}
try {
  const backends = paid ? ["native", "idx"] : ["native"];
  if (paid) {
    await measured("idx", "initial-index", "idx", ["--no-auto-update", "init"]);
    const indexedSettings = await repositoryEmbeddingSettings(roots.idx, false);
    if (indexedSettings?.configs.code.identity !== settings.configs.code.identity
      || indexedSettings?.configs.knowledge.identity !== settings.configs.knowledge.identity) throw Error("IDX initialization changed saved provider identity");
  }
  for (const backend of backends) {
    for (const [i, q] of queries.entries()) {
      const result = await search(backend, i ? "first-pass-lexical" : "cold-start-lexical", request(q, backend, "lexical"));
      rows.push({ backend, mode: "lexical", phase: "first-pass", query: q.id, group: q.group,
        measurement: result.measurement, hits: result.response.hits, notices: result.response.notices,
        quality: judge(result.response.hits, q, contents) });
    }
  }
  const lexicalSize = Object.fromEntries(await Promise.all(backends.map(async b => [b, await indexSize(b)])));
  if (paid) {
    const q = queries[0];
    const cold = await search("native", "cold-start-semantic", request(q, "native", "semantic"));
    rows.push({ backend: "native", mode: "semantic", phase: "partial", query: q.id, group: q.group,
      measurement: cold.measurement, hits: cold.response.hits, notices: cold.response.notices,
      nativeStatus: cold.response.nativeStatus, quality: judge(cold.response.hits, q, contents) });
    for (let i = 0; i < 20; i++) {
      const result = await search("native", "semantic-backfill", { coverage: true, query: queries[0].query });
      coverage.push({ iteration: i + 1, measurement: result.measurement, status: result.response.status.semantic, notices: result.response.notices });
      await save();
      if (result.response.status.semantic?.complete) break;
      if (i === 19) throw Error("Native coverage not complete after 20 bounded searches");
    }
    if (!coverage.at(-1)?.status?.complete) throw Error("Semantic fallback is not a measured semantic run");
  }
  for (const mode of paid ? ["lexical", "hybrid", "semantic"] : ["lexical"]) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Alternate backend order between repetitions to reduce first-run/cache ordering bias.
      for (const q of queries) for (const backend of repeat % 2 ? [...backends].reverse() : backends) {
        const result = await search(backend, `${mode}-warm-${repeat + 1}`, request(q, backend, mode));
        if (backend === "native" && mode !== "lexical" && (result.response.nativeStatus?.mode !== mode
          || !result.response.nativeStatus.semantic?.complete)) throw Error("Warm native semantic fallback/partial coverage is not a semantic measurement");
        rows.push({ backend, mode, phase: "warm", repeat, query: q.id, group: q.group, measurement: result.measurement,
          hits: result.response.hits, notices: result.response.notices, quality: judge(result.response.hits, q, contents) });
      }
      await save();
    }
    await save();
  }
  const fullSize = Object.fromEntries(await Promise.all(backends.map(async b => [b, await indexSize(b)])));
  const probeDir = "search-benchmark-probes/nested";
  const probe = path.join(probeDir, "probe.ts"), renamed = path.join(probeDir, "renamed.ts");
  const old = "ZebraLedgerBefore", fresh = "ZebraLedgerAfter";
  const stages = [
    { name: "add", expected: true, query: old, change: async root => { await mkdir(path.join(root, probeDir), { recursive: true }); await writeFile(path.join(root, probe), `export function ${old}() { return 47; }\n`); } },
    { name: "modify", expected: true, query: fresh, absentQuery: old, change: root => writeFile(path.join(root, probe), `export function ${fresh}() { return 48; }\n`) },
    { name: "rename", expected: true, query: fresh, path: renamed, change: async root => { await copyFile(path.join(root, probe), path.join(root, renamed)); const { unlink } = await import("node:fs/promises"); await unlink(path.join(root, probe)); } },
    { name: "nested-ignore-add", expected: false, query: fresh, change: root => writeFile(path.join(root, probeDir, ".gitignore"), "renamed.ts\n") },
    { name: "nested-ignore-change", expected: true, query: fresh, path: renamed, change: root => writeFile(path.join(root, probeDir, ".gitignore"), "!renamed.ts\n") },
    { name: "delete", expected: false, query: fresh, change: async root => { const { unlink } = await import("node:fs/promises"); await unlink(path.join(root, renamed)); } },
  ];
  for (const stage of stages) for (const backend of backends) {
    await stage.change(roots[backend]);
    const update = backend === "idx" ? (await measured(backend, `incremental-${stage.name}`, "idx", ["--no-auto-update", "index"])).measurement : null;
    const result = await search(backend, `freshness-${stage.name}`, { query: stage.query, sources: ["code"], indexMode: "lexical", indexBackend: backend, limit: 10, maxFiles: 10, includeContent: true });
    const present = result.response.hits.some(h => h.path === (stage.path ?? probe) || h.path === renamed);
    const correctPath = !stage.expected || result.response.hits.some(h => h.path === (stage.path ?? probe));
    let oldAbsent = true;
    if (stage.absentQuery) {
      const check = await search(backend, "freshness-old-absent", { query: stage.absentQuery, sources: ["code"], indexMode: "lexical", indexBackend: backend });
      // Lexical prefix-token matches can legitimately return the changed file.
      // Staleness is old text in that file, not the mere presence of its path.
      oldAbsent = !check.response.hits.some(h => h.path.startsWith(probeDir)
        && (h.content ?? h.snippet ?? "").includes(stage.absentQuery));
    }
    lifecycle.push({ backend, stage: stage.name, expected: stage.expected, present, correctPath, oldAbsent,
      passed: present === stage.expected && correctPath && oldAbsent, update, measurement: result.measurement,
      hits: result.response.hits, notices: result.response.notices });
    await save();
  }
  const summary = {}, firstIndexWarm = {};
  for (const b of backends) for (const mode of paid ? ["lexical", "hybrid", "semantic"] : ["lexical"]) {
    // The first repetition can still build query vectors. Report it separately
    // from repeated queries against fully filled document/query caches.
    const selected = rows.filter(r => r.backend === b && r.mode === mode && r.phase === "warm" && r.repeat > 0);
    firstIndexWarm[`${b}/${mode}`] = summarize(rows.filter(r => r.backend === b && r.mode === mode && r.phase === "warm" && r.repeat === 0));
    summary[`${b}/${mode}`] = { ...summarize(selected), groups: Object.fromEntries([...new Set(queries.map(q => q.group))].map(g => [g, summarize(selected.filter(r => r.group === g))])) };
  }
  const network = (await readFile(meter, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const embedding = Object.fromEntries(backends.map(b => {
    const events = network.filter(n => n.backend === b);
    const usage = events.filter(n => n.usage);
    const totalTokens = usage.reduce((n, e) => n + (e.usage.total_tokens ?? e.usage.prompt_tokens ?? 0), 0);
    return [b, { requests: events.filter(e => e.reservedBytes).length, inputs: events.reduce((n, e) => n + (e.inputs ?? 0), 0),
      bytes: events.reduce((n, e) => n + (e.reservedBytes ?? 0), 0), blockedRequests: events.filter(e => e.blocked).length,
      usageResponses: usage.length, totalTokens: totalTokens || null, estimatedUsd: totalTokens ? totalTokens * .004 / 1e6 : null,
      billedUsd: usage.some(e => Number.isFinite(e.usage.cost)) ? usage.reduce((n, e) => n + (e.usage.cost ?? 0), 0) : null }];
  }));
  // An observed backend defect is a completed comparison, not an aborted run.
  const complete = !paid || coverage.at(-1).status.complete;
  await save({ complete, freshnessPassed: lifecycle.every(r => r.passed), summary, firstIndexWarm, lexicalSize, fullSize, embedding,
    limitations: ["Cold-start means fresh process/index, not dropped OS page cache", "Resource time/RSS covers process tree as reported by time; RSS is peak child, not simultaneous sum", "Anchor-based targeted gold, not exhaustive human relevance judgments", "IDX init/index embeds even for lexical retrieval; no pure lexical IDX indexing command", "No-paid runs measure native only; IDX and semantics remain unmeasured", "Different chunking/input formatting remains a confound despite same saved provider/model"] });
  console.log(JSON.stringify({ output: path.relative(project, out), complete, summary, embedding }, null, 2));
  if (!complete) process.exitCode = 1;
} catch (error) {
  await save({ complete: false, error: String(error) });
  console.error(`${error}\nPartial evidence: ${path.relative(project, out)}/results.json`);
  process.exitCode = 1;
}
