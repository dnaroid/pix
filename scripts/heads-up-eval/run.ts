import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADS_UP_CASES } from "./cases.js";
import { EVAL_HELP, parseOptions, validateCallBudget } from "./options.js";
import { buildCaseInput, summarize, validateCases, type CaseResult } from "./scoring.js";
import { markdownReport, runCases, type ModelReport } from "./runner.js";
import { DEFAULT_HEADS_UP_CONFIG } from "../../src/bundled-extensions/heads-up/config.js";
import { HEADS_UP_SYSTEM_PROMPT } from "../../src/bundled-extensions/heads-up/inference.js";
import { offline } from "../../src/bundled-extensions/heads-up/settings.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const HASH_PATHS = [
	"src/bundled-extensions/heads-up/context.ts", "src/bundled-extensions/heads-up/inference.ts",
	"src/bundled-extensions/heads-up/parser.ts", "src/bundled-extensions/heads-up/config.ts",
	"scripts/heads-up-eval/cases.ts", "scripts/heads-up-eval/scoring.ts", "scripts/heads-up-eval/runner.ts",
	"scripts/heads-up-eval/options.ts", "scripts/heads-up-eval/run.ts",
];
function hash(data: string): string { return createHash("sha256").update(data).digest("hex"); }
async function sourceHashes(): Promise<Record<string, string>> {
	return Object.fromEntries(await Promise.all(HASH_PATHS.map(async (path) => [path, hash(await readFile(join(ROOT, path), "utf8"))])));
}

/** Provider discovery is loaded only after --live and budget/offline checks. */
async function openLiveRuntime(cwd: string) {
	const [{ createPixDraftModelRuntime }, { ModelRegistry }, { requestHeadsUp }] = await Promise.all([
		import("../../src/app/runtime.js"), import("@earendil-works/pi-coding-agent"), import("../../src/bundled-extensions/heads-up/inference.js"),
	]);
	const handle = await createPixDraftModelRuntime({ cwd });
	return { ...handle, registry: new ModelRegistry(handle.modelRuntime), requestHeadsUp };
}

async function main(): Promise<number> {
	const options = parseOptions(process.argv.slice(2));
	if (options.help) { console.log(EVAL_HELP); return 0; }
	for (const id of options.caseIds) if (!HEADS_UP_CASES.some((item) => item.id === id)) throw new Error(`Unknown case: ${id}`);
	const cases = options.caseIds.length ? HEADS_UP_CASES.filter((item) => options.caseIds.includes(item.id)) : [...HEADS_UP_CASES];
	validateCases(cases);
	const calls = validateCallBudget(cases.length, options);
	if (!options.live) {
		console.log(`Offline fixture validation: ${cases.length} valid cases, ${calls} planned calls. No model requests; this is not a model-quality score.`);
		for (const item of cases) console.log(`${item.id.padEnd(26)} expected=${item.expected.kind.padEnd(8)} input=${buildCaseInput(item).body.length} chars`);
		console.log("Run with --live to evaluate a real model. --help lists selection and comparison options.");
		return 0;
	}
	if (offline()) throw new Error("PI_OFFLINE forbids --live");
	const artifactRoot = join(ROOT, ".pi", "artifacts");
	await mkdir(artifactRoot, { recursive: true });
	const output = await mkdtemp(join(artifactRoot, "heads-up-eval-"));
	const cwd = join(output, "empty-workspace");
	await mkdir(cwd);
	const jsonl = join(output, "results.jsonl");
	await writeFile(jsonl, "", { flag: "wx", mode: 0o600 });
	// Persist only the sanitized inputs actually used, not raw messages/thinking/images.
	await writeFile(join(output, "inputs.json"), JSON.stringify(cases.map((item) => ({
		id: item.id, category: item.category, rationale: item.rationale, expected: item.expected,
		input: buildCaseInput(item),
	})), null, 2), { flag: "wx", mode: 0o600 });
	const sources = await sourceHashes();
	const startedAt = new Date().toISOString();
	let gitHead: string | null = null;
	try { gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Source hashes still identify this run. */ }
	const models: ModelReport[] = [];
	const stop = new AbortController();
	const cancel = () => stop.abort();
	process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
	let runtime: Awaited<ReturnType<typeof openLiveRuntime>> | undefined;
	let setupTimer: ReturnType<typeof setTimeout> | undefined;
	let setupFailed = false;
	console.log(`Live eval: ${calls} maximum inference calls, ${options.timeoutMs} ms each; no retries/fallback. Reports: ${relative(ROOT, output)}`);
	try {
		// Late provider discovery is disposed as well; CLI exit bounds misbehaving extension timers.
		const opening = openLiveRuntime(cwd).then((handle) => { if (setupFailed) handle.dispose(); return handle; });
		try {
			runtime = await Promise.race([opening, new Promise<never>((_, reject) => {
				setupTimer = setTimeout(() => reject(new Error("runtime setup timeout")), 30000);
			})]);
		} catch { setupFailed = true; }
		finally { clearTimeout(setupTimer); }
		for (const modelRef of options.models) {
			const slash = modelRef.indexOf("/");
			const provider = modelRef.slice(0, slash);
			const modelId = modelRef.slice(slash + 1);
			let model = runtime?.registry.find(provider, modelId);
			if (runtime && !model && !stop.signal.aborted) {
				try { await runtime.modelRuntime.refresh({ allowNetwork: true, providers: [provider], signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]) }); } catch { /* Controlled unavailable result below. */ }
				model = runtime.registry.find(provider, modelId);
			}
			const available = runtime && model && runtime.registry.hasConfiguredAuth(model) && !stop.signal.aborted;
			if (!available) {
				let reason = "Exact model unavailable or credentials missing; no fallback used";
				if (setupFailed) reason = "Provider runtime setup failed or timed out";
				if (stop.signal.aborted) reason = "Run interrupted/stopped after transport failure";
				const results: CaseResult[] = Array.from({ length: options.repeat }, (_, i) => cases.map((item) => ({ caseId: item.id, iteration: i + 1, expected: item.expected.kind,
					outcome: "not_run" as const, issues: [reason], response: "", inputChars: buildCaseInput(item).body.length, latencyMs: null }))).flat();
				models.push({ model: modelRef, preflightError: reason, results });
				for (const result of results) appendFileSync(jsonl, `${JSON.stringify({ model: modelRef, ...result })}\n`);
				console.log(`${modelRef}: ${reason}`); continue;
			}
			const currentRuntime = runtime!;
			const currentModel = model!;
			const results = await runCases({ cases, repeat: options.repeat, timeoutMs: options.timeoutMs, signal: stop.signal,
				infer: (input, signal) => currentRuntime.requestHeadsUp(currentRuntime.registry, { model: currentModel, input, signal,
					maxTokens: DEFAULT_HEADS_UP_CONFIG.maxTokens, timeoutMs: options.timeoutMs }),
				onResult: (result) => {
					appendFileSync(jsonl, `${JSON.stringify({ model: modelRef, ...result })}\n`);
					console.log(`${modelRef} ${result.caseId} #${result.iteration}: ${result.outcome} (${result.latencyMs ?? "-"} ms)`);
				},
			});
			models.push({ model: modelRef, results });
			if (!summarize(results).complete) stop.abort(); // Do not overlap another model with a transport that ignored cancellation.
		}
	} finally {
		runtime?.dispose();
		process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
	}
	const sourceChangedDuringRun = JSON.stringify(sources) !== JSON.stringify(await sourceHashes());
	const report = {
		version: 1, mode: "live", startedAt, finishedAt: new Date().toISOString(), gitHead, sourceChangedDuringRun,
		sources, systemPromptSha256: hash(HEADS_UP_SYSTEM_PROMPT), corpusSha256: hash(JSON.stringify(cases)),
		config: { ...DEFAULT_HEADS_UP_CONFIG, timeoutMs: options.timeoutMs, reasoning: "low", cacheRetention: "none" },
		options, corpus: "synthetic development set; no held-out claim", scoring: "source-ID + consequence-anchor proxy; manual semantic review required",
		models: models.map((item) => ({ ...item, summary: summarize(item.results) })),
	};
	await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
	await writeFile(join(output, "report.md"), markdownReport(models, cases), { flag: "wx", mode: 0o600 });
	console.log(`Reports written: ${relative(ROOT, output)}/report.{json,md}`);
	if (sourceChangedDuringRun || models.some((item) => item.preflightError || !summarize(item.results).complete)) return 2;
	return models.every((item) => summarize(item.results).passed === item.results.length) ? 0 : 1;
}

// Explicit exit is safe after awaited report writes; SDK/provider timers must not keep this standalone CLI alive.
main().then((code) => process.exit(code), (error: unknown) => {
	console.error(error instanceof Error ? error.message : "Evaluation setup failed"); process.exit(2);
});
