import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Live E2E benchmark for the hard-to-find fixture. It is opt-in because it
// spawns real pi subprocesses and calls a real model once per benchmark mode.
// Run with:
// PI_LOCATE_BENCH_E2E=1 PI_LOCATE_BENCH_MODEL=zai/glm-5-turbo \
//   bun test test/locate-benchmark-e2e.test.ts
const RUN_E2E = /^(1|true|yes)$/i.test(process.env.PI_LOCATE_BENCH_E2E ?? "");
const DEFAULT_MODEL = "zai/glm-5-turbo";
const E2E_MODEL = (
	process.env.PI_LOCATE_BENCH_MODEL ||
	process.env.TOOL_SELECTION_E2E_MODEL ||
	process.env.PI_TOOLS_SUITE_E2E_MODEL ||
	DEFAULT_MODEL
).trim();
const MODE_TIMEOUT_MS = Number(process.env.PI_LOCATE_BENCH_TIMEOUT_MS ?? 300_000);

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.join(TEST_DIR, "fixtures", "hard-to-find-project", "benchmark", "run-locate-benchmark.mjs");

const DEFAULT_MODES = [
	"direct-read-grep",
	"ast-structural",
	"repo-search-hybrid",
	"repo-discovery",
	"subagent-search",
	"unrestricted-suite",
] as const;
const TOTAL_TIMEOUT_MS = Number(process.env.PI_LOCATE_BENCH_E2E_TIMEOUT_MS ?? MODE_TIMEOUT_MS * 2);
const e2eTest = RUN_E2E ? test : test.skip;

type BenchmarkResult = {
	mode: string;
	exitCode: number | null;
	timedOut?: boolean;
	success: boolean;
	elapsedMs: number;
	roughToolIoTokens: number;
	toolCallCount: number;
	toolCalls: string[];
	firstCorrectEvidence?: {
		found: boolean;
		eventIndex?: number;
		toolCallNumber?: number;
		toolName?: string;
		tokensAtEvidence?: number;
	};
	idxCalls: string[][];
	preparation?: {
		elapsedMs: number;
		idxInit?: {
			skipped: boolean;
			fake: boolean;
			elapsedMs: number;
			stdoutBytes?: number;
			stderrBytes?: number;
		};
	};
	sessionArtifacts?: {
		pathsRetained: boolean;
		parent: {
			sessionId: string;
			sessionDir: string;
			files: Array<{ id: string; path: string; bytes: number }>;
		};
		subagents: Array<{
			id: string;
			sessionId?: string;
			sessionDir?: string;
			sessionFile?: string;
			files: Array<{ id: string; path: string; bytes: number }>;
			linkedSessionFile?: { id: string; path: string; bytes: number };
		}>;
	};
	metrics?: {
		burnedTokens: number;
		parent: {
			toolIoTokens: number;
			sessionArtifactTokens: number;
			assistantTextTokens: number;
			usageTokens?: number;
			answerPreview: string;
		};
		subagents: {
			count: number;
			totalEstimatedSessionTokens: number;
			agents: Array<{
				id: string;
				estimatedSessionTokens: number;
				resultPreview: string;
			}>;
		};
	};
	subagentEventBytes?: number;
	stdoutBytes: number;
	stderrBytes: number;
};

type BenchmarkReport = {
	fixture: string;
	prompt: string;
	benchmarkGuidance?: string;
	fakeIdx: boolean;
	preflight?: {
		idxUpdate?: {
			skipped: boolean;
			reason?: string;
			elapsedMs?: number;
			stdoutBytes?: number;
			stderrBytes?: number;
		};
	};
	results: BenchmarkResult[];
};

describe("hard-to-find locate benchmark live e2e", () => {
	e2eTest("locates the target with every search strategy and records rough tool-IO tokens", async () => {
		const report = await runLocateBenchmark();
		const requestedModes = selectedModes();

		expect(report.fixture).toBe("hard-to-find-project");
		expect(report.results.map((result) => result.mode)).toEqual(requestedModes);

		for (const result of report.results) {
			expect(result.exitCode, `${result.mode} should exit cleanly`).toBe(0);
			expect(result.success, `${result.mode} should cite the manifest ground truth`).toBe(true);
			expect(result.toolCallCount, `${result.mode} should use at least one tool`).toBeGreaterThan(0);
			expect(result.roughToolIoTokens, `${result.mode} should record token spend`).toBeGreaterThan(0);
			expect(result.sessionArtifacts?.parent.sessionId, `${result.mode} should record parent session id`).toBeTruthy();
		}

		const hybridRepoSearch = report.results.find((result) => result.mode === "repo-search-hybrid");
		if (hybridRepoSearch) {
			expect(hybridRepoSearch.toolCalls).toContain("repo_search");
			expect(hybridRepoSearch.firstCorrectEvidence?.found, "repo-search-hybrid should record first correct evidence").toBe(true);
			if (report.fakeIdx) {
				expect(hybridRepoSearch.idxCalls.some((args) => args[0] === "search")).toBe(true);
				expect(hybridRepoSearch.preparation?.idxInit?.fake).toBe(true);
			} else {
				expect(hybridRepoSearch.preparation?.idxInit?.skipped).toBe(false);
			}
		}

		const repoDiscovery = report.results.find((result) => result.mode === "repo-discovery");
		if (repoDiscovery) expect(repoDiscovery.toolCalls.some((name) => name.startsWith("repo_"))).toBe(true);

		const subagentSearch = report.results.find((result) => result.mode === "subagent-search");
		if (subagentSearch) {
			expect(subagentSearch.toolCalls).toContain("subagents");
			expect(subagentSearch.subagentEventBytes ?? 0).toBeGreaterThan(0);
			expect(subagentSearch.metrics?.subagents.count ?? 0).toBeGreaterThan(0);
		}

		console.log(formatTokenReport(report));
	}, TOTAL_TIMEOUT_MS);
});

function selectedModes(): string[] {
	const modes = (process.env.PI_LOCATE_BENCH_MODES || "")
		.split(",")
		.map((mode) => mode.trim())
		.map((mode) => mode === "semantic-repo-search" ? "repo-search-hybrid" : mode)
		.filter(Boolean);
	return modes.length > 0 ? modes : [...DEFAULT_MODES];
}

async function runLocateBenchmark(): Promise<BenchmarkReport> {
	if (!E2E_MODEL) throw new Error("PI_LOCATE_BENCH_MODEL/TOOL_SELECTION_E2E_MODEL resolved to an empty model");

	const reportPath = path.join(os.tmpdir(), `pi-locate-benchmark-${process.pid}-${Date.now()}.json`);
	const reportDir = path.join(os.tmpdir(), `pi-locate-benchmark-${process.pid}-${Date.now()}-report`);
	const stdout = await spawnNode([HARNESS_PATH], {
		PI_LOCATE_BENCH_MODEL: E2E_MODEL,
		PI_LOCATE_BENCH_MODES: selectedModes().join(","),
		PI_LOCATE_BENCH_TIMEOUT_MS: String(MODE_TIMEOUT_MS),
		PI_LOCATE_BENCH_FAKE_IDX: process.env.PI_LOCATE_BENCH_FAKE_IDX ?? "1",
		PI_LOCATE_BENCH_REPORT: reportPath,
		PI_LOCATE_BENCH_REPORT_DIR: reportDir,
		PI_LOCATE_BENCH_EXPORT_SESSIONS: process.env.PI_LOCATE_BENCH_EXPORT_SESSIONS ?? "0",
	});

	const reportText = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf-8") : stdout;
	fs.rmSync(reportPath, { force: true });
	fs.rmSync(reportDir, { recursive: true, force: true });
	return JSON.parse(reportText) as BenchmarkReport;
}

function spawnNode(args: string[], env: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.env.NODE_BIN || "node", args, {
			env: { ...process.env, ...env, PI_OFFLINE: "1", NO_COLOR: "1", CI: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`locate benchmark e2e timed out after ${TOTAL_TIMEOUT_MS}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
		}, TOTAL_TIMEOUT_MS);

		child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf-8");
			stderr += text;
			process.stderr.write(text);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`locate benchmark e2e exited with ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
				return;
			}
			resolve(stdout);
		});
	});
}

function formatTokenReport(report: BenchmarkReport): string {
	const lines = ["\nlocate benchmark rough token report (sorted by total estimated tokens):"];
	const totalTokens = (result: BenchmarkResult) => (result.metrics?.burnedTokens ?? result.roughToolIoTokens) + (result.metrics?.subagents.totalEstimatedSessionTokens ?? 0);
	const results = [...report.results].sort((a, b) => totalTokens(a) - totalTokens(b));
	for (const result of results) {
		lines.push([
			`- ${result.mode}`,
			`${result.metrics?.burnedTokens ?? result.roughToolIoTokens} burned tokens`,
			`${result.metrics?.subagents.totalEstimatedSessionTokens ?? 0} sub-agent tokens`,
			`${totalTokens(result)} total tokens`,
			`${result.toolCallCount} tool calls`,
			`${result.elapsedMs}ms`,
			`tools=${result.toolCalls.join(" -> ")}`,
		].join("; "));
	}
	return lines.join("\n");
}
