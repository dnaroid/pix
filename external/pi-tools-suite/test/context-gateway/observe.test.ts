import { describe, expect, test } from "bun:test";

import { MODULES } from "../../src/index.js";
import { accountContextGatewayParts, registerContextGateway } from "../../src/context-gateway/index.js";
import { ContextGatewayTelemetry } from "../../src/context-gateway/telemetry.js";
import type { ContextGatewayResolvedConfig } from "../../src/context-gateway/types.js";

function config(mode: "off" | "observe" | "enforce", maxResultBytes = 8192): ContextGatewayResolvedConfig {
	return {
		mode,
		budgets: {
			maxInlineBytes: 8192,
			maxResultBytes,
			maxExactReadBytes: 32768,
			maxSearchBytes: 8192,
			maxSearchMatches: 12,
		},
		issues: [],
	};
}

class FakePi {
	handlers = new Map<string, any[]>();
	commands = new Map<string, any>();
	tools: any[] = [];
	on(name: string, handler: any) {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
	}
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	registerTool(tool: any) { this.tools.push(tool); }
}

function commandContext(notifications: Array<{ message: string; type?: string }>) {
	return {
		cwd: "/context-gateway-observe",
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
	};
}

describe("context gateway P01 observe module", () => {
	test("publishes the verified storeless result/provider ordering", () => {
		const names = MODULES.map((module) => module.name);
		expect(names.indexOf("lsp")).toBeLessThan(names.indexOf("context-gateway"));
		expect(names.indexOf("comment-checker")).toBeLessThan(names.indexOf("context-gateway"));
		expect(names.indexOf("context-gateway")).toBeLessThan(names.indexOf("truncation-metadata-normalizer"));
		expect(names.indexOf("truncation-metadata-normalizer")).toBeLessThan(names.indexOf("dcp"));
		expect(names.indexOf("dcp")).toBeLessThan(names.indexOf("credential-firewall"));
		expect(names.indexOf("credential-firewall")).toBeLessThan(names.indexOf("codex-reasoning-fix"));
		expect(names.at(-1)).toBe("codex-reasoning-fix");
	});

	test("off is byte-equivalent and registers no model tools", async () => {
		const pi = new FakePi();
		registerContextGateway(pi as any, { loadConfig: () => config("off") });
		const event = {
			type: "tool_result",
			toolCallId: "off-1",
			toolName: "read",
			input: { path: "secret/path.ts" },
			content: [{ type: "text", text: "OFF_BODY" }],
			details: { marker: "OFF_DETAILS" },
			isError: false,
		};
		const before = JSON.stringify(event);
		const result = await pi.handlers.get("tool_result")![0](event, { cwd: "/context-gateway-observe" });

		expect(result).toBeUndefined();
		expect(JSON.stringify(event)).toBe(before);
		expect(pi.tools).toHaveLength(0);

		const notifications: Array<{ message: string; type?: string }> = [];
		await pi.commands.get("context-gateway").handler("status", commandContext(notifications));
		expect(notifications.at(-1)?.message).toContain("effective=off");
		expect(notifications.at(-1)?.message).toContain("Observed results=0");
	});

	test("observe records only aggregate metadata and still returns no transformation", async () => {
		const pi = new FakePi();
		const runtime = registerContextGateway(pi as any, { loadConfig: () => config("observe", 32) });
		const ctx = { cwd: "/context-gateway-observe" };
		const call = { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: "private/needle.ts", offset: 1, limit: 20 } };
		await pi.handlers.get("tool_call")![0](call, ctx);
		const event = {
			type: "tool_result",
			toolCallId: "read-1",
			toolName: "read",
			input: call.input,
			content: [{ type: "text", text: "OBSERVE_BODY_SHOULD_NOT_BE_STORED" }],
			details: {
				privatePath: "private/needle.ts",
				truncation: { truncated: true },
			},
			isError: false,
		};
		const before = JSON.stringify(event);

		expect(await pi.handlers.get("tool_result")![0](event, ctx)).toBeUndefined();
		expect(JSON.stringify(event)).toBe(before);
		expect(pi.tools).toHaveLength(0);

		const notifications: Array<{ message: string; type?: string }> = [];
		await pi.commands.get("context-gateway").handler("status", commandContext(notifications));
		const status = notifications.at(-1)?.message ?? "";
		expect(status).toContain("effective=observe");
		expect(status).toContain("Observed results=1");
		expect(status).toContain("upstreamTruncated=1");
		expect(status).toContain("overBudget=0");
		expect(status).not.toContain("OBSERVE_BODY_SHOULD_NOT_BE_STORED");
		expect(status).not.toContain("private/needle.ts");
		const snapshot = runtime.telemetry.snapshot();
		expect(snapshot.byClass["code-read"]?.upstreamTruncatedResults).toBe(1);
		expect(snapshot.lastObservation?.budgetBytes).toBe(32768);
	});

	test("runtime modes are ephemeral and enforce activates only at a safe boundary", async () => {
		const pi = new FakePi();
		registerContextGateway(pi as any, { loadConfig: () => config("off") });
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx = commandContext(notifications);

		await pi.commands.get("context-gateway").handler("mode observe", ctx);
		expect(notifications.at(-1)?.message).toContain("runtime mode set to observe");
		await pi.handlers.get("tool_result")![0]({ toolCallId: "unbound", toolName: "bash", content: [{ type: "text", text: "x" }], details: {}, isError: false }, ctx);
		await pi.commands.get("context-gateway").handler("status", ctx);
		expect(notifications.at(-1)?.message).toContain("Observed results=0");
		expect(notifications.at(-1)?.message).toContain("unbound results=1");

		await pi.commands.get("context-gateway").handler("mode enforce", ctx);
		expect(notifications.at(-1)?.message).toContain("runtime mode set to enforce");
		await pi.commands.get("context-gateway").handler("doctor", ctx);
		expect(notifications.at(-1)?.message).toContain("requested=enforce, effective=enforce");
		expect(notifications.at(-1)?.message).toContain("unsupported/unsafe results remain passthrough");
	});

	test("mode changes require a safe boundary while an observed tool call is in flight", async () => {
		const pi = new FakePi();
		const telemetry = new ContextGatewayTelemetry();
		const runtime = registerContextGateway(pi as any, { loadConfig: () => config("observe"), telemetry });
		const ctx = commandContext([]);

		await pi.handlers.get("tool_call")![0]({
			toolCallId: "mode-boundary-call",
			toolName: "Read",
			input: { path: "private.ts" },
		}, ctx);
		const blocked = runtime.setRuntimeMode("off");
		expect(blocked.ok).toBe(false);
		expect(blocked.message).toContain("safe boundary");
		expect(runtime.effectiveMode).toBe("observe");

		await pi.handlers.get("tool_result")![0]({
			toolCallId: "mode-boundary-call",
			toolName: "Read",
			content: [{ type: "text", text: "observed-before-mode-change" }],
			details: {},
			isError: false,
		}, ctx);
		expect(runtime.telemetry.snapshot().results).toBe(1);

		const switched = runtime.setRuntimeMode("off");
		expect(switched.ok).toBe(true);
		expect(runtime.effectiveMode).toBe("off");
		expect(telemetry.pendingCallCount()).toBe(0);
	});

	test("session lifecycle resets aggregate and transient telemetry without rewriting persisted results", async () => {
		const pi = new FakePi();
		const telemetry = new ContextGatewayTelemetry();
		const runtime = registerContextGateway(pi as any, { loadConfig: () => config("observe"), telemetry });
		const ctx = commandContext([]);
		const recordOne = async (id: string) => {
			await pi.handlers.get("tool_call")![0]({ toolCallId: id, toolName: "Read", input: { path: `${id}.ts` } }, ctx);
			await pi.handlers.get("tool_result")![0]({
				toolCallId: id,
				toolName: "Read",
				content: [{ type: "text", text: `body-${id}` }],
				details: {},
				isError: false,
			}, ctx);
		};

		await recordOne("before-tree");
		expect(runtime.telemetry.snapshot().results).toBe(1);
		await pi.handlers.get("session_tree")![0]({ type: "session_tree" }, ctx);
		expect(runtime.telemetry.snapshot().results).toBe(0);
		expect(telemetry.pendingCallCount()).toBe(0);

		await recordOne("before-start");
		expect(runtime.telemetry.snapshot().results).toBe(1);
		await pi.handlers.get("session_start")![0]({ type: "session_start", reason: "resume" }, ctx);
		expect(runtime.telemetry.snapshot().results).toBe(0);

		await recordOne("before-shutdown");
		expect(runtime.telemetry.snapshot().results).toBe(1);
		await pi.handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(runtime.telemetry.snapshot().results).toBe(0);
		expect(telemetry.pendingCallCount()).toBe(0);
	});

	test("parallel observed calls can complete out of order without crossing class/parser bindings", async () => {
		const pi = new FakePi();
		const telemetry = new ContextGatewayTelemetry();
		const runtime = registerContextGateway(pi as any, { loadConfig: () => config("observe"), telemetry });
		const ctx = commandContext([]);

		await pi.handlers.get("tool_call")![0]({ toolCallId: "parallel-read", toolName: "Read", input: { path: "a.ts" } }, ctx);
		await pi.handlers.get("tool_call")![0]({ toolCallId: "parallel-shell", toolName: "Bash", input: { command: "bun test" } }, ctx);
		expect(telemetry.pendingCallCount()).toBe(2);

		await pi.handlers.get("tool_result")![0]({
			toolCallId: "parallel-shell",
			toolName: "Bash",
			content: [{ type: "text", text: "bun test v1.3.14\n 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]" }],
			details: {},
			isError: false,
		}, ctx);
		await pi.handlers.get("tool_result")![0]({
			toolCallId: "parallel-read",
			toolName: "Read",
			content: [{ type: "text", text: "export const a = 1;" }],
			details: {},
			isError: false,
		}, ctx);

		const snapshot = runtime.telemetry.snapshot();
		expect(snapshot.results).toBe(2);
		expect(snapshot.byClass.shell?.results).toBe(1);
		expect(snapshot.byClass["code-read"]?.results).toBe(1);
		expect(snapshot.testOutput.results).toBe(1);
		expect(snapshot.unboundResults).toBe(0);
		expect(telemetry.pendingCallCount()).toBe(0);
	});

	test("late results after a branch/session boundary stay unbound and do not contaminate the new aggregate", async () => {
		const pi = new FakePi();
		const telemetry = new ContextGatewayTelemetry();
		const runtime = registerContextGateway(pi as any, { loadConfig: () => config("observe"), telemetry });
		const ctx = commandContext([]);

		await pi.handlers.get("tool_call")![0]({
			toolCallId: "old-branch-call",
			toolName: "Bash",
			input: { command: "bun test" },
		}, ctx);
		expect(telemetry.pendingCallCount()).toBe(1);

		await pi.handlers.get("session_tree")![0]({ type: "session_tree" }, ctx);
		expect(runtime.telemetry.snapshot().results).toBe(0);
		expect(telemetry.pendingCallCount()).toBe(0);

		await pi.handlers.get("tool_result")![0]({
			toolCallId: "old-branch-call",
			toolName: "Bash",
			content: [{ type: "text", text: "bun test v1.3.14\n 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]" }],
			details: {},
			isError: false,
		}, ctx);

		const afterLate = runtime.telemetry.snapshot();
		expect(afterLate.unboundResults).toBe(1);
		expect(afterLate.results).toBe(0);
		expect(afterLate.testOutput.results).toBe(0);
		expect(afterLate.byClass.shell).toBeUndefined();

		await pi.handlers.get("tool_call")![0]({ toolCallId: "new-branch-call", toolName: "Read", input: { path: "new.ts" } }, ctx);
		await pi.handlers.get("tool_result")![0]({
			toolCallId: "new-branch-call",
			toolName: "Read",
			content: [{ type: "text", text: "export const fresh = true;" }],
			details: {},
			isError: false,
		}, ctx);

		const current = runtime.telemetry.snapshot();
		expect(current.results).toBe(1);
		expect(current.byClass["code-read"]?.results).toBe(1);
		expect(current.byClass.shell).toBeUndefined();
	});

	test("configured enforce leaves unbound/non-enforceable results byte-equivalent", async () => {
		const pi = new FakePi();
		registerContextGateway(pi as any, { loadConfig: () => config("enforce") });
		const result = await pi.handlers.get("tool_result")![0]({
			toolCallId: "enforce-1",
			toolName: "read",
			content: [{ type: "text", text: "RAW_MUST_REMAIN_UNTOUCHED_IN_P01" }],
			details: {},
			isError: false,
		}, { cwd: "/context-gateway-observe" });
		expect(result).toBeUndefined();

		const notifications: Array<{ message: string; type?: string }> = [];
		await pi.commands.get("context-gateway").handler("doctor", commandContext(notifications));
		const doctor = notifications.at(-1)?.message ?? "";
		expect(doctor).toContain("requested=enforce, effective=enforce");
		expect(doctor).toContain("irreversible read truncation is disabled");
		expect(doctor).not.toContain("BLOCKED");
	});

	test("enforce compacts only an over-budget recognised complete simple test result", async () => {
		const pi = new FakePi();
		const runtime = registerContextGateway(pi as any, { loadConfig: () => config("enforce", 256) });
		const ctx = commandContext([]);
		const raw = [
			"bun test v1.3.14",
			...Array.from({ length: 25 }, (_, index) => `(pass) suite > case ${index + 1} [1.00ms] ${"detail ".repeat(6)}`),
			" 25 pass",
			" 0 fail",
			"Ran 25 tests across 1 file. [5.00ms]",
		].join("\n");

		await pi.handlers.get("tool_call")![0]({
			toolCallId: "test-compact",
			toolName: "Bash",
			input: { command: "bun test test/a.test.ts" },
		}, ctx);
		const result = await pi.handlers.get("tool_result")![0]({
			toolCallId: "test-compact",
			toolName: "Bash",
			content: [{ type: "text", text: raw }],
			details: {},
			isError: false,
		}, ctx);

		const text = result?.content?.[0]?.text ?? "";
		expect(text).toContain("Execution outcome: SUCCESS");
		expect(text).toContain("Recognised format: bun-test");
		expect(text).toContain("Terminal summary: 25 passed, 0 failed, 25 tests, 1 files");
		expect(text).not.toContain("suite > case 1");
		const snapshot = runtime.telemetry.snapshot();
		expect(snapshot.enforcedResults).toBe(1);
		expect(snapshot.actualBytesSaved).toBeGreaterThan(0);
		expect(snapshot.contentBytes).toBeGreaterThan(snapshot.deliveredContentBytes);
		expect(snapshot.lastObservation).toMatchObject({
			budgetBytes: 256,
			delivery: { representation: "test-build-compact" },
		});
	});

	test("enforce compacts over-budget web results while retaining structured raw details for recovery", async () => {
		const cfg = config("enforce", 1_024);
		cfg.budgets.maxInlineBytes = 1_024;
		const pi = new FakePi();
		const runtime = registerContextGateway(pi as any, { loadConfig: () => cfg });
		const ctx = commandContext([]);
		const rawDetails = {
			results: [
				{ title: "Primary", url: "https://example.com/primary", content: `important lead ${"large body ".repeat(600)}RAW_RECOVERY_SENTINEL` },
				{ title: "Secondary", url: "https://example.com/secondary", content: "secondary evidence" },
			],
			provider: "ollama",
		};

		await pi.handlers.get("tool_call")![0]({ toolCallId: "web-large", toolName: "web_search", input: { query: "topic" } }, ctx);
		const result = await pi.handlers.get("tool_result")![0]({
			toolCallId: "web-large",
			toolName: "web_search",
			content: [{ type: "text", text: `raw provider view ${"huge ".repeat(2_000)}RAW_RECOVERY_SENTINEL` }],
			details: rawDetails,
			isError: false,
		}, ctx);

		const text = result?.content?.[0]?.text ?? "";
		expect(text).toContain("over-budget web result compacted");
		expect(text).toContain("Recovery key: toolCallId=web-large");
		expect(text).toContain("https://example.com/primary");
		expect(text).not.toContain("RAW_RECOVERY_SENTINEL");
		expect(result?.details?.results?.[0]?.content).toContain("RAW_RECOVERY_SENTINEL");
		expect(result?.details?.contextGateway).toMatchObject({
			version: 1,
			representation: "web-recoverable-compact",
		});
		const snapshot = runtime.telemetry.snapshot();
		expect(snapshot.enforcedResults).toBe(1);
		expect(snapshot.lastObservation?.delivery.representation).toBe("web-recoverable-compact");
	});

	test("enforce fails open for within-budget, compound, truncated, unknown, and read results", async () => {
		const cfg = config("enforce", 256);
		cfg.budgets.maxExactReadBytes = 32;
		const pi = new FakePi();
		const runtime = registerContextGateway(pi as any, { loadConfig: () => cfg });
		const ctx = commandContext([]);
		const complete = "bun test v1.3.14\n 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]";
		const cases = [
			{ id: "within", toolName: "Bash", input: { command: "bun test test/a.test.ts" }, content: complete, details: {} },
			{ id: "compound", toolName: "Bash", input: { command: "bun test test/a.test.ts && echo done" }, content: `${"padding\n".repeat(80)}${complete}`, details: {} },
			{ id: "truncated", toolName: "Bash", input: { command: "bun test test/a.test.ts" }, content: `${"padding\n".repeat(80)}${complete}`, details: { truncation: { truncated: true } } },
			{ id: "unknown", toolName: "Bash", input: { command: "node custom-runner.mjs" }, content: "CUSTOM\n".repeat(100), details: {} },
			{ id: "read", toolName: "Read", input: { path: "private.ts", offset: 1, limit: 20 }, content: "RAW_READ_MUST_SURVIVE".repeat(20), details: {} },
		];

		for (const item of cases) {
			await pi.handlers.get("tool_call")![0]({ toolCallId: item.id, toolName: item.toolName, input: item.input }, ctx);
			const result = await pi.handlers.get("tool_result")![0]({
				toolCallId: item.id,
				toolName: item.toolName,
				content: [{ type: "text", text: item.content }],
				details: item.details,
				isError: false,
			}, ctx);
			expect(result).toBeUndefined();
		}

		const snapshot = runtime.telemetry.snapshot();
		expect(snapshot.enforcedResults).toBe(0);
		expect(snapshot.actualBytesSaved).toBe(0);
		expect(snapshot.byClass["code-read"]?.overBudgetResults).toBe(1);
		expect(snapshot.byClass["code-read"]?.actualBytesSaved).toBe(0);
	});

	test("enforce never post-hoc slices producer-native repo compact output", async () => {
		const cfg = config("enforce", 64);
		cfg.budgets.maxSearchBytes = 64;
		const pi = new FakePi();
		const runtime = registerContextGateway(pi as any, { loadConfig: () => cfg });
		const ctx = commandContext([]);
		const content = "PRODUCER_NATIVE_COMPACT\n".repeat(20);
		await pi.handlers.get("tool_call")![0]({
			toolCallId: "repo-native",
			toolName: "repo_search",
			input: { query: "needle" },
		}, ctx);
		const result = await pi.handlers.get("tool_result")![0]({
			toolCallId: "repo-native",
			toolName: "repo_search",
			content: [{ type: "text", text: content }],
			details: { nativePolicy: { version: 1, profile: "native-compact", outputMode: "compact", refused: false } },
			isError: false,
		}, ctx);
		expect(result).toBeUndefined();
		const snapshot = runtime.telemetry.snapshot();
		expect(snapshot.byClass["repo-search"]?.overBudgetResults).toBe(1);
		expect(snapshot.byClass["repo-search"]?.actualBytesSaved).toBe(0);
		expect(snapshot.nativePolicy.results).toBe(1);
	});
});

describe("context gateway P01 telemetry contracts", () => {
	test("repeat reads are passive candidates and telemetry never exposes raw args/body", () => {
		const telemetry = new ContextGatewayTelemetry();
		for (const id of ["r1", "r2"]) {
			telemetry.recordToolCall({ toolCallId: id, toolName: "read", input: { path: "sensitive/file.ts", offset: 10, limit: 5 } });
			telemetry.record({
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: "SECRET_BODY_FOR_REPEAT_TEST" }],
				details: { path: "sensitive/file.ts" },
				isError: false,
			}, config("observe").budgets.maxResultBytes);
		}
		telemetry.recordToolCall({ toolCallId: "retrieval-1", toolName: "artifact_read", input: { artifactId: "private-id" } });

		const snapshot = telemetry.snapshot();
		expect(snapshot.repeatCandidateCount).toBe(1);
		expect(snapshot.byClass["code-read"]?.results).toBe(2);
		expect(snapshot.unboundResults).toBe(0);
		expect(snapshot.retrievalCalls).toBe(1);
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("sensitive/file.ts");
		expect(serialized).not.toContain("SECRET_BODY_FOR_REPEAT_TEST");
	});

	test("normalises read identity while distinguishing exact repeats from new ranges", () => {
		const telemetry = new ContextGatewayTelemetry();
		telemetry.recordToolCall({ toolCallId: "r1", toolName: "read", input: { path: "./src/../src/a.ts", offset: 1, limit: 10 } });
		telemetry.recordToolCall({ toolCallId: "r2", toolName: "Read", input: { path: "src/a.ts", offset: "1", limit: "10" } });
		telemetry.recordToolCall({ toolCallId: "r3", toolName: "read", input: { path: "src/a.ts", offset: 11, limit: 10 } });

		const snapshot = telemetry.snapshot();
		expect(snapshot.repeatCandidateCount).toBe(1);
		expect(snapshot.sameSourceDifferentRangeCount).toBe(1);
		expect(JSON.stringify(snapshot)).not.toContain("src/a.ts");
	});

	test("N01 negative fixture keeps tool results out of assistant prose and carries branch scope", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "USER" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "PROSE" },
					{ type: "thinking", thinking: "THINK" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x.ts" } },
				],
			},
			{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "TOOL_RESULT" }], details: { source: "fixture" } },
		];

		const accounting = accountContextGatewayParts(messages, { sessionId: "fixture", branchLeafId: "leaf" });
		expect(accounting.categories.userText.bytes).toBe(Buffer.byteLength("USER"));
		expect(accounting.categories.assistantProse.bytes).toBe(Buffer.byteLength("PROSE"));
		expect(accounting.categories.assistantThinking.bytes).toBe(Buffer.byteLength("THINK"));
		expect(accounting.categories.assistantToolCallArguments.bytes).toBe(Buffer.byteLength(JSON.stringify({ path: "x.ts" })));
		expect(accounting.categories.toolResultText.bytes).toBe(Buffer.byteLength("TOOL_RESULT"));
		expect(accounting.categories.assistantProse.bytes).not.toBe(
			accounting.categories.assistantProse.bytes + accounting.categories.toolResultText.bytes,
		);
		expect(accounting.scope).toEqual({ sessionId: "fixture", branchLeafId: "leaf" });
	});

	test("records only allowlisted native policy outcome fields from repo tools", () => {
		const telemetry = new ContextGatewayTelemetry();
		telemetry.recordToolCall({
			toolCallId: "repo-refusal",
			toolName: "repo_search",
			input: { target: "PRIVATE_NATIVE_QUERY", args: ["--max-files", "99"] },
		});
		telemetry.recordToolResult({
			toolCallId: "repo-refusal",
			toolName: "repo_search",
			content: [{ type: "text", text: "PRIVATE_NATIVE_BODY" }],
			details: {
				nativePolicy: {
					version: 1,
					profile: "native-compact",
					outputMode: "compact",
					refused: true,
					reason: "compact-limit-exceeded",
					query: "MUST_NOT_BE_COPIED",
				},
			},
			isError: true,
		}, 8192);

		telemetry.recordToolResult({
			toolCallId: "forged",
			toolName: "custom_tool",
			content: [],
			details: {
				nativePolicy: {
					version: 1,
					profile: "native-compact",
					outputMode: "full",
					refused: true,
					reason: "PRIVATE_REASON",
				},
			},
			isError: true,
		}, 8192);

		const snapshot = telemetry.snapshot();
		expect(snapshot.nativePolicy).toEqual({
			results: 1,
			refusals: 1,
			fullOverrides: 0,
			byReason: { "compact-limit-exceeded": 1 },
		});
		const serialized = JSON.stringify(snapshot.nativePolicy);
		expect(serialized).not.toContain("PRIVATE_NATIVE_QUERY");
		expect(serialized).not.toContain("PRIVATE_NATIVE_BODY");
		expect(serialized).not.toContain("MUST_NOT_BE_COPIED");
		expect(serialized).not.toContain("PRIVATE_REASON");
	});

	test("counts duplicated truncation metadata by size without retaining its body", () => {
		const telemetry = new ContextGatewayTelemetry();
		const duplicate = "PRIVATE_TRUNCATION_DUPLICATE".repeat(500);
		telemetry.recordToolCall({ toolCallId: "dup-read", toolName: "read", input: { path: "private.ts" } });
		telemetry.recordToolResult({
			toolCallId: "dup-read",
			toolName: "read",
			content: [{ type: "text", text: duplicate }],
			details: {
				truncation: {
					content: duplicate,
					truncated: true,
					totalLines: 500,
					outputLines: 400,
				},
			},
			isError: false,
		}, 8_192);

		const snapshot = telemetry.snapshot();
		expect(snapshot.upstreamTruncatedResults).toBe(1);
		expect(snapshot.detailsBytes).toBeGreaterThan(8_192);
		expect(snapshot.byClass["code-read"]?.detailsBytes).toBeGreaterThan(8_192);
		expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_TRUNCATION_DUPLICATE");
	});

	test("classifies shell test/build output in observe telemetry without retaining diagnostics, args, or body", () => {
		const telemetry = new ContextGatewayTelemetry();
		const cases = [
			{
				id: "bun-fail",
				text: `bun test v1.3.14\n(fail) PRIVATE_TEST_NAME\nerror: PRIVATE_DIAGNOSTIC_BODY\n 0 pass\n 1 fail\nRan 1 test across 1 file. [1.00ms]\nCommand exited with code 1`,
				isError: true,
				details: {},
			},
			{
				id: "bun-truncated",
				text: `bun test v1.3.14\n(pass) PRIVATE_PASS_NAME\n 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]`,
				isError: false,
				details: { truncation: { truncated: true } },
			},
			{
				id: "tsc-fail",
				text: `src/private.ts(1,1): error TS2322: PRIVATE_TSC_DIAGNOSTIC\nFound 1 error in 1 file.\nCommand exited with code 2`,
				isError: true,
				details: {},
			},
			{
				id: "unknown",
				text: "PRIVATE_CUSTOM_BUILD_BODY without a formal terminal summary",
				isError: false,
				details: {},
			},
		];

		for (const item of cases) {
			telemetry.recordToolCall({
				toolCallId: item.id,
				toolName: "Bash",
				input: { command: `PRIVATE_COMMAND_${item.id}` },
			});
			const event = {
				toolCallId: item.id,
				toolName: "Bash",
				content: [{ type: "text", text: item.text }],
				details: item.details,
				isError: item.isError,
			};
			const before = JSON.stringify(event);
			telemetry.recordToolResult(event, 8_192);
			expect(JSON.stringify(event)).toBe(before);
		}

		const snapshot = telemetry.snapshot();
		expect(snapshot.testOutput).toEqual({
			parserVersion: 1,
			results: 4,
			scanLimitedResults: 0,
			compactCandidates: 2,
			passthroughRecommended: 2,
			byClassification: { recognised: 2, partial: 1, unrecognised: 1 },
			byFormat: { "bun-test": 2, tap: 0, typescript: 1, mixed: 0, unknown: 1 },
		});
		expect(snapshot.lastObservation?.testOutput).toEqual({
			parserVersion: 1,
			classification: "unrecognised",
			format: "unknown",
			scanLimited: false,
			terminalSummarySeen: false,
			diagnosticCount: 0,
			warningCount: 0,
			commandScope: "simple",
			prospectiveDecision: "passthrough",
			prospectiveReason: "parser-not-complete",
		});
		const serialized = JSON.stringify(snapshot);
		for (const sentinel of [
			"PRIVATE_TEST_NAME",
			"PRIVATE_DIAGNOSTIC_BODY",
			"PRIVATE_PASS_NAME",
			"PRIVATE_TSC_DIAGNOSTIC",
			"PRIVATE_CUSTOM_BUILD_BODY",
			"PRIVATE_COMMAND_",
		]) expect(serialized).not.toContain(sentinel);
	});

	test("keeps only a safe command-scope enum and refuses prospective compact delivery for compound shell input", () => {
		const telemetry = new ContextGatewayTelemetry();
		telemetry.recordToolCall({
			toolCallId: "compound-bun",
			toolName: "Bash",
			input: { command: "bun test && npm run build PRIVATE_COMPOUND_COMMAND" },
		});
		telemetry.recordToolResult({
			toolCallId: "compound-bun",
			toolName: "Bash",
			content: [{ type: "text", text: "bun test v1.3.14\n 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]" }],
			details: {},
			isError: false,
		}, 8_192);

		const snapshot = telemetry.snapshot();
		expect(snapshot.lastObservation?.testOutput).toMatchObject({
			classification: "recognised",
			format: "bun-test",
			commandScope: "compound",
			prospectiveDecision: "passthrough",
			prospectiveReason: "compound-command",
		});
		expect(snapshot.testOutput.compactCandidates).toBe(0);
		expect(snapshot.testOutput.passthroughRecommended).toBe(1);
		expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_COMPOUND_COMMAND");
	});
});
