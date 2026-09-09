import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withE2ERetry } from "../../e2e-retry.js";
import { RECOVERY_PROBE_LOG, type RecoveryProbeConfig } from "../recovery-provenance.js";
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
	extensionEntrypoint?: string;
	env?: Record<string, string | undefined>;
	prepareProject?: (projectDir: string) => void;
	/** Test-only guard: delete fixture files after a named tool result so recovery cannot fall back to the original source. */
	deleteProjectFilesAfterToolResult?: Record<string, string[]>;
	/** Test-only provenance probe. Raw paths stay in the disposable fixture project and are never part of normal eval events. */
	recoveryProbe?: RecoveryProbeConfig;
};

export async function runEvalCase(evalCase: EvalCase, model: string, options: RunEvalOptions = {}): Promise<EvalRunResult> {
	return withE2ERetry(`${evalCase.id}:${model}`, async () => {
		const projectDir = makeFixtureProject(evalCase.fixture);
		options.prepareProject?.(projectDir);
		const before = snapshotFiles(projectDir);
		const sessionDir = path.join(projectDir, ".pi", `eval-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(sessionDir, { recursive: true });
		if (evalCase.indexed) fs.mkdirSync(path.join(projectDir, ".indexer-cli"), { recursive: true });
		const recorder = writeRecorder(
			projectDir,
			evalCase.blockTools ?? [],
			options.deleteProjectFilesAfterToolResult,
			options.recoveryProbe,
		);
		const fakeBin = evalCase.fakeIdx ? writeFakeIdxBin(projectDir) : undefined;
		const args = [
			"--model", model,
			"--extension", options.extensionEntrypoint ?? EXTENSION_ENTRYPOINT,
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
				...options.env,
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
	return Array.from(new Set<string>(parseList(value)));
}

export function caseAppliesToModel(evalCase: EvalCase, model: string): boolean {
	return !evalCase.models?.length || evalCase.models.some((pattern) => pattern.test(model));
}

export type EvalSelection = {
	ids: Set<string>;
	categories: Set<string>;
};

export function parseEvalSelection(): EvalSelection {
	return {
		ids: new Set(parseList(process.env.PI_TOOLS_SUITE_EVAL_CASES)),
		categories: new Set(parseList(process.env.PI_TOOLS_SUITE_EVAL_CATEGORIES)),
	};
}

export function caseIsSelected(evalCase: EvalCase, selection: EvalSelection): boolean {
	if (selection.ids.size > 0 && !selection.ids.has(evalCase.id)) return false;
	if (selection.categories.size > 0 && !selection.categories.has(evalCase.category)) return false;
	return true;
}

function parseList(value: string | undefined): string[] {
	return (value ?? "").split(/[;,\n]/).map((item) => item.trim()).filter(Boolean);
}

function makeFixtureProject(fixture: EvalCase["fixture"]): string {
	const source = fixture === "demo" ? DEMO_FIXTURE : path.join(FIXTURE_ROOT, fixture);
	if (!fs.existsSync(source)) throw new Error(`Eval fixture not found: ${source}`);
	const target = fs.mkdtempSync(path.join(os.tmpdir(), `pi-tools-eval-${fixture}-`));
	fs.cpSync(source, target, { recursive: true });
	return target;
}

export function writeRecorder(
	projectDir: string,
	blockTools: string[],
	deleteProjectFilesAfterToolResult: Record<string, string[]> = {},
	recoveryProbe?: RecoveryProbeConfig,
): { extensionPath: string; logPath: string } {
	const extensionPath = path.join(projectDir, ".pi", "eval-recorder.ts");
	const logPath = path.join(projectDir, ".pi", "eval-events.jsonl");
	const recoveryLogPath = path.join(projectDir, RECOVERY_PROBE_LOG);
	const gatewayTelemetryUrl = pathToFileURL(path.join(PACKAGE_ROOT, "src", "context-gateway", "telemetry.ts")).href;
	const gatewayConfigUrl = pathToFileURL(path.join(PACKAGE_ROOT, "src", "context-gateway", "config.ts")).href;
	const projectRoot = path.resolve(projectDir);
	const cleanupByTool: Record<string, string[]> = {};
	for (const [toolName, relativePaths] of Object.entries(deleteProjectFilesAfterToolResult)) {
		const normalizedToolName = toolName.trim().toLowerCase();
		if (!normalizedToolName) continue;
		cleanupByTool[normalizedToolName] = relativePaths.map((relativePath) => {
			const absolutePath = path.resolve(projectRoot, relativePath);
			if (absolutePath === projectRoot || !absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
				throw new Error(`Eval cleanup path escapes project root: ${relativePath}`);
			}
			return absolutePath;
		});
	}
	fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
	fs.writeFileSync(extensionPath, `
import * as fs from "node:fs";
import { ContextGatewayTelemetry } from ${JSON.stringify(gatewayTelemetryUrl)};
import { loadContextGatewayConfig } from ${JSON.stringify(gatewayConfigUrl)};
const LOG_PATH = ${JSON.stringify(logPath)};
const RECOVERY_LOG_PATH = ${JSON.stringify(recoveryProbe ? recoveryLogPath : "")};
const BLOCKED = new Set(${JSON.stringify(blockTools)});
const CLEANUP_BY_TOOL = ${JSON.stringify(cleanupByTool)};
const RECOVERY_PROBE = ${JSON.stringify(recoveryProbe ?? null)};
const RECOVERY_PRODUCERS = new Set((RECOVERY_PROBE?.producerToolNames || []).map((name) => String(name).toLowerCase()));
const RECOVERY_MAX_FILE_BYTES = Number(RECOVERY_PROBE?.maxFullOutputProbeBytes || 8388608);
const GATEWAY_CONFIG = loadContextGatewayConfig(process.cwd(), process.env);
const GATEWAY_OBSERVE = GATEWAY_CONFIG.mode === "observe";
const GATEWAY_TELEMETRY = new ContextGatewayTelemetry();
function safe(value) { try { JSON.stringify(value); return value ?? null; } catch { return String(value); } }
function jsonBytes(value) {
  try { const text = JSON.stringify(value); return text === undefined ? 0 : Buffer.byteLength(text, "utf8"); }
  catch { return 0; }
}
function textBytes(content) {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) if (part && part.type === "text" && typeof part.text === "string") total += Buffer.byteLength(part.text, "utf8");
  return total;
}
function contentText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) if (part && part.type === "text" && typeof part.text === "string") text += part.text;
  return text;
}
function continuationOffset(content) {
  const match = contentText(content).match(/Use offset=(\d+) to continue/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function fullOutputFactStatus(filePath) {
  if (!RECOVERY_PROBE || typeof filePath !== "string" || !filePath) return "not-provided";
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "not-file";
    if (stat.size > RECOVERY_MAX_FILE_BYTES) return "too-large";
    return fs.readFileSync(filePath, "utf8").includes(RECOVERY_PROBE.expectedFact) ? "match" : "no-match";
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "missing";
    return "read-error";
  }
}
function appendRecoveryProbe(value) {
  if (!RECOVERY_LOG_PATH) return;
  fs.appendFileSync(RECOVERY_LOG_PATH, JSON.stringify(value) + "\\n", "utf8");
}
const NATIVE_REASONS = new Set(["invalid-wrapper-budget", "unknown-flag", "missing-flag-value", "duplicate-flag", "invalid-flag-value", "conflicting-flags", "compact-limit-exceeded", "full-limit-exceeded"]);
function nativePolicy(toolName, details) {
  if (typeof toolName !== "string" || !toolName.startsWith("repo_") || !details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const policy = details.nativePolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.version !== 1 || policy.profile !== "native-compact" || typeof policy.refused !== "boolean") return undefined;
  const outputMode = policy.outputMode === "compact" || policy.outputMode === "full" ? policy.outputMode : undefined;
  const reason = typeof policy.reason === "string" && NATIVE_REASONS.has(policy.reason) ? policy.reason : undefined;
  return { refused: policy.refused, ...(outputMode ? { outputMode } : {}), ...(reason ? { reason } : {}) };
}
function append(value) { fs.appendFileSync(LOG_PATH, JSON.stringify(value) + "\\n", "utf8"); }
export default function recorder(pi) {
  pi.on("tool_call", async (event) => {
    if (GATEWAY_OBSERVE) GATEWAY_TELEMETRY.recordToolCall(event);
    append({ type: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, input: safe(event.input) });
    if (BLOCKED.has(event.toolName)) return { block: true, reason: event.toolName + " execution blocked by eval recorder after selection was captured; do not retry it" };
  });
  pi.on("tool_result", async (event) => {
    if (GATEWAY_OBSERVE) GATEWAY_TELEMETRY.recordToolResult(event, GATEWAY_CONFIG.budgets, {
      maxInlineBytes: GATEWAY_CONFIG.budgets.maxInlineBytes,
    });
    const normalizedTool = String(event.toolName || "").toLowerCase();
    const cleanup = CLEANUP_BY_TOOL[normalizedTool] || [];
    const cleanupExistingBeforeCount = cleanup.filter((filePath) => fs.existsSync(filePath)).length;
    const fullOutputPath = RECOVERY_PRODUCERS.has(normalizedTool)
      && event.details && typeof event.details === "object" && !Array.isArray(event.details)
      && typeof event.details.fullOutputPath === "string"
      ? event.details.fullOutputPath
      : undefined;
    const fullOutputStatus = fullOutputFactStatus(fullOutputPath);
    let cleanupDeletedCount = 0;
    for (const filePath of cleanup) {
      const existed = fs.existsSync(filePath);
      fs.rmSync(filePath, { force: true });
      if (existed && !fs.existsSync(filePath)) cleanupDeletedCount += 1;
    }
    const cleanupMissingAfterCount = cleanup.filter((filePath) => !fs.existsSync(filePath)).length;
    append({
      type: "tool_result",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError === true,
      contentBytes: jsonBytes(event.content),
      textBytes: textBytes(event.content),
      nativePolicy: nativePolicy(event.toolName, event.details),
    });
    if (RECOVERY_PROBE) appendRecoveryProbe({
      type: "tool_result_probe",
      toolCallId: String(event.toolCallId || ""),
      toolName: String(event.toolName || ""),
      isError: event.isError === true,
      contentContainsExpectedFact: contentText(event.content).includes(RECOVERY_PROBE.expectedFact),
      nativeContinuationOffset: continuationOffset(event.content),
      ...(fullOutputPath ? { fullOutputPath } : {}),
      fullOutputFactStatus: fullOutputStatus,
      cleanupExpectedCount: cleanup.length,
      cleanupExistingBeforeCount,
      cleanupDeletedCount,
      cleanupMissingAfterCount,
    });
  });
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
    append({
      type: "agent_end",
      usage,
      ...(GATEWAY_OBSERVE ? {
        contextGatewayTelemetry: {
          mode: "observe",
          maxResultBytes: GATEWAY_CONFIG.budgets.maxResultBytes,
          budgets: GATEWAY_CONFIG.budgets,
          snapshot: GATEWAY_TELEMETRY.snapshot(),
        },
      } : {}),
    });
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
if (command === "context") console.log("CONTEXT query=payment retry idempotency\\nPrimary knowledge:\\nS specs/payment-retry.md status=fresh lifecycle=active score=9.10\\nImplementation:\\nC src/payments.ts:19-33 reason=tracked+semantic\\nTests:\\nT test/payments.test.ts reason=explicit conf=high");
else if (command === "wiki" && args[1] === "search") console.log("score=9.10 active fresh specs/payment-retry.md — Payment retry contract\\n      Payment retries reuse a stable idempotency key.");
else if (command === "wiki" && args[1] === "impact") console.log("changed: 1 | known affected: 1 | uncovered: 0 | changed docs: 0 | semantic sweep: yes\\n  known specs/payment-retry.md — inputs-changed — src/payments.ts");
else if (command === "architecture") console.log("Checkout modules: cart, discounts, payments, audit. Payment request construction lives in src/payments.ts.");
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
