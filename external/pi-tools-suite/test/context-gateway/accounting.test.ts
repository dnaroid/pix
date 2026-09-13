import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
	contextGatewayAccountingLogDrain,
	registerContextGateway,
	writeContextGatewayAccountingLog,
} from "../../src/context-gateway/index.js";
import { ContextGatewayEfficiencyTracker } from "../../src/context-gateway/efficiency.js";
import { observeToolResult } from "../../src/context-gateway/telemetry.js";
import type { ContextGatewayResolvedConfig } from "../../src/context-gateway/types.js";

function tempDir(prefix = "context-gateway-accounting-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function config(mode: "off" | "observe" | "enforce", enabled = true): ContextGatewayResolvedConfig {
	return {
		mode,
		budgets: {
			maxInlineBytes: 256,
			maxResultBytes: 256,
			maxExactReadBytes: 32768,
			maxSearchBytes: 256,
			maxSearchMatches: 12,
		},
		accountingLog: { enabled, maxBytes: 5 * 1024 * 1024, maxBackups: 3 },
		issues: [],
	};
}

class FakePi {
	handlers = new Map<string, any[]>();
	commands = new Map<string, any>();
	on(name: string, handler: any) {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
	}
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	registerTool() {}
}

const ENV_KEYS = [
	"PI_CONTEXT_GATEWAY_ACCOUNTING_LOG",
	"PI_CONTEXT_GATEWAY_ACCOUNTING_LOG_ENABLED",
	"PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BYTES",
	"PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BACKUPS",
] as const;

function withCleanEnv<T>(fn: () => Promise<T> | T): Promise<T> {
	const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
	for (const key of ENV_KEYS) delete process.env[key];
	return Promise.resolve(fn()).finally(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

describe("context gateway efficiency accounting", () => {
	test("counts compact savings, artifact/session recovery tax, and exact provider usage separately", () => {
		const tracker = new ContextGatewayEfficiencyTracker();
		tracker.recordToolCall({ toolCallId: "web-1", toolName: "web_fetch", input: { url: "private" } });
		const sourceText = "source ".repeat(200);
		const compactText = "compact result";
		const observation = observeToolResult({
			toolCallId: "web-1",
			toolName: "web_fetch",
			content: [{ type: "text", text: sourceText }],
			details: {},
			isError: false,
		}, 256, {
			delivery: {
				representation: "web-recoverable-compact",
				contentBytes: Buffer.byteLength(JSON.stringify([{ type: "text", text: compactText }]), "utf8"),
				textBytes: Buffer.byteLength(compactText, "utf8"),
			},
		});
		const compact = tracker.recordToolResult({
			toolCallId: "web-1",
			toolName: "web_fetch",
			content: [{ type: "text", text: sourceText }],
			details: { fullOutputPath: "/private/native-output.txt" },
			isError: false,
		}, observation, [{ type: "text", text: compactText }]);
		expect(compact?.grossEstimatedTokensSaved).toBeGreaterThan(0);

		const artifactCall = tracker.recordToolCall({
			toolCallId: "read-artifact",
			toolName: "Read",
			input: { path: "/private/native-output.txt", offset: 1, limit: 20 },
		});
		expect(artifactCall?.retrievalKind).toBe("artifact");
		const artifactObservation = observeToolResult({
			toolCallId: "read-artifact",
			toolName: "Read",
			content: [{ type: "text", text: "recovered artifact body" }],
			details: {},
			isError: false,
		}, 32768);
		const artifactResult = tracker.recordToolResult({
			toolCallId: "read-artifact",
			toolName: "Read",
			content: [{ type: "text", text: "recovered artifact body" }],
			details: {},
			isError: false,
		}, artifactObservation);
		expect(artifactResult?.retrievalBytes).toBe(artifactObservation.delivery.contentBytes);
		expect(artifactResult?.retrievalEstimatedTokens).toBeGreaterThan(0);

		const recoveryCall = tracker.recordToolCall({
			toolCallId: "session-recovery",
			toolName: "session_read_section",
			input: { section_id: "private-section" },
		});
		expect(recoveryCall?.retrievalKind).toBe("session-recovery");
		const recoveryObservation = observeToolResult({
			toolCallId: "session-recovery",
			toolName: "session_read_section",
			content: [{ type: "text", text: "recovered session body" }],
			details: {},
			isError: false,
		}, 32768);
		const recoveryResult = tracker.recordToolResult({
			toolCallId: "session-recovery",
			toolName: "session_read_section",
			content: [{ type: "text", text: "recovered session body" }],
			details: {},
			isError: false,
		}, recoveryObservation);
		expect(recoveryResult?.retrievalBytes).toBe(recoveryObservation.delivery.contentBytes);
		expect(recoveryResult?.retrievalEstimatedTokens).toBeGreaterThan(0);

		tracker.recordProviderAttempt();
		tracker.recordProviderCompletion({
			provider: "provider",
			model: "model",
			stopReason: "toolUse",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 50,
				cacheWrite: 10,
				totalTokens: 180,
				cost: { total: 0.25 },
			},
		});

		const snapshot = tracker.snapshot();
		expect(snapshot.grossEstimatedTokensSaved).toBeGreaterThan(0);
		expect(snapshot.retrievalCalls).toBe(2);
		expect(snapshot.byRetrievalKind.artifact?.results).toBe(1);
		expect(snapshot.byRetrievalKind["session-recovery"]?.results).toBe(1);
		expect(snapshot.retrievalBytes).toBe(
			(artifactResult?.retrievalBytes ?? 0) + (recoveryResult?.retrievalBytes ?? 0),
		);
		expect(snapshot.retrievalEstimatedTokens).toBe(
			(artifactResult?.retrievalEstimatedTokens ?? 0) + (recoveryResult?.retrievalEstimatedTokens ?? 0),
		);
		expect(snapshot.conservativeNetEstimatedTokens).toBe(
			snapshot.grossEstimatedTokensSaved - snapshot.retrievalEstimatedTokens,
		);
		expect(snapshot.providerInputTokens).toBe(100);
		expect(snapshot.providerCacheReadTokens).toBe(50);
		expect(snapshot.providerTotalTokens).toBe(180);
		expect(snapshot.providerCost).toBe(0.25);
	});

	test("rotates scalar JSONL with the same bounded retention shape as DCP", async () => {
		await withCleanEnv(async () => {
			const dir = tempDir();
			const logPath = join(dir, "context-gateway-accounting.jsonl");
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_LOG = logPath;
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BYTES = "300";
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BACKUPS = "2";
			const cfg = config("observe");

			for (let index = 0; index < 80; index++) {
				writeContextGatewayAccountingLog(cfg, "test.event", { index, tokens: index * 2 });
			}
			await contextGatewayAccountingLogDrain();

			const names = new Set(readdirSync(dir));
			expect(names.has("context-gateway-accounting.jsonl.1")).toBe(true);
			expect(names.has("context-gateway-accounting.jsonl.2")).toBe(true);
			expect(names.has("context-gateway-accounting.jsonl.3")).toBe(false);
			// Rotation size checks are intentionally amortized rather than paid on every append.
			expect(statSync(logPath).size).toBeLessThan(5_000);
		});
	});

	test("filesystem failures stay observable but never reject the accounting drain", async () => {
		await withCleanEnv(async () => {
			const dir = tempDir();
			const nonDirectory = join(dir, "not-a-directory");
			writeFileSync(nonDirectory, "block child creation");
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_LOG = join(nonDirectory, "accounting.jsonl");

			expect(() => writeContextGatewayAccountingLog(config("observe"), "test.failure")).not.toThrow();
			await contextGatewayAccountingLogDrain();
			expect(existsSync(process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_LOG)).toBe(false);
		});
	});

	test("recovers an abandoned rotation lock without truncating the active stream", async () => {
		await withCleanEnv(async () => {
			const dir = tempDir();
			const logPath = join(dir, "context-gateway-accounting.jsonl");
			const lockPath = `${logPath}.rotation.lock`;
			writeFileSync(logPath, `${"existing-record\n".repeat(40)}`);
			writeFileSync(lockPath, "abandoned lock from an older process");
			const staleTime = new Date(Date.now() - 60_000);
			utimesSync(lockPath, staleTime, staleTime);
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_LOG = logPath;
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BYTES = "100";

			writeContextGatewayAccountingLog(config("observe"), "test.after-stale-lock", { value: 1 });
			await contextGatewayAccountingLogDrain();

			expect(existsSync(lockPath)).toBe(false);
			expect(readFileSync(`${logPath}.1`, "utf8")).toContain("existing-record");
			expect(readFileSync(logPath, "utf8")).toContain('"event":"test.after-stale-lock"');
		});
	});

	test("does not reclaim an old lock while its recorded owner is alive", async () => {
		await withCleanEnv(async () => {
			const dir = tempDir();
			const logPath = join(dir, "context-gateway-accounting.jsonl");
			const lockPath = `${logPath}.rotation.lock`;
			writeFileSync(logPath, `${"existing-record\n".repeat(40)}`);
			writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "active-owner" }));
			const oldTime = new Date(Date.now() - 60_000);
			utimesSync(lockPath, oldTime, oldTime);
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_LOG = logPath;
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BYTES = "100";

			writeContextGatewayAccountingLog(config("observe"), "test.during-live-lock", { value: 1 });
			await contextGatewayAccountingLogDrain();

			expect(existsSync(lockPath)).toBe(true);
			expect(existsSync(`${logPath}.1`)).toBe(false);
			expect(readFileSync(logPath, "utf8")).toContain('"event":"test.during-live-lock"');
		});
	});

	test("bounds long-epoch call and read identity tracking", () => {
		const tracker = new ContextGatewayEfficiencyTracker();
		for (let index = 0; index <= 4_096; index++) {
			tracker.recordToolCall({
				toolCallId: `call-${index}`,
				toolName: "Read",
				input: { path: `/private/source-${index}.txt`, offset: 1, limit: 1 },
			});
		}

		const evictedResult = tracker.recordToolResult({
			toolCallId: "call-0",
			toolName: "Read",
			content: [{ type: "text", text: "old" }],
			details: {},
			isError: false,
		}, observeToolResult({
			toolCallId: "call-0",
			toolName: "Read",
			content: [{ type: "text", text: "old" }],
			details: {},
			isError: false,
		}, 32_768));
		const agedOutRead = tracker.recordToolCall({
			toolCallId: "call-repeat-oldest",
			toolName: "Read",
			input: { path: "/private/source-0.txt", offset: 1, limit: 1 },
		});

		expect(evictedResult).toBeUndefined();
		expect(agedOutRead?.retrievalKind).toBeUndefined();
	});

	test("mode transitions finalize and start epochs while in-flight refusal emits nothing", async () => {
		await withCleanEnv(async () => {
			const dir = tempDir();
			const logPath = join(dir, "context-gateway-accounting.jsonl");
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_LOG = logPath;
			const pi = new FakePi();
			const runtime = registerContextGateway(pi as any, { loadConfig: () => config("observe") });
			await pi.handlers.get("session_start")![0]({}, {});

			await pi.handlers.get("tool_call")![0]({
				toolCallId: "in-flight",
				toolName: "Read",
				input: { path: "/private/source.txt" },
			}, {});
			expect(runtime.setRuntimeMode("enforce").ok).toBe(false);
			await pi.handlers.get("tool_result")![0]({
				toolCallId: "in-flight",
				toolName: "Read",
				content: [{ type: "text", text: "small" }],
				details: {},
				isError: false,
			}, {});

			expect(runtime.setRuntimeMode("enforce").ok).toBe(true);
			expect(runtime.setRuntimeMode("off").ok).toBe(true);
			expect(runtime.setRuntimeMode("observe").ok).toBe(true);
			await pi.handlers.get("session_shutdown")![0]({}, {});

			const records = readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const changes = records.filter((record) => record.event === "mode.change");
			expect(changes.map(({ from, to }) => ({ from, to }))).toEqual([
				{ from: "observe", to: "enforce" },
				{ from: "enforce", to: "off" },
				{ from: "off", to: "observe" },
			]);
			expect(records.filter((record) => record.event === "session.start")).toHaveLength(3);
			expect(records.filter((record) => record.event === "session.summary")).toHaveLength(3);
		});
	});

	test("integration log contains efficiency/provider scalars but never raw bodies, paths, or tool arguments", async () => {
		await withCleanEnv(async () => {
			const dir = tempDir();
			const logPath = join(dir, "context-gateway-accounting.jsonl");
			process.env.PI_CONTEXT_GATEWAY_ACCOUNTING_LOG = logPath;
			const pi = new FakePi();
			registerContextGateway(pi as any, { loadConfig: () => config("enforce") });
			await pi.handlers.get("session_start")![0]({}, {});

			await pi.handlers.get("tool_call")![0]({
				toolCallId: "private-call-id",
				toolName: "web_fetch",
				input: { url: "https://secret.example/private" },
			}, {});
			const secretBody = "SECRET_WEB_BODY ".repeat(200);
			await pi.handlers.get("tool_result")![0]({
				toolCallId: "private-call-id",
				toolName: "web_fetch",
				content: [{ type: "text", text: secretBody }],
				details: { content: secretBody, title: "private title", links: [] },
				isError: false,
			}, {});

			for (const [callId, body] of [["private-read-1", "first read"], ["private-read-2", "second read"]] as const) {
				await pi.handlers.get("tool_call")![0]({
					toolCallId: callId,
					toolName: "Read",
					input: { path: "/private/retrieval-source.txt", offset: 1, limit: 20 },
				}, {});
				await pi.handlers.get("tool_result")![0]({
					toolCallId: callId,
					toolName: "Read",
					content: [{ type: "text", text: body }],
					details: {},
					isError: false,
				}, {});
			}
			await pi.handlers.get("before_provider_request")![0]({ payload: {} }, { model: { provider: "p", id: "m" } });
			await pi.handlers.get("message_end")![0]({
				message: {
					role: "assistant",
					provider: "p",
					model: "m",
					stopReason: "stop",
					usage: { input: 120, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 170, cost: { total: 0.1 } },
				},
			}, {});
			await pi.handlers.get("session_shutdown")![0]({}, {});

			expect(existsSync(logPath)).toBe(true);
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain('"event":"tool.result"');
			expect(log).toContain('"event":"provider.completion"');
			expect(log).toContain('"retrievalKind":"repeat-read"');
			expect(log).toMatch(/"retrievalBytes":\d+/);
			expect(log).toMatch(/"retrievalEstimatedTokens":\d+/);
			expect(log).toContain('"providerInputTokens":120');
			expect(log).not.toContain("SECRET_WEB_BODY");
			expect(log).not.toContain("secret.example");
			expect(log).not.toContain("retrieval-source.txt");
			expect(log).not.toContain("private-call-id");
		});
	});
});
