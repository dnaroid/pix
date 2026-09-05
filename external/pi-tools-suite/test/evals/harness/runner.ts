import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withE2ERetry } from "../../e2e-retry.js";
import { evaluateAssertions } from "./assertions.js";
import { deriveMetrics } from "./metrics.js";
import type { EvalCase, EvalEvent, EvalRunResult } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = path.resolve(HERE, "..", "..");
const PACKAGE_ROOT = path.resolve(TEST_ROOT, "..");
const EXTENSION_ENTRYPOINT = path.join(PACKAGE_ROOT, "index.ts");
const FIXTURE_ROOT = path.join(TEST_ROOT, "evals", "fixtures");
const DEMO_FIXTURE = path.join(TEST_ROOT, "fixtures", "demo-project");
const DEFAULT_TIMEOUT_MS = 240_000;

export type RunEvalOptions = {
	keepProject?: boolean;
	timeoutMs?: number;
	streamIo?: boolean;
};

export async function runEvalCase(evalCase: EvalCase, model: string, options: RunEvalOptions = {}): Promise<EvalRunResult> {
	return withE2ERetry(`${evalCase.id}:${model}`, async () => {
		const projectDir = makeFixtureProject(evalCase.fixture);
		const before = snapshotFiles(projectDir);
		const sessionDir = path.join(projectDir, ".pi", `eval-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(sessionDir, { recursive: true });
		if (evalCase.indexed) fs.mkdirSync(path.join(projectDir, ".indexer-cli"), { recursive: true });
		const recorder = writeRecorder(projectDir, evalCase.blockTools ?? []);
		const fakeBin = evalCase.fakeIdx ? writeFakeIdxBin(projectDir) : undefined;
		const args = [
			"--model", model,
			"--extension", EXTENSION_ENTRYPOINT,
			"--extension", recorder.extensionPath,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--session-dir", sessionDir,
			"--no-session",
			"-p", evalCase.prompt,
		];
		const startedAt = Date.now();
		const child = spawn("pi", args, {
			cwd: projectDir,
			env: {
				...process.env,
				...evalCase.env,
				PATH: fakeBin ? `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH,
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
			if (options.streamIo) process.stderr.write(`[eval:${evalCase.id}:${model}:stdout] ${text}`);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stderr += text;
			if (options.streamIo) process.stderr.write(`[eval:${evalCase.id}:${model}:stderr] ${text}`);
		});

		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let timedOut = false;
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				resolve(null);
			}, timeoutMs);
			child.once("error", (error) => { clearTimeout(timer); reject(error); });
			child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
		});

		const events = readEvents(recorder.logPath);
		const changedFiles = diffSnapshots(before, snapshotFiles(projectDir));
		const base = {
			caseId: evalCase.id,
			model,
			projectDir,
			stdout,
			stderr,
			exitCode,
			timedOut,
			events,
			metrics: deriveMetrics({ events, elapsedMs: Date.now() - startedAt, changedFiles, projectDir, sessionDir }),
		};
		const assertions = evaluateAssertions(evalCase, base);
		const result: EvalRunResult = { ...base, assertions, passed: assertions.every((assertion) => assertion.passed) };
		if (!options.keepProject) fs.rmSync(projectDir, { recursive: true, force: true });
		return result;
	});
}

export function parseEvalModels(value: string = process.env.PI_TOOLS_SUITE_EVAL_MODELS ?? ""): string[] {
	const models = value.split(/[;,\n]/).map((item: string) => item.trim()).filter((item: string): item is string => Boolean(item));
	return Array.from(new Set<string>(models));
}

export function caseAppliesToModel(evalCase: EvalCase, model: string): boolean {
	return !evalCase.models?.length || evalCase.models.some((pattern) => pattern.test(model));
}

function makeFixtureProject(fixture: EvalCase["fixture"]): string {
	const source = fixture === "demo" ? DEMO_FIXTURE : path.join(FIXTURE_ROOT, fixture);
	if (!fs.existsSync(source)) throw new Error(`Eval fixture not found: ${source}`);
	const target = fs.mkdtempSync(path.join(os.tmpdir(), `pi-tools-eval-${fixture}-`));
	fs.cpSync(source, target, { recursive: true });
	return target;
}

function writeRecorder(projectDir: string, blockTools: string[]): { extensionPath: string; logPath: string } {
	const extensionPath = path.join(projectDir, ".pi", "eval-recorder.ts");
	const logPath = path.join(projectDir, ".pi", "eval-events.jsonl");
	fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
	fs.writeFileSync(extensionPath, `
import * as fs from "node:fs";
const LOG_PATH = ${JSON.stringify(logPath)};
const BLOCKED = new Set(${JSON.stringify(blockTools)});
function safe(value) { try { JSON.stringify(value); return value ?? null; } catch { return String(value); } }
function append(value) { fs.appendFileSync(LOG_PATH, JSON.stringify(value) + "\\n", "utf8"); }
export default function recorder(pi) {
  pi.on("tool_call", async (event) => {
    append({ type: "tool_call", toolName: event.toolName, input: safe(event.input) });
    if (BLOCKED.has(event.toolName)) return { block: true, reason: event.toolName + " execution blocked by eval recorder after selection was captured; do not retry it" };
  });
  pi.on("tool_result", async (event) => append({ type: "tool_result", toolName: event.toolName, isError: event.isError === true }));
  pi.on("agent_end", async (event) => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
    for (const message of Array.isArray(event.messages) ? event.messages : []) {
      if (!message || message.role !== "assistant" || !message.usage) continue;
      usage.input += Number(message.usage.input || 0);
      usage.output += Number(message.usage.output || 0);
      usage.cacheRead += Number(message.usage.cacheRead || 0);
      usage.cacheWrite += Number(message.usage.cacheWrite || 0);
      usage.totalTokens += Number(message.usage.totalTokens || 0);
      usage.cost += Number(message.usage.cost?.total || 0);
    }
    append({ type: "agent_end", usage });
  });
}
`, "utf8");
	return { extensionPath, logPath };
}

function writeFakeIdxBin(projectDir: string): string {
	const binDir = path.join(projectDir, ".pi", "fake-bin");
	const idxPath = path.join(binDir, "idx");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(idxPath, `#!/usr/bin/env node
const args = process.argv.slice(2); const command = args[0] || "";
if (command === "architecture") console.log("Checkout modules: cart, discounts, payments, audit. Payment request construction lives in src/payments.ts.");
else if (command === "structure") console.log("src/payments.ts::buildPaymentRequest; src/cart.ts::calculateCartTotals; src/discounts.ts::applyCoupon; src/audit.ts::recordAuditEvent");
else if (command === "search") console.log("src/payments.ts:19-33 buildPaymentRequest creates a random idempotencyKey, so payment retries can double-charge.");
else if (command === "deps") console.log("src/payments.ts::buildPaymentRequest -> calculateCartTotals, applyCoupon");
else if (command === "explain" || command === "ast") console.log("src/payments.ts::buildPaymentRequest handles payment amount, card token, and idempotency key.");
else console.log("fake idx ok");
`, "utf8");
	fs.chmodSync(idxPath, 0o755);
	return binDir;
}

function readEvents(file: string): EvalEvent[] {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvalEvent);
}

function snapshotFiles(root: string): Map<string, string> {
	const result = new Map<string, string>();
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name === ".pi" || entry.name === ".indexer-cli" || entry.name === "node_modules") continue;
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(absolute);
			else if (entry.isFile()) result.set(path.relative(root, absolute), crypto.createHash("sha1").update(fs.readFileSync(absolute)).digest("hex"));
		}
	}
	return result;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
	const changed = new Set<string>();
	for (const [file, hash] of before) if (after.get(file) !== hash) changed.add(file);
	for (const file of after.keys()) if (!before.has(file)) changed.add(file);
	return [...changed].sort();
}
