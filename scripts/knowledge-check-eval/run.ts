import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROJECT_ARTIFACTS_DIR } from "../../external/pi-tools-suite/src/artifact-paths.js";
import { compareKnowledge } from "../../acp/src/knowledge/comparison.js";
import { checkKnowledgeChunks, splitKnowledgeDocument } from "../../acp/src/knowledge/chunks.js";
import type { KnowledgeSnapshot } from "../../acp/src/knowledge/evidence.js";
import { knowledgeEvalCases, type KnowledgeEvalCase } from "./cases.js";
import { scoreKnowledgeEval } from "./scoring.js";
import { openKnowledgeEvalRuntime, type KnowledgeEvalThinking } from "./runtime.js";
import { collectRetrievalFixture } from "./retrieval.js";
import { writeKnowledgeEvalReport, summarizeKnowledgeEval, type KnowledgeEvalReport, type KnowledgeEvalRun } from "./report.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function parseKnowledgeEvalArguments(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], allowPositionals: false, options: {
    live: { type: "boolean", default: false }, list: { type: "boolean", default: false },
    model: { type: "string" }, thinking: { type: "string", default: "low" },
    mode: { type: "string", default: "judge" }, cases: { type: "string" },
    repeat: { type: "string", default: "1" }, "max-calls": { type: "string", default: "24" },
    "timeout-ms": { type: "string", default: "120000" }, "budget-ms": { type: "string", default: "900000" },
    output: { type: "string" },
  } });
  const integer = (value: string, name: string, maximum: number) => {
    const number = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`Invalid ${name}.`);
    return number;
  };
  const mode = values.mode;
  if (mode !== "judge" && mode !== "retrieval" && mode !== "all") throw new Error("Mode must be judge, retrieval or all.");
  const thinking = values.thinking;
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking)) throw new Error("Invalid thinking level.");
  const ids = values.cases?.split(",").filter(Boolean);
  if (ids?.some(id => !knowledgeEvalCases.some(item => item.id === id))) throw new Error("Unknown evaluation case.");
  const selected = ids ? knowledgeEvalCases.filter(item => ids.includes(item.id)) : [...knowledgeEvalCases];
  if (!selected.length) throw new Error("No evaluation cases selected.");
  if (values.live && !values.model) throw new Error("An explicit --model provider/model is required for live evaluation.");
  return { live: values.live, list: values.list, modelRef: values.model, thinking: thinking as KnowledgeEvalThinking,
    mode, selected, explicitCases: ids !== undefined,
    repetitions: integer(values.repeat, "repeat", 3), maxCalls: integer(values["max-calls"], "max-calls", 64),
    timeoutMs: integer(values["timeout-ms"], "timeout-ms", 180_000),
    budgetMs: integer(values["budget-ms"], "budget-ms", 3_600_000), output: values.output };
}

function suppliedSnapshot(fixture: KnowledgeEvalCase, text: string): KnowledgeSnapshot {
  const paths = new Set(fixture.evidence.map(source => source.path));
  return { document: { path: fixture.document.path, text }, documentHash: hash(text), wikiPath: "wiki",
    evidence: [...fixture.evidence], candidatePaths: [...paths], complete: true, notices: [], current: async () => true,
    coverage: { scope: "retrieved-passages", checkedPassages: fixture.evidence.length,
      candidateSources: paths.size, excerptedSources: 0, limits: [] } };
}

async function sourceIdentity() {
  const files = ["acp/src/knowledge/comparison.ts", "acp/src/knowledge/evidence.ts", "acp/src/knowledge/chunks.ts",
    "acp/src/knowledge/chunk-report.ts", "acp/src/knowledge/report-language.ts", "acp/src/knowledge/native-search.ts",
    "scripts/knowledge-check-eval/cases.ts", "scripts/knowledge-check-eval/scoring.ts", "scripts/knowledge-check-eval/run.ts",
    "scripts/knowledge-check-eval/runtime.ts", "scripts/knowledge-check-eval/report.ts", "scripts/knowledge-check-eval/retrieval.ts"];
  return { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim().length > 0,
    hashes: Object.fromEntries(await Promise.all(files.map(async path => [path, hash(await readFile(join(repository, path), "utf8"))]))) };
}

export async function runKnowledgeEval(args = process.argv.slice(2)): Promise<number> {
  const options = parseKnowledgeEvalArguments(args);
  const retrievalCases = options.explicitCases ? options.selected.filter(item => !item.chunked)
    : options.selected.filter(item => item.expected === "conflict" && !item.chunked).slice(0, 3);
  const plan: { fixture: KnowledgeEvalCase; stage: "judge" | "retrieval" }[] = options.selected.flatMap(
    fixture => options.mode === "retrieval" ? [] : [{ fixture, stage: "judge" as const }]);
  if (options.mode !== "judge") plan.push(...retrievalCases.map(fixture => ({ fixture, stage: "retrieval" as const })));
  const plannedCalls = options.repetitions * plan.reduce((total, item) => {
    const parts = item.fixture.chunked ? splitKnowledgeDocument(item.fixture.document).length : 1;
    return total + parts * (parts + 1) / 2;
  }, 0);
  if (options.list || !options.live) {
    console.log(JSON.stringify({ live: false, requiresLive: true, plannedCalls,
      cases: plan.map(({ fixture, stage }) => ({ id: fixture.id, title: fixture.title, expected: fixture.expected, stage })) }, null, 2));
    return 0;
  }
  if (/^(1|true|yes)$/iu.test((process.env.PI_OFFLINE ?? "").trim())) throw new Error("PI_OFFLINE forbids live evaluation.");
  if (plannedCalls > options.maxCalls) throw new Error(`Plan needs ${plannedCalls} model calls; --max-calls is ${options.maxCalls}.`);
  if (!plan.length) throw new Error("No compatible cases for the selected mode.");
  const artifacts = join(await realpath(repository), PROJECT_ARTIFACTS_DIR);
  await mkdir(artifacts, { recursive: true });
  const output = options.output ? resolve(repository, options.output) : await mkdtemp(join(artifacts, "wiki-contradiction-eval-"));
  if (!output.startsWith(artifacts + sep)) throw new Error("Evaluation output must be a unique task directory under this project's .pi/artifacts/.");
  await mkdir(output, { recursive: true });
  if (!(await realpath(output)).startsWith((await realpath(artifacts)) + sep)) throw new Error("Evaluation output escapes its artifact directory.");
  await writeFile(join(output, "run-owner.json"), JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }) + "\n", { flag: "wx", mode: 0o600 });
  const source = await sourceIdentity();
  const plannedRuns = Array.from({ length: options.repetitions }, (_, index) => plan.map(({ fixture, stage }) => ({
    id: fixture.id, title: fixture.title, stage, repetition: index + 1, expected: fixture.expected,
    expectedConflictPairs: fixture.expectedPairs.filter(pair => pair.outcome === "conflict").length,
  }))).flat();
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Evaluation interrupted."));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const deadline = setTimeout(() => controller.abort(new Error("Evaluation time budget exhausted.")), options.budgetMs);
  let runtime: Awaited<ReturnType<typeof openKnowledgeEvalRuntime>> | undefined;
  const runs: KnowledgeEvalRun[] = [];
  let report: KnowledgeEvalReport = { version: 1, startedAt: new Date().toISOString(),
    model: { modelRef: options.modelRef }, thinking: options.thinking, source,
    maxCalls: options.maxCalls, plannedCalls,
    plannedCases: { judge: plannedRuns.filter(run => run.stage === "judge").length,
      retrieval: plannedRuns.filter(run => run.stage === "retrieval").length }, runs, requests: [] };
  let stopped: string | undefined;
  try {
    await writeKnowledgeEvalReport(output, report);
    runtime = await openKnowledgeEvalRuntime({ cwd: repository, modelRef: options.modelRef!, thinking: options.thinking,
      timeoutMs: options.timeoutMs, maxCalls: options.maxCalls, output, signal: controller.signal });
    report = { ...report, model: runtime.metadata, requests: runtime.records };
    for (let repetition = 1; repetition <= options.repetitions; repetition++) for (const item of plan) {
      const { fixture, stage } = item;
      const before = runtime.records.length, started = Date.now();
      const base = { id: fixture.id, title: fixture.title, stage, repetition, expected: fixture.expected,
        expectedConflictPairs: fixture.expectedPairs.filter(pair => pair.outcome === "conflict").length };
      if (stopped || controller.signal.aborted || runtime.stopReason) {
        stopped ??= runtime.stopReason ?? String(controller.signal.reason);
        runs.push({ ...base, passed: false, notRun: true, error: stopped, requestIds: [], elapsedMs: 0 });
        continue;
      }
      let retrieval: unknown;
      try {
        const complete = runtime.complete(`${stage}/${fixture.id}/${repetition}`);
        let result;
        let retrievalPassed = true;
        if (stage === "retrieval") {
          const collected = await collectRetrievalFixture(fixture, { output, bundledExtensionPath: join(repository, "external", "pi-tools-suite"), signal: controller.signal });
          retrieval = collected;
          if (!collected.snapshot) throw new Error(collected.error ?? "Native evidence collection failed.");
          result = await compareKnowledge(collected.snapshot.document, collected.snapshot.evidence, complete, controller.signal, "ru");
          const freshAfterComparison = await collected.snapshot.current(controller.signal);
          retrieval = { ...collected, freshAfterComparison };
          retrievalPassed = collected.metrics.passed && freshAfterComparison;
        } else if (fixture.chunked) {
          const chunks = splitKnowledgeDocument(fixture.document);
          result = await checkKnowledgeChunks({ request: { cwd: repository, path: fixture.document.path, content: fixture.document.text },
            body: fixture.document.text, chunks, firstSnapshot: suppliedSnapshot(fixture, chunks[0]!.text),
            collect: async request => suppliedSnapshot(fixture, request.content), complete, signal: controller.signal,
            reportLanguage: "ru", modelRef: options.modelRef! });
        } else result = await compareKnowledge(fixture.document, fixture.evidence, complete, controller.signal, "ru");
        const score = scoreKnowledgeEval(fixture, result);
        runs.push({ ...base, passed: score.passed && retrievalPassed, score, result,
          ...(retrieval ? { retrieval } : {}), requestIds: runtime.records.slice(before).map(record => record.id), elapsedMs: Date.now() - started });
      } catch (error) {
        runs.push({ ...base, passed: false, error: error instanceof Error ? error.message : String(error),
          ...(retrieval ? { retrieval } : {}), requestIds: runtime.records.slice(before).map(record => record.id), elapsedMs: Date.now() - started });
      }
      await writeKnowledgeEvalReport(output, report);
    }
    stopped ??= runtime.stopReason ?? (controller.signal.aborted ? String(controller.signal.reason) : undefined);
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    runtime?.dispose();
    const completed = new Set(runs.map(run => `${run.stage}/${run.id}/${run.repetition}`));
    for (const base of plannedRuns) if (!completed.has(`${base.stage}/${base.id}/${base.repetition}`)) {
      runs.push({ ...base, passed: false, notRun: true, error: stopped ?? "Evaluation stopped before this case.",
        requestIds: [], elapsedMs: 0 });
    }
    report = { ...report, finishedAt: new Date().toISOString(), ...(stopped ? { stopReason: stopped } : {}) };
    await writeKnowledgeEvalReport(output, report);
  }
  const summary = summarizeKnowledgeEval(report);
  const passed = !stopped && runs.length === plan.length * options.repetitions && runs.every(run => run.passed);
  console.log(JSON.stringify({ status: passed ? "passed" : stopped ? "incomplete" : "failed", output, summary: { ...summary, diagnostics: undefined } }));
  return passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runKnowledgeEval().then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  });
}
