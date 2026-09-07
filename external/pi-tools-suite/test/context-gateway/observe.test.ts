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
		expect(status).toContain("overBudget=1");
		expect(status).not.toContain("OBSERVE_BODY_SHOULD_NOT_BE_STORED");
		expect(status).not.toContain("private/needle.ts");
		expect(runtime.telemetry.snapshot().byClass["code-read"]?.upstreamTruncatedResults).toBe(1);
	});

	test("runtime observe mode is ephemeral and enforce is refused", async () => {
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
		expect(notifications.at(-1)?.message).toContain("enforce is unavailable in P01");
		await pi.commands.get("context-gateway").handler("doctor", ctx);
		expect(notifications.at(-1)?.message).toContain("requested=observe, effective=observe");
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

	test("configured enforce is downgraded to effective off with an explicit refusal", async () => {
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
		expect(doctor).toContain("requested=enforce, effective=off");
		expect(doctor).toContain("BLOCKED: enforce is unavailable in P01");
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
