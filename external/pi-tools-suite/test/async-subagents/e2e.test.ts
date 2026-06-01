import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getRunState, waitForAgents } from "../../src/async-subagents/lib.js";
import { withE2ERetry } from "../e2e-retry.js";

// Live E2E tests are opt-in because they call a real model and spawn real pi
// subprocesses. Run with:
// ASYNC_SUBAGENTS_E2E=1 ASYNC_SUBAGENTS_MODEL=zai/glm-5-turbo \
//   bun test --concurrent --max-concurrency=3 test/async-subagents/e2e.test.ts
// The vision test invokes openai-codex/gpt-5.4-mini by default; override with
// ASYNC_SUBAGENTS_VISION_E2E_MODEL if that model is registered under another provider.
// Authentication is expected to come from the local pi configuration.
const RUN_E2E = /^(1|true|yes)$/i.test(process.env.ASYNC_SUBAGENTS_E2E ?? "");
const KEEP_E2E_DIRS = /^(1|true|yes)$/i.test(process.env.ASYNC_SUBAGENTS_E2E_KEEP ?? "");
const DEFAULT_MODEL = "zai/glm-5-turbo";
const E2E_MODEL = (
	process.env.ASYNC_SUBAGENTS_MODEL ||
	process.env.ASYNC_SUBAGENTS_E2E_MODEL ||
	DEFAULT_MODEL
).trim();
const E2E_TIMEOUT_MS = Number(process.env.ASYNC_SUBAGENTS_E2E_TIMEOUT_MS ?? 420_000);
const E2E_PROGRESS = /^(1|true|yes)$/i.test(process.env.ASYNC_SUBAGENTS_E2E_PROGRESS ?? "");
const E2E_STREAM_IO = /^(1|true|yes)$/i.test(process.env.ASYNC_SUBAGENTS_E2E_STREAM_IO ?? "");
const E2E_HEARTBEAT_MS = Number(process.env.ASYNC_SUBAGENTS_E2E_HEARTBEAT_MS ?? 15_000);
const EXTENSION_ENTRYPOINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts");
const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "demo-project");
const VISION_E2E_IMAGE = "assets/create-event-discard.png";
const VISION_E2E_MODEL = (process.env.ASYNC_SUBAGENTS_VISION_E2E_MODEL || "openai-codex/gpt-5.4-mini").trim();
const e2eTest = RUN_E2E ? test : test.skip;

function e2eLog(message: string): void {
	if (!RUN_E2E || !E2E_PROGRESS) return;
	console.error(`[e2e ${new Date().toISOString()}] ${message}`);
}

function makeFixtureProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagents-e2e-project-"));
	fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
	return dir;
}

async function withFixtureProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
	const projectDir = makeFixtureProject();
	try {
		return await fn(projectDir);
	} finally {
		if (!KEEP_E2E_DIRS) fs.rmSync(projectDir, { recursive: true, force: true });
	}
}

async function runPiE2E(
	projectDir: string,
	prompt: string,
	label: string,
	options: { subagentConfig?: Record<string, unknown> } = {},
): Promise<{ stdout: string; stderr: string }> {
	if (!E2E_MODEL) throw new Error("ASYNC_SUBAGENTS_MODEL/ASYNC_SUBAGENTS_E2E_MODEL resolved to an empty model");

	return withE2ERetry(label, async (attempt) => {
		const sessionDir = path.join(projectDir, ".pi", `e2e-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(sessionDir, { recursive: true });
		const subagentConfig = path.join(sessionDir, "async-subagents.json");
		fs.writeFileSync(subagentConfig, JSON.stringify(options.subagentConfig ?? { types: {} }), "utf-8");
		const startedAt = Date.now();
		e2eLog(`start ${label}; attempt=${attempt}; model=${E2E_MODEL}; project=${projectDir}`);
		const args = [
			"--model", E2E_MODEL,
			"--extension", EXTENSION_ENTRYPOINT,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--session-dir", sessionDir,
			"--no-session",
			"-p", prompt,
		];

		const child = spawn("pi", args, {
			cwd: projectDir,
			env: {
				...e2eChildEnv(),
				ASYNC_SUBAGENTS_MODEL: E2E_MODEL,
				PI_SUBAGENTS_MODEL: E2E_MODEL,
				ASYNC_SUBAGENTS_CONFIG: subagentConfig,
				PI_SUBAGENTS_CONFIG: subagentConfig,
				PI_CODING_AGENT_SESSION_DIR: sessionDir,
				PI_OFFLINE: "1",
				NO_COLOR: "1",
				CI: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stdout += text;
			if (E2E_STREAM_IO) console.error(`[e2e stdout:${label}] ${text.trimEnd()}`);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stderr += text;
			if (E2E_STREAM_IO) console.error(`[e2e stderr:${label}] ${text.trimEnd()}`);
		});

		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const heartbeat = setInterval(() => {
				const elapsed = Math.round((Date.now() - startedAt) / 1000);
				e2eLog(`${label}: still running (${elapsed}s); stdout=${stdout.length}B stderr=${stderr.length}B; ${formatSubagentRuns(projectDir)}`);
			}, E2E_HEARTBEAT_MS);
			heartbeat.unref?.();

			const timeout = setTimeout(() => {
				clearInterval(heartbeat);
				child.kill("SIGTERM");
				reject(new Error(`pi e2e timed out after ${E2E_TIMEOUT_MS}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
			}, E2E_TIMEOUT_MS);
			child.once("error", (error) => {
				clearInterval(heartbeat);
				clearTimeout(timeout);
				reject(error);
			});
			child.once("exit", (code) => {
				clearInterval(heartbeat);
				clearTimeout(timeout);
				const elapsed = Math.round((Date.now() - startedAt) / 1000);
				e2eLog(`${label}: pi exited with ${code} after ${elapsed}s; stdout=${stdout.length}B stderr=${stderr.length}B; ${formatSubagentRuns(projectDir)}`);
				resolve(code);
			});
		});

		if (exitCode !== 0) {
			throw new Error(`pi e2e exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
		}
		e2eLog(`done ${label}`);
		return { stdout, stderr };
	}, {
		onRetry: ({ attempt, maxAttempts, delayMs, error }) => e2eLog(
			`${label}: 429/rate-limit on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
		),
	});
}

function e2eChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(ASYNC_SUBAGENTS|PI_SUBAGENTS)_.*(?:_MODEL|_CONFIG)$/.test(key)) continue;
		env[key] = value;
	}
	return env;
}

function formatSubagentRuns(projectDir: string): string {
	const runs = listSubagentRunDirs(projectDir);
	if (runs.length === 0) return "runs=0";
	return runs.slice(0, 3).map((runDir) => {
		try {
			const state = getRunState(runDir);
			const agents = state.agents.length === 0
				? "no agents yet"
				: state.agents.map((agent) => `${agent.id}:${agent.status}`).join(",");
			return `${path.basename(runDir)}[${agents}]`;
		} catch (error) {
			return `${path.basename(runDir)}[state error: ${(error as Error).message}]`;
		}
	}).join("; ");
}

function listSubagentRunDirs(projectDir: string): string[] {
	const root = path.join(projectDir, ".pi", "subagents");
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root)
		.map((name) => path.join(root, name))
		.filter((dir) => fs.statSync(dir).isDirectory())
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function findLatestRun(projectDir: string): string {
	const candidates = listSubagentRunDirs(projectDir);
	expect(candidates.length).toBeGreaterThan(0);
	return candidates[0];
}

function expectNoSubagentRuns(projectDir: string): void {
	expect(listSubagentRunDirs(projectDir)).toEqual([]);
}

async function expectCompletedDelegatedRun(
	runDir: string,
	minAgents: number,
	options: { expectedModel?: string } = {},
): Promise<void> {
	const expectedModel = options.expectedModel ?? E2E_MODEL;
	e2eLog(`wait delegated run ${path.basename(runDir)}; minAgents=${minAgents}`);
	const waited = await waitForAgents(runDir, undefined, { timeout: 180, interval: 2 });
	e2eLog(`delegated run ${path.basename(runDir)} finished: ${waited.agents.map((agent) => `${agent.id}:${agent.status}`).join(",")}`);
	expect(waited.agents.length).toBeGreaterThanOrEqual(minAgents);
	for (const agent of waited.agents) {
		expect(["done", "failed", "stopped"]).toContain(agent.status);
		expect(agent.status).toBe("done");
		const agentDir = path.join(runDir, agent.id);
		expect(fs.readFileSync(path.join(agentDir, "pi_args"), "utf-8")).toContain(`--model\n${expectedModel}`);
		const events = readOptionalFile(path.join(agentDir, "events.jsonl"));
		expect(events.trim().length).toBeGreaterThan(0);
		const result = readOptionalFile(path.join(agentDir, "result.md"));
		expect((result || events).trim().length).toBeGreaterThan(40);
	}
}

function expectVisionImageFindings(runText: string): void {
	const lower = runText.toLowerCase();
	const visualSignals = [
		"team meeting",
		"may 24",
		"conference room a",
		"discard changes",
		"keep editing",
		"submit",
	];
	const matchedSignals = visualSignals.filter((signal) => lower.includes(signal));
	expect(matchedSignals.length, `Expected multiple visual details in vision result; matched: ${matchedSignals.join(", ") || "none"}\n${runText}`).toBeGreaterThanOrEqual(3);
}

function readOptionalFile(file: string): string {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

function readRunText(runDir: string): string {
	const state = getRunState(runDir);
	return state.agents.map((agent) => {
		const agentDir = path.join(runDir, agent.id);
		const prompt = readOptionalFile(path.join(agentDir, "prompt.md"));
		const result = readOptionalFile(path.join(agentDir, "result.md"));
		const events = result ? "" : readOptionalFile(path.join(agentDir, "events.jsonl"));
		return `${agent.id}\n${prompt}\n${result}\n${events}`;
	}).join("\n---\n");
}

describe("async-subagents live e2e orchestration", () => {
	e2eTest("delegates screenshot inspection to the vision profile with an attached image", async () => {
		await withFixtureProject(async (projectDir) => {
			if (!VISION_E2E_MODEL) throw new Error("ASYNC_SUBAGENTS_VISION_E2E_MODEL resolved to an empty model");
			const prompt = `
Launch exactly one sub-agent now to inspect this screenshot for a blind/text-only parent model.
Use the subagents tool with action=spawn and exactly these task fields:
- id: vision-screenshot
- subagentType: vision
- imagePaths: ["@${VISION_E2E_IMAGE}"]
- focus: Describe the visible UI text, form values, and the discard confirmation dialog.
Do not inspect files or images in the parent. After spawning, you may finish; the test will collect the sub-agent result.`;

			await runPiE2E(projectDir, prompt, "vision screenshot inspection", {
				subagentConfig: {
					types: {
						vision: {
							model: VISION_E2E_MODEL,
						},
					},
				},
			});
			const runDir = findLatestRun(projectDir);
			await expectCompletedDelegatedRun(runDir, 1, { expectedModel: VISION_E2E_MODEL });
			const state = getRunState(runDir);
			expect(state.agents.map((agent) => agent.id)).toEqual(["vision-screenshot"]);

			const agentDir = path.join(runDir, "vision-screenshot");
			expect(readOptionalFile(path.join(agentDir, "subagent_type")).trim()).toBe("vision");
			expect(readOptionalFile(path.join(agentDir, "model")).trim()).toBe(VISION_E2E_MODEL);
			expect(readOptionalFile(path.join(agentDir, "image_paths")).trim()).toBe(`@${VISION_E2E_IMAGE}`);
			expect(readOptionalFile(path.join(agentDir, "prompt.md"))).toContain("Visual focus / attention instructions");

			expectVisionImageFindings(readRunText(runDir));
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("delegates a broad project investigation", async () => {
		await withFixtureProject(async (projectDir) => {
		const prompt = `
Quickly understand this checkout fixture project and prepare a team-facing overview.
Split the investigation into independent tracks: architecture, product/technical risks, current tests, and test gaps.
Use parallel work where it helps keep those analysis tracks separate.
Do not edit files; finish with a concise summary backed by evidence from specific files.`;

		const output = await runPiE2E(projectDir, prompt, "broad project investigation");
		expect(output.stdout.trim().length + output.stderr.trim().length).toBeGreaterThan(0);
		const runDir = findLatestRun(projectDir);
		await expectCompletedDelegatedRun(runDir, 2);
		const runText = readRunText(runDir).toLowerCase();
		expect(runText).toContain("src/payments.ts");
		expect(runText).toContain("checkout");
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("delegates a focused payment code review", async () => {
		await withFixtureProject(async (projectDir) => {
		const prompt = `
Perform a thorough review of the checkout payment flow.
Check src/payments.ts together with the related cart and discount modules for correctness, retry/idempotency, validation, and sensitive-data risks.
This should be an independent review with concrete file references; do not edit anything.`;

		await runPiE2E(projectDir, prompt, "payment code review");
		const runDir = findLatestRun(projectDir);
		await expectCompletedDelegatedRun(runDir, 1);
		const runText = readRunText(runDir).toLowerCase();
		expect(runText).toContain("src/payments.ts");
		expect(runText).toMatch(/idempot|retry|validation|cardtoken|sensitive/);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("delegates a release-plan critique", async () => {
		await withFixtureProject(async (projectDir) => {
		const prompt = `
Critically evaluate the checkout release plan in docs/checkout-plan.md.
The plan needs an independent check against the real code, especially rollout risk, observability, idempotency, and audit-data safety.
Delegate the independent check to at least one sub-agent so the critique is backed by a separate review track.
Do not edit files; return a concise critique with concrete evidence.`;

		await runPiE2E(projectDir, prompt, "release-plan critique");
		const runDir = findLatestRun(projectDir);
		await expectCompletedDelegatedRun(runDir, 1);
		const runText = readRunText(runDir).toLowerCase();
		expect(runText).toContain("docs/checkout-plan.md");
		expect(runText).toMatch(/rollout|100%|idempot|audit|observability|monitor/);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("delegates QA test-gap analysis", async () => {
		await withFixtureProject(async (projectDir) => {
		const prompt = `
Prepare a test strategy for the checkout fixture.
Evaluate the existing tests separately from the missing high-value regression cases for payments, discounts, and cart.
If the tracks are independent, analyze them in parallel; do not edit files, and merge the findings at the end.`;

		await runPiE2E(projectDir, prompt, "QA test-gap analysis");
		const runDir = findLatestRun(projectDir);
		await expectCompletedDelegatedRun(runDir, 2);
		const runText = readRunText(runDir).toLowerCase();
		expect(runText).toContain("test/run-tests.js");
		expect(runText).toMatch(/validation|discount|idempot|regression/);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("delegates incident triage across independent hypotheses", async () => {
		await withFixtureProject(async (projectDir) => {
		const prompt = `
Simulate incident triage: after the checkout release, users reported double charges and poor diagnosability.
Investigate the problem through independent hypotheses: payment retry/idempotency, audit/observability, and rollout-plan gaps.
Work in parallel where useful; do not edit anything, and return a short incident summary.`;

		await runPiE2E(projectDir, prompt, "incident triage");
		const runDir = findLatestRun(projectDir);
		await expectCompletedDelegatedRun(runDir, 2);
		const runText = readRunText(runDir).toLowerCase();
		expect(runText).toContain("src/payments.ts");
		expect(runText).toContain("src/audit.ts");
		expect(runText).toMatch(/double charge|idempot|observability|audit/);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("delegates change-impact analysis", async () => {
		await withFixtureProject(async (projectDir) => {
		const prompt = `
Before changing the coupon logic, assess the impact.
Understand the consequences of switching coupon expiry handling from string comparison to Date parsing, check the links to payments and existing tests, and identify regression risks plus tests to add.
Use a delegated sub-agent for the impact analysis because this spans multiple files and risk areas.
Do not edit anything; produce a careful validation plan.`;

		await runPiE2E(projectDir, prompt, "change-impact analysis");
		const runDir = findLatestRun(projectDir);
		await expectCompletedDelegatedRun(runDir, 1);
		const runText = readRunText(runDir).toLowerCase();
		expect(runText).toContain("src/discounts.ts");
		expect(runText).toMatch(/expiry|date|regression|coupon/);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("does not delegate a simple README lookup", async () => {
		await withFixtureProject(async (projectDir) => {
		const prompt = `
Read README.md and state in one or two sentences what kind of fixture project this is.`;

		const output = await runPiE2E(projectDir, prompt, "README lookup");
		expect(output.stdout.toLowerCase() + output.stderr.toLowerCase()).toContain("checkout");
		expectNoSubagentRuns(projectDir);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("does not delegate a direct smoke-test command", async () => {
		await withFixtureProject(async (projectDir) => {
		const prompt = `
Run the existing smoke test with node test/run-tests.js and report the result.`;

		const output = await runPiE2E(projectDir, prompt, "smoke-test command");
		expect(output.stdout.toLowerCase() + output.stderr.toLowerCase()).toContain("fixture smoke ok");
		expectNoSubagentRuns(projectDir);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("does not delegate a small single-file code lookup", async () => {
		await withFixtureProject(async (projectDir) => {
		const prompt = `
Find the function in src/cart.ts that calculates totals, and briefly say what it returns.`;

		const output = await runPiE2E(projectDir, prompt, "single-file lookup");
		const text = output.stdout.toLowerCase() + output.stderr.toLowerCase();
		expect(text).toContain("calculatecarttotals");
		expectNoSubagentRuns(projectDir);
		});
	}, E2E_TIMEOUT_MS);
});
