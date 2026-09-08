import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
	AgentSession,
	createAgentSession,
	createBashToolDefinition,
	createExtensionRuntime,
	ExtensionRunner,
	SessionManager,
	SettingsManager,
	type Extension,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";

import { registerContextGateway } from "../../src/context-gateway/index.js";
import type { ContextGatewayMode } from "../../src/context-gateway/types.js";
import credentialFirewall from "../../src/credential-firewall/index.js";
import codexReasoningFix from "../../src/codex-reasoning-fix/index.js";
import truncationMetadataNormalizer from "../../src/truncation-metadata-normalizer/index.js";

type ToolResultHandler = (event: ToolResultEvent, ctx: unknown) => unknown | Promise<unknown>;

type HeadlessToolHarnessOptions = {
	toolName: string;
	toolCallArgs: Record<string, unknown>;
	tool: any;
	extensions?: Extension[];
};

function extension(path: string, handlers: ToolResultHandler[]): Extension {
	return {
		path,
		resolvedPath: path,
		sourceInfo: {} as Extension["sourceInfo"],
		handlers: new Map([["tool_result", handlers as any]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as Extension;
}

function createRunner(extensions: Extension[]): ExtensionRunner {
	return new ExtensionRunner(
		extensions,
		createExtensionRuntime(),
		"/context-gateway-sdk-contract",
		{} as any,
		{} as any,
	);
}

function contextGatewayExtension(mode: ContextGatewayMode): Extension {
	const registered = extension(`context-gateway-${mode}`, []);
	registered.handlers.clear();
	registerContextGateway({
		on(name: string, handler: any) {
			registered.handlers.set(name, [...(registered.handlers.get(name) ?? []), handler]);
		},
		registerCommand() {},
	} as any, {
		loadConfig: () => ({
			mode,
			budgets: {
				maxInlineBytes: 8192,
				maxResultBytes: 8192,
				maxExactReadBytes: 32768,
				maxSearchBytes: 8192,
				maxSearchMatches: 12,
			},
			issues: [],
		}),
	});
	return registered;
}

function truncationMetadataNormalizerExtension(): Extension {
	const registered = extension("truncation-metadata-normalizer", []);
	registered.handlers.clear();
	truncationMetadataNormalizer({
		on(name: string, handler: any) {
			registered.handlers.set(name, [...(registered.handlers.get(name) ?? []), handler]);
		},
	} as any);
	return registered;
}

function credentialFirewallExtension(): Extension {
	const registered = extension("credential-firewall", []);
	registered.handlers.clear();
	credentialFirewall({
		on(name: string, handler: any) {
			registered.handlers.set(name, [...(registered.handlers.get(name) ?? []), handler]);
		},
	} as any);
	return registered;
}

function codexReasoningFixExtension(): Extension {
	const registered = extension("codex-reasoning-fix", []);
	registered.handlers.clear();
	codexReasoningFix({
		on(name: string, handler: any) {
			registered.handlers.set(name, [...(registered.handlers.get(name) ?? []), handler]);
		},
	} as any);
	return registered;
}

function toolResult(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName: "contract_tool",
		input: { query: "needle" },
		content: [{ type: "text", text: "raw result" }],
		details: { source: "raw" },
		isError: false,
		...overrides,
	} as ToolResultEvent;
}

function createAgentSessionForToolHook(extensions: Extension[]) {
	const runtime = createExtensionRuntime();
	const agent = {
		state: {
			systemPrompt: "",
			model: undefined,
			thinkingLevel: "off",
			tools: [],
			messages: [],
		},
		beforeToolCall: undefined,
		afterToolCall: undefined,
		prepareNextTurn: undefined,
		prepareNextTurnWithContext: undefined,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		signal: undefined,
		subscribe: () => () => {},
	} as any;
	const resourceLoader = {
		getExtensions: () => ({ extensions, errors: [], runtime }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
	} as any;
	const settingsManager = {
		getImageAutoResize: () => false,
		getShellCommandPrefix: () => undefined,
		getShellPath: () => undefined,
		isProjectTrusted: () => true,
	} as any;

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory("/context-gateway-sdk-contract"),
		settingsManager,
		cwd: "/context-gateway-sdk-contract",
		resourceLoader,
		modelRuntime: {} as any,
		baseToolsOverride: {},
		initialActiveToolNames: [],
	} as any);

	return { agent, session };
}

async function createHeadlessToolHarness(options: HeadlessToolHarnessOptions) {
	const root = mkdtempSync(join(tmpdir(), "context-gateway-p00-tool-"));
	const sessionDir = join(root, "sessions");
	const agentDir = join(root, "agent");
	const contexts: any[] = [];
	const faux = fauxProvider({ provider: `context-gateway-${options.toolName}-${Date.now()}` });
	const model = faux.getModel();
	const responses = [
		fauxAssistantMessage(
			fauxToolCall(options.toolName, options.toolCallArgs, { id: `call-${options.toolName}` }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	];
	const modelRuntime = {
		streamSimple: (_requestModel: unknown, context: unknown) => {
			contexts.push(JSON.parse(JSON.stringify(context)));
			const response = responses.shift();
			if (!response) throw new Error("unexpected extra provider call");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: response.stopReason as "stop" | "length" | "toolUse" | "deferred",
					message: response,
				});
				stream.end(response);
			});
			return stream;
		},
		getModels: () => [model],
		getModel: () => model,
		getProviders: () => [],
		getAvailableSnapshot: () => [model],
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => false,
	} as any;
	const runtime = createExtensionRuntime();
	const resourceLoader = {
		getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
	} as any;
	const sessionManager = SessionManager.create(root, sessionDir);
	const settingsManager = SettingsManager.create(root, agentDir);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		model,
		thinkingLevel: "off",
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
		tools: [options.toolName],
		customTools: [options.tool],
	});

	return { root, session, sessionManager, contexts };
}

function createScriptedModelRuntime(model: any, responses: any[], contexts: any[] = []) {
	return {
		streamSimple: (_requestModel: unknown, context: unknown) => {
			contexts.push(JSON.parse(JSON.stringify(context)));
			const response = responses.shift();
			if (!response) throw new Error("unexpected extra provider call");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: response.stopReason as "stop" | "length" | "toolUse" | "deferred",
					message: response,
				});
				stream.end(response);
			});
			return stream;
		},
		getModels: () => [model],
		getModel: () => model,
		getProviders: () => [],
		getAvailableSnapshot: () => [model],
		hasConfiguredAuth: () => true,
		isUsingOAuth: () => false,
	} as any;
}

describe("context gateway P00: installed SDK tool_result pipeline", () => {
	test("chains content/details/isError/usage mutations in extension and handler order", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const first = extension("first", [
			async (event) => {
				seen.push({ stage: "first", content: event.content, details: event.details, isError: event.isError });
				return {
					content: [{ type: "text", text: "first shaped" }],
					details: { source: "first" },
					isError: true,
					usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
			},
			async (event) => {
				seen.push({ stage: "first-second-handler", content: event.content, details: event.details, isError: event.isError });
				return { content: [{ type: "text", text: "second handler shaped" }] };
			},
		]);
		const second = extension("second", [
			async (event) => {
				seen.push({ stage: "second", content: event.content, details: event.details, isError: event.isError, usage: event.usage });
				return { details: { source: "second" } };
			},
		]);
		const runner = createRunner([first, second]);

		const result = await runner.emitToolResult(toolResult());

		expect(seen.map((entry) => entry.stage)).toEqual(["first", "first-second-handler", "second"]);
		expect((seen[1]!.content as any[])[0].text).toBe("first shaped");
		expect(seen[1]!.details).toEqual({ source: "first" });
		expect(seen[1]!.isError).toBe(true);
		expect((seen[2]!.content as any[])[0].text).toBe("second handler shaped");
		expect(seen[2]!.usage).toMatchObject({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 });
		expect(result).toEqual({
			content: [{ type: "text", text: "second handler shaped" }],
			details: { source: "second" },
			isError: true,
			usage: expect.objectContaining({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 }),
		});
	});

	test("suppresses a handler exception, reports it, and continues with the current result", async () => {
		const observed: string[] = [];
		const runner = createRunner([
			extension("before-throw", [async () => ({ content: [{ type: "text", text: "bounded before throw" }] })]),
			extension("throwing", [async () => { throw new Error("capture failed"); }]),
			extension("after-throw", [
				async (event) => {
					observed.push((event.content[0] as any).text);
					return { details: { continued: true } };
				},
			]),
		]);
		const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
		runner.onError((error) => errors.push(error));

		const result = await runner.emitToolResult(toolResult());

		expect(observed).toEqual(["bounded before throw"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ extensionPath: "throwing", event: "tool_result", error: "capture failed" });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "bounded before throw" }],
			details: { continued: true },
			isError: false,
		});
	});

	test("a later independent tool_result handler can reinsert raw output after shaping", async () => {
		const rawSentinel = "P00_LATE_RAW_REINSERTION";
		const boundedSentinel = "P00_GATEWAY_BOUNDED_RESULT";
		const runner = createRunner([
			extension("gateway-stage", [async () => ({
				content: [{ type: "text", text: boundedSentinel }],
			})]),
			extension("late-third-party-stage", [async (event) => {
				expect((event.content[0] as any).text).toBe(boundedSentinel);
				return { content: [{ type: "text", text: rawSentinel }] };
			}]),
		]);

		const result = await runner.emitToolResult(toolResult());

		expect(result?.content).toEqual([{ type: "text", text: rawSentinel }]);
		expect(JSON.stringify(result)).not.toContain(boundedSentinel);
	});

	test("returns undefined when no handler changes the result", async () => {
		const runner = createRunner([
			extension("observer", [async (event) => {
				expect((event.content[0] as any).text).toBe("raw result");
				return undefined;
			}]),
		]);

		expect(await runner.emitToolResult(toolResult())).toBeUndefined();
	});

	test("AgentSession installs the real afterToolCall bridge and preserves handler mutations", async () => {
		const { agent } = createAgentSessionForToolHook([
			extension("session-shaper", [async () => ({
				content: [{ type: "text", text: "session shaped" }],
				details: { shaped: true },
				isError: true,
				usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			})]),
		]);

		expect(typeof agent.afterToolCall).toBe("function");
		const result = await agent.afterToolCall({
			toolCall: { id: "call-session", name: "contract_tool", arguments: { query: "needle" } },
			args: { query: "needle" },
			result: {
				content: [{ type: "text", text: "raw session result" }],
				details: { raw: true },
			},
			isError: false,
			assistantMessage: {},
			context: {},
		});

		expect(result).toEqual({
			content: [{ type: "text", text: "session shaped" }],
			details: { shaped: true },
			isError: true,
			usage: expect.objectContaining({ input: 5, output: 6, totalTokens: 11 }),
		});
	});

	test("AgentSession bridge fails open to the raw result when the only tool_result handler throws", async () => {
		const { agent } = createAgentSessionForToolHook([
			extension("throwing-session-handler", [async () => { throw new Error("archive unavailable"); }]),
		]);

		const result = await agent.afterToolCall({
			toolCall: { id: "call-session-fail-open", name: "contract_tool", arguments: {} },
			args: {},
			result: {
				content: [{ type: "text", text: "RAW_SENTINEL_MUST_NOT_FAIL_OPEN_IN_ENFORCE" }],
				details: { raw: "RAW_SENTINEL_MUST_NOT_FAIL_OPEN_IN_ENFORCE" },
			},
			isError: false,
			assistantMessage: {},
			context: {},
		});

		// `undefined` means pi-agent-core keeps the executed result unchanged.
		// Context Gateway enforce therefore needs its own bounded degraded result;
		// throwing from the extension handler is not an enforcement mechanism.
		expect(result).toBeUndefined();
	});

	test("runner invalidation does not itself suppress a late tool_result handler", async () => {
		const calls: string[] = [];
		const runner = createRunner([
			extension("late-unguarded", [async () => {
				calls.push("unguarded");
				return { content: [{ type: "text", text: "late result shaped" }] };
			}]),
			extension("late-guarded", [async (_event, ctx) => {
				calls.push("guarded");
				void (ctx as any).cwd;
				return { details: { shouldNotApply: true } };
			}]),
		]);
		const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
		runner.onError((error) => errors.push(error));
		runner.invalidate("stale runner after session replacement");

		const result = await runner.emitToolResult(toolResult());

		expect(calls).toEqual(["unguarded", "guarded"]);
		expect(result).toMatchObject({ content: [{ type: "text", text: "late result shaped" }] });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			extensionPath: "late-guarded",
			event: "tool_result",
			error: "stale runner after session replacement",
		});
	});

	test("custom tool exceptions reach tool_result as errors and persist for the next provider turn", async () => {
		const observed: any[] = [];
		const observer = extension("error-observer", [async (event) => {
			observed.push({
				isError: event.isError,
				content: event.content,
				details: event.details,
			});
			return undefined;
		}]);
		const harness = await createHeadlessToolHarness({
			toolName: "contract_error",
			toolCallArgs: {},
			extensions: [observer],
			tool: {
				name: "contract_error",
				label: "Contract error",
				description: "Throw a deterministic P00 contract error",
				parameters: Type.Object({}),
				async execute() {
					throw new Error("P00_CUSTOM_TOOL_FAILURE");
				},
			},
		});

		await harness.session.prompt("run the error tool", { expandPromptTemplates: false });

		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({ isError: true, details: {} });
		expect(JSON.stringify(observed[0].content)).toContain("P00_CUSTOM_TOOL_FAILURE");
		expect(harness.contexts).toHaveLength(2);
		expect(JSON.stringify(harness.contexts[1])).toContain("P00_CUSTOM_TOOL_FAILURE");
		expect(JSON.stringify(harness.contexts[1])).toContain('"isError":true');
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const jsonl = readFileSync(sessionFile!, "utf8");
		expect(jsonl).toContain("P00_CUSTOM_TOOL_FAILURE");
		expect(jsonl).toContain('"isError":true');
	});

	test("built-in bash timeout preserves partial output and timeout status but loses structured details on throw", async () => {
		const observed: any[] = [];
		const observer = extension("timeout-observer", [async (event) => {
			observed.push({
				isError: event.isError,
				content: event.content,
				details: event.details,
			});
			return undefined;
		}]);
		const bash = createBashToolDefinition(tmpdir(), {
			operations: {
				async exec(_command, _cwd, options) {
					options.onData(Buffer.from("P00_TIMEOUT_PARTIAL_OUTPUT\n", "utf8"));
					throw new Error("timeout:3");
				},
			},
		});
		const harness = await createHeadlessToolHarness({
			toolName: "bash",
			toolCallArgs: { command: "contract timeout", timeout: 3 },
			tool: bash,
			extensions: [observer],
		});

		await harness.session.prompt("run the timeout command", { expandPromptTemplates: false });

		expect(observed).toHaveLength(1);
		expect(observed[0].isError).toBe(true);
		expect(observed[0].details).toEqual({});
		const text = JSON.stringify(observed[0].content);
		expect(text).toContain("P00_TIMEOUT_PARTIAL_OUTPUT");
		expect(text).toContain("Command timed out after 3 seconds");
		expect(harness.contexts).toHaveLength(2);
		const secondContext = JSON.stringify(harness.contexts[1]);
		expect(secondContext).toContain("P00_TIMEOUT_PARTIAL_OUTPUT");
		expect(secondContext).toContain("Command timed out after 3 seconds");
		expect(secondContext).toContain('"isError":true');
	});

	test("built-in bash nonzero exit can mention a temp path in error text but loses the structured trusted handle", async () => {
		const observed: any[] = [];
		const observer = extension("nonzero-observer", [async (event) => {
			observed.push({ isError: event.isError, content: event.content, details: event.details });
			return undefined;
		}]);
		const source = Array.from({ length: 2_500 }, (_, index) => `P00_NONZERO_${index}_${"n".repeat(48)}`).join("\n");
		const bash = createBashToolDefinition(tmpdir(), {
			exposeSessionEnvironment: false,
			operations: {
				async exec(_command, _cwd, options) {
					options.onData(Buffer.from(source, "utf8"));
					return { exitCode: 7 };
				},
			},
		});
		const harness = await createHeadlessToolHarness({
			toolName: "bash",
			toolCallArgs: { command: "contract nonzero" },
			tool: bash,
			extensions: [observer],
		});

		await harness.session.prompt("run the failing command", { expandPromptTemplates: false });

		expect(observed).toHaveLength(1);
		expect(observed[0].isError).toBe(true);
		expect(observed[0].details).toEqual({});
		const text = JSON.stringify(observed[0].content);
		expect(text).toContain("Command exited with code 7");
		expect(text).toContain("Full output:");
		// The path in visible error text is not a trusted recovery capability once
		// the SDK error wrapper has collapsed structured details to {}.
		expect(JSON.stringify(observed[0].details)).not.toContain("fullOutputPath");
	});

	test("session abort finalizes an in-flight bash result as an error with the captured prefix", async () => {
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const observed: any[] = [];
		const observer = extension("abort-observer", [async (event) => {
			observed.push({
				isError: event.isError,
				content: event.content,
				details: event.details,
			});
			return undefined;
		}]);
		const bash = createBashToolDefinition(tmpdir(), {
			operations: {
				async exec(_command, _cwd, options) {
					options.onData(Buffer.from("P00_ABORT_PARTIAL_OUTPUT\n", "utf8"));
					markStarted();
					return await new Promise<{ exitCode: number | null }>((_resolve, reject) => {
						const abort = () => reject(new Error("aborted"));
						if (options.signal?.aborted) {
							abort();
							return;
						}
						options.signal?.addEventListener("abort", abort, { once: true });
					});
				},
			},
		});
		const harness = await createHeadlessToolHarness({
			toolName: "bash",
			toolCallArgs: { command: "contract abort" },
			tool: bash,
			extensions: [observer],
		});
		const sessionEvents: any[] = [];
		const unsubscribe = harness.session.subscribe((event) => sessionEvents.push(event));

		const prompt = harness.session.prompt("run the abort command", { expandPromptTemplates: false });
		await started;
		await harness.session.abort();
		await prompt;
		unsubscribe();

		expect(observed).toHaveLength(1);
		expect(observed[0].isError).toBe(true);
		expect(observed[0].details).toEqual({});
		const text = JSON.stringify(observed[0].content);
		expect(text).toContain("P00_ABORT_PARTIAL_OUTPUT");
		expect(text).toContain("Command aborted");
		const resultEnd = sessionEvents.find(
			(event) => event.type === "message_end" && event.message?.role === "toolResult",
		);
		expect(JSON.stringify(resultEnd)).toContain("P00_ABORT_PARTIAL_OUTPUT");
		expect(JSON.stringify(resultEnd)).toContain("Command aborted");
		expect(sessionEvents.some((event) => event.type === "agent_settled")).toBe(true);
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const jsonl = readFileSync(sessionFile!, "utf8");
		expect(jsonl).toContain("P00_ABORT_PARTIAL_OUTPUT");
		expect(jsonl).toContain("Command aborted");
		expect(jsonl).toContain('"isError":true');
	});

	test("reloading extensions during an in-flight tool call routes finalization through the new runner and invalidates the old wrapper", async () => {
		const root = mkdtempSync(join(tmpdir(), "context-gateway-p00-reload-"));
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		const contexts: any[] = [];
		const faux = fauxProvider({ provider: `context-gateway-reload-${Date.now()}` });
		const model = faux.getModel();
		const responses = [
			fauxAssistantMessage(fauxToolCall("late_tool", {}, { id: "call-late-tool" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		];
		const modelRuntime = createScriptedModelRuntime(model, responses, contexts);
		let generation = 0;
		let oldResults = 0;
		let newResults = 0;
		const oldRuntime = createExtensionRuntime();
		const newRuntime = createExtensionRuntime();
		const oldExtension = extension("old-generation", [async () => {
			oldResults++;
			return undefined;
		}]);
		const newExtension = extension("new-generation", [async () => {
			newResults++;
			return undefined;
		}]);
		const resourceLoader = {
			getExtensions: () => generation === 0
				? { extensions: [oldExtension], errors: [], runtime: oldRuntime }
				: { extensions: [newExtension], errors: [], runtime: newRuntime },
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			async reload() {},
		} as any;
		const sessionManager = SessionManager.create(root, sessionDir);
		const settingsManager = SettingsManager.create(root, agentDir);
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		let releaseTool!: () => void;
		const release = new Promise<void>((resolve) => { releaseTool = resolve; });
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["late_tool"],
			customTools: [{
				name: "late_tool",
				label: "Late tool",
				description: "Finish only after the extension runner reloads",
				parameters: Type.Object({}),
				async execute() {
					markStarted();
					await release;
					return {
						content: [{ type: "text" as const, text: "P00_ORIGINAL_LATE_RESULT" }],
						details: { generation: "old" },
					};
				},
			}],
		});

		const prompt = session.prompt("run the late tool", { expandPromptTemplates: false });
		await started;
		generation = 1;
		await session.reload();
		releaseTool();
		await prompt;

		expect(oldResults).toBe(0);
		expect(newResults).toBe(1);
		expect(contexts).toHaveLength(2);
		const secondContext = JSON.stringify(contexts[1]);
		expect(secondContext).not.toContain("P00_ORIGINAL_LATE_RESULT");
		expect(secondContext).toContain("stale after session replacement or reload");
		expect(secondContext).toContain('"isError":true');
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const jsonl = readFileSync(sessionFile!, "utf8");
		expect(jsonl).not.toContain("P00_ORIGINAL_LATE_RESULT");
		expect(jsonl).toContain("stale after session replacement or reload");
	});

	test("native manual compaction has its own session_before_compact -> session_compact lifecycle", async () => {
		const root = mkdtempSync(join(tmpdir(), "context-gateway-p00-native-compact-"));
		const agentDir = join(root, "agent");
		const sessionManager = SessionManager.inMemory(root);
		for (let index = 0; index < 24; index++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `user-${index}\n${"u".repeat(4_000)}` }],
				timestamp: index * 2 + 1,
			});
			sessionManager.appendMessage(fauxAssistantMessage(`assistant-${index}\n${"a".repeat(4_000)}`, {
				timestamp: index * 2 + 2,
			}));
		}
		const faux = fauxProvider({ provider: `context-gateway-native-compact-${Date.now()}` });
		const model = faux.getModel();
		let providerCalls = 0;
		const modelRuntime = {
			...createScriptedModelRuntime(model, []),
			streamSimple: () => {
				providerCalls++;
				throw new Error("native compaction should use the extension-provided result");
			},
			getAuth: async () => undefined,
		} as any;
		const lifecycle: string[] = [];
		const nativeExtension = extension("native-compaction-observer", []);
		nativeExtension.handlers.set("session_before_compact", [async (event: any) => {
			lifecycle.push(`before:${event.reason}`);
			return {
				compaction: {
					summary: "P00_NATIVE_COMPACTION_SUMMARY",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { source: "p00-native-hook" },
				},
			};
		}]);
		nativeExtension.handlers.set("session_compact", [async (event: any) => {
			lifecycle.push(`after:${event.reason}:${String(event.fromExtension)}`);
		}]);
		const runtime = createExtensionRuntime();
		const resourceLoader = {
			getExtensions: () => ({ extensions: [nativeExtension], errors: [], runtime }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
		} as any;
		const settingsManager = SettingsManager.create(root, agentDir);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
			noTools: "all",
		});
		const sessionEvents: string[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "compaction_start" || event.type === "compaction_end") {
				sessionEvents.push(`${event.type}:${event.reason}`);
			}
		});

		const result = await session.compact("P00 native lifecycle contract");
		unsubscribe();

		expect(result.summary).toBe("P00_NATIVE_COMPACTION_SUMMARY");
		expect(lifecycle).toEqual(["before:manual", "after:manual:true"]);
		expect(sessionEvents).toEqual(["compaction_start:manual", "compaction_end:manual"]);
		expect(providerCalls).toBe(0);
		const compactionEntry = sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(compactionEntry).toMatchObject({
			type: "compaction",
			summary: "P00_NATIVE_COMPACTION_SUMMARY",
			fromHook: true,
			details: { source: "p00-native-hook" },
		});
	});

	test("parallel tool execution keeps source toolCallId ordering for result messages even when completion order differs", async () => {
		const root = mkdtempSync(join(tmpdir(), "context-gateway-p00-batch-"));
		const agentDir = join(root, "agent");
		const faux = fauxProvider({ provider: `context-gateway-batch-${Date.now()}` });
		const model = faux.getModel();
		const contexts: any[] = [];
		const responses = [
			fauxAssistantMessage([
				fauxToolCall("batch_tool", { which: "first" }, { id: "batch-call-1" }),
				fauxToolCall("batch_tool", { which: "second" }, { id: "batch-call-2" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		];
		const modelRuntime = createScriptedModelRuntime(model, responses, contexts);
		const runtime = createExtensionRuntime();
		const resourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
		} as any;
		let releaseFirst!: () => void;
		const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const sessionManager = SessionManager.inMemory(root);
		const settingsManager = SettingsManager.create(root, agentDir);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["batch_tool"],
			customTools: [{
				name: "batch_tool",
				label: "Batch tool",
				description: "P00 parallel result ordering contract",
				parameters: Type.Object({ which: Type.String() }),
				async execute(_toolCallId, params: any) {
					if (params.which === "first") {
						await firstRelease;
						await new Promise((resolve) => setTimeout(resolve, 15));
					} else {
						releaseFirst();
					}
					return {
						content: [{ type: "text" as const, text: `result:${params.which}` }],
						details: { which: params.which },
					};
				},
			}],
		});
		const events: any[] = [];
		const unsubscribe = session.subscribe((event) => events.push(event));

		await session.prompt("run both batch calls", { expandPromptTemplates: false });
		unsubscribe();

		const completionOrder = events
			.filter((event) => event.type === "tool_execution_end")
			.map((event) => event.toolCallId);
		const resultMessageOrder = events
			.filter((event) => event.type === "message_end" && event.message?.role === "toolResult")
			.map((event) => event.message.toolCallId);
		expect(completionOrder).toEqual(["batch-call-2", "batch-call-1"]);
		expect(resultMessageOrder).toEqual(["batch-call-1", "batch-call-2"]);
		expect(contexts).toHaveLength(2);
		const secondContext = contexts[1].messages.filter((message: any) => message.role === "toolResult");
		expect(secondContext.map((message: any) => message.toolCallId)).toEqual(["batch-call-1", "batch-call-2"]);
	});

	test("streaming tool updates stay runtime-only while the final result is persisted and delivered", async () => {
		const streamingSentinel = "P00_STREAMING_PREVIEW_ONLY";
		const finalSentinel = "P00_STREAMING_FINAL_RESULT";
		const harness = await createHeadlessToolHarness({
			toolName: "streaming_tool",
			toolCallArgs: {},
			tool: {
				name: "streaming_tool",
				label: "Streaming tool",
				description: "Emit a preview before returning the final P00 result",
				parameters: Type.Object({}),
				async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, onUpdate: any) {
					onUpdate?.({
						content: [{ type: "text" as const, text: streamingSentinel }],
						details: { preview: streamingSentinel },
					});
					return {
						content: [{ type: "text" as const, text: finalSentinel }],
						details: { final: finalSentinel },
					};
				},
			},
		});
		const events: any[] = [];
		const unsubscribe = harness.session.subscribe((event) => events.push(event));

		await harness.session.prompt("run the streaming tool", { expandPromptTemplates: false });
		unsubscribe();

		const update = events.find((event) => event.type === "tool_execution_update");
		expect(JSON.stringify(update)).toContain(streamingSentinel);
		const resultEnd = events.find(
			(event) => event.type === "message_end" && event.message?.role === "toolResult",
		);
		expect(JSON.stringify(resultEnd)).toContain(finalSentinel);
		expect(JSON.stringify(resultEnd)).not.toContain(streamingSentinel);
		expect(harness.contexts).toHaveLength(2);
		const secondContext = JSON.stringify(harness.contexts[1]);
		expect(secondContext).toContain(finalSentinel);
		expect(secondContext).not.toContain(streamingSentinel);
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const jsonl = readFileSync(sessionFile!, "utf8");
		expect(jsonl).toContain(finalSentinel);
		expect(jsonl).not.toContain(streamingSentinel);
	});

	test("P01 off/observe are transcript/provider byte-preserving and create no Gateway archive", async () => {
		const rawSentinel = "P01_OBSERVE_RAW_RESULT_SENTINEL";
		const detailSentinel = "P01_OBSERVE_RAW_DETAILS_SENTINEL";
		for (const mode of ["off", "observe"] as const) {
			const toolName = `${mode}_contract_tool`;
			const harness = await createHeadlessToolHarness({
				toolName,
				toolCallArgs: {},
				extensions: [contextGatewayExtension(mode)],
				tool: {
					name: toolName,
					label: `${mode} contract tool`,
					description: `Return an exact P01 ${mode} sentinel`,
					parameters: Type.Object({}),
					async execute() {
						return {
							content: [{ type: "text" as const, text: rawSentinel }],
							details: { exact: detailSentinel },
						};
					},
				},
			});

			await harness.session.prompt(`run the ${mode} contract tool`, { expandPromptTemplates: false });

			expect(harness.contexts).toHaveLength(2);
			const secondContext = JSON.stringify(harness.contexts[1]);
			expect(secondContext).toContain(rawSentinel);
			expect(secondContext).toContain(detailSentinel);
			const sessionFile = harness.sessionManager.getSessionFile();
			expect(sessionFile).toBeTruthy();
			const jsonl = readFileSync(sessionFile!, "utf8");
			expect(jsonl).toContain(rawSentinel);
			expect(jsonl).toContain(detailSentinel);
			expect(existsSync(join(harness.root, "agent", "context-gateway"))).toBe(false);
		}
	});

	test("persists the post-hook tool result and sends it to the next model context", async () => {
		const root = mkdtempSync(join(tmpdir(), "context-gateway-p00-"));
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		const rawSentinel = "RAW_CONTEXT_GATEWAY_SENTINEL";
		const boundedSentinel = "BOUNDED_CONTEXT_GATEWAY_SENTINEL";
		const contexts: any[] = [];
		const providerPayloads: any[] = [];
		const faux = fauxProvider({ provider: "context-gateway-faux" });
		const model = faux.getModel();
		const responses = [
			fauxAssistantMessage(fauxToolCall("contract_tool", {}, { id: "call-headless" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		];
		const modelRuntime = {
			streamSimple: (requestModel: unknown, context: unknown, options: any) => {
				// Provider context can contain live tool definitions with execute callbacks,
				// so capture the JSON-serializable request shape instead of structuredClone().
				const capturedContext = JSON.parse(JSON.stringify(context));
				contexts.push(capturedContext);
				const response = responses.shift();
				if (!response) throw new Error("unexpected extra provider call");
				const stream = createAssistantMessageEventStream();
				queueMicrotask(async () => {
					try {
						const rawPayload = { messages: capturedContext.messages, tools: capturedContext.tools };
						const transformed = options?.onPayload
							? await options.onPayload(rawPayload, requestModel)
							: rawPayload;
						providerPayloads.push(JSON.parse(JSON.stringify(transformed ?? rawPayload)));
						stream.push({
							type: "done",
							reason: response.stopReason as "stop" | "length" | "toolUse" | "deferred",
							message: response,
						});
						stream.end(response);
					} catch (error) {
						stream.end(fauxAssistantMessage("provider harness failed", {
							stopReason: "error",
							errorMessage: error instanceof Error ? error.message : String(error),
						}));
					}
				});
				return stream;
			},
			getModels: () => [model],
			getModel: () => model,
			getProviders: () => [],
			getAvailableSnapshot: () => [model],
			hasConfiguredAuth: () => true,
			isUsingOAuth: () => false,
		} as any;
		const runtime = createExtensionRuntime();
		const shapingExtension = extension("headless-shaper", [async (event) => {
			expect((event.content[0] as any).text).toBe(rawSentinel);
			return {
				content: [{ type: "text", text: boundedSentinel }],
				details: { stored: "bounded" },
			};
		}]);
		shapingExtension.handlers.set("before_provider_request", [async (event: any) => ({
			...event.payload,
			contextGatewayObserved: true,
		})]);
		const resourceLoader = {
			getExtensions: () => ({ extensions: [shapingExtension], errors: [], runtime }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
		} as any;
		const sessionManager = SessionManager.create(root, sessionDir);
		const settingsManager = SettingsManager.create(root, agentDir);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["contract_tool"],
			customTools: [{
				name: "contract_tool",
				label: "Contract tool",
				description: "P00 headless SDK contract tool",
				parameters: Type.Object({}),
				async execute() {
					return {
						content: [{ type: "text" as const, text: rawSentinel }],
						details: { stored: rawSentinel },
					};
				},
			}],
		});
		const sessionEvents: any[] = [];
		const unsubscribe = session.subscribe((event) => sessionEvents.push(event));

		await session.prompt("run the contract tool", { expandPromptTemplates: false });
		unsubscribe();

		expect(contexts).toHaveLength(2);
		const secondContext = JSON.stringify(contexts[1]);
		expect(secondContext).toContain(boundedSentinel);
		expect(secondContext).not.toContain(rawSentinel);
		expect(providerPayloads).toHaveLength(2);
		const secondPayload = JSON.stringify(providerPayloads[1]);
		expect(secondPayload).toContain(boundedSentinel);
		expect(secondPayload).not.toContain(rawSentinel);
		expect(providerPayloads[1]).toMatchObject({ contextGatewayObserved: true });

		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const jsonl = readFileSync(sessionFile!, "utf8");
		expect(jsonl).toContain(boundedSentinel);
		expect(jsonl).not.toContain(rawSentinel);
		expect(jsonl).toContain('"stored":"bounded"');

		const executionEnd = sessionEvents.find((event) => event.type === "tool_execution_end");
		expect(JSON.stringify(executionEnd)).toContain(boundedSentinel);
		expect(JSON.stringify(executionEnd)).not.toContain(rawSentinel);
		const resultMessageEnd = sessionEvents.find(
			(event) => event.type === "message_end" && event.message?.role === "toolResult",
		);
		expect(JSON.stringify(resultMessageEnd)).toContain(boundedSentinel);
		expect(JSON.stringify(resultMessageEnd)).not.toContain(rawSentinel);
		expect(sessionEvents.some((event) => event.type === "agent_end")).toBe(true);
		expect(sessionEvents.some((event) => event.type === "agent_settled")).toBe(true);
	});

	test("opt-in truncation metadata normalization removes only duplicate details before JSONL and next context", async () => {
		const sentinel = `P00_METADATA_PIPELINE_SENTINEL:${"x".repeat(24_000)}`;
		const observerSeen: any[] = [];
		const downstreamObserver = extension("downstream-observer", [async (event) => {
			observerSeen.push({ content: event.content, details: event.details });
			return undefined;
		}]);
		const harness = await createHeadlessToolHarness({
			toolName: "read",
			toolCallArgs: {},
			extensions: [truncationMetadataNormalizerExtension(), downstreamObserver],
			tool: {
				name: "read",
				label: "Metadata contract tool",
				description: "Return one duplicated truncation payload for SDK pipeline verification",
				parameters: Type.Object({}),
				async execute() {
					return {
						content: [{ type: "text", text: `${sentinel}\n[Showing lines 1-400 of 2300.]` }],
						details: {
							truncation: {
								content: sentinel,
								truncated: true,
								truncatedBy: "bytes",
								totalLines: 2_300,
								outputLines: 400,
								totalBytes: 140_000,
								outputBytes: 24_000,
								lastLinePartial: false,
								firstLineExceedsLimit: false,
								maxLines: 2_000,
								maxBytes: 51_200,
							},
						},
					};
				},
			},
		});

		await harness.session.prompt("run the metadata contract tool", { expandPromptTemplates: false });

		expect(observerSeen).toHaveLength(1);
		expect(JSON.stringify(observerSeen[0].content)).toContain("P00_METADATA_PIPELINE_SENTINEL");
		expect(observerSeen[0].details.truncation.content).toBeUndefined();
		expect(observerSeen[0].details.truncation).toMatchObject({ truncated: true, totalLines: 2_300, maxBytes: 51_200 });

		expect(harness.contexts).toHaveLength(2);
		const secondContext = JSON.stringify(harness.contexts[1]);
		expect(secondContext.split("P00_METADATA_PIPELINE_SENTINEL").length - 1).toBe(1);
		expect(secondContext).toContain('"truncated":true');

		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const jsonl = readFileSync(sessionFile!, "utf8");
		expect(jsonl.split("P00_METADATA_PIPELINE_SENTINEL").length - 1).toBe(1);
		expect(jsonl).toContain('"truncated":true');
		expect(jsonl).not.toContain('"content":"P00_METADATA_PIPELINE_SENTINEL');
	});

	test("storeless security chain persists only the normalized/redacted result to JSONL and next context", async () => {
		const previousHygiene = process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE;
		process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE = "1";
		try {
			const secret = `github_pat_${"R".repeat(32)}`;
			const duplicate = `api_key=${secret}\n${"persisted-result ".repeat(24)}`;
			const stages: Array<{ stage: string; event: any }> = [];
			const enricher = extension("persist-enricher", [async (event) => {
				stages.push({ stage: "enrich", event: structuredClone(event) });
				return { details: { ...(event.details as any), diagnostic: `api_key=${secret}` } };
			}]);
			const downstreamObserver = extension("persist-downstream-no-dcp", [async (event) => {
				stages.push({ stage: "downstream", event: structuredClone(event) });
				return undefined;
			}]);
			const harness = await createHeadlessToolHarness({
				toolName: "read",
				toolCallArgs: {},
				extensions: [
					enricher,
					contextGatewayExtension("observe"),
					truncationMetadataNormalizerExtension(),
					downstreamObserver,
					credentialFirewallExtension(),
				],
				tool: {
					name: "read",
					label: "Storeless security contract tool",
					description: "Return one synthetic duplicated result with a synthetic token",
					parameters: Type.Object({}),
					async execute() {
						return {
							content: [{ type: "text", text: `${duplicate}\nvisible suffix` }],
							details: {
								truncation: {
									content: duplicate,
									truncated: true,
									truncatedBy: "bytes",
									totalLines: 100,
									totalBytes: 20_000,
									outputLines: 50,
									outputBytes: 4_000,
									lastLinePartial: false,
									firstLineExceedsLimit: false,
									maxLines: 50,
									maxBytes: 4_000,
								},
							},
						};
					},
				},
			});

			await harness.session.prompt("run the storeless security contract tool", { expandPromptTemplates: false });

			expect(stages.map((entry) => entry.stage)).toEqual(["enrich", "downstream"]);
			const downstream = stages[1]!.event;
			expect(downstream.details.truncation.content).toBeUndefined();
			expect(JSON.stringify(downstream)).toContain(secret);

			expect(harness.contexts).toHaveLength(2);
			const secondContext = JSON.stringify(harness.contexts[1]);
			expect(secondContext).not.toContain(secret);
			expect(secondContext).toContain("<SECRET:");
			expect(secondContext).toContain('"truncated":true');
			expect(secondContext).not.toContain('"content":"api_key=');

			const sessionFile = harness.sessionManager.getSessionFile();
			expect(sessionFile).toBeTruthy();
			const jsonl = readFileSync(sessionFile!, "utf8");
			expect(jsonl).not.toContain(secret);
			expect(jsonl).toContain("<SECRET:");
			expect(jsonl).toContain('"truncated":true');
			expect(jsonl).not.toContain('"content":"api_key=');
		} finally {
			if (previousHygiene === undefined) delete process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE;
			else process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE = previousHygiene;
		}
	});

	test("storeless result order preserves outcome/images/usage while firewall redacts after observe and normalization", async () => {
		const previousHygiene = process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE;
		process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE = "1";
		try {
			const secret = `gho_${"S".repeat(36)}`;
			const duplicate = `prefix-${secret}-${"x".repeat(2_000)}`;
			const image = { type: "image", data: "AAAA", mimeType: "image/png" };
			const usage = {
				input: 11,
				output: 12,
				cacheRead: 13,
				cacheWrite: 14,
				totalTokens: 50,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const stages: Array<{ stage: string; event: any }> = [];
			const enricher = extension("result-enricher", [async (event) => {
				stages.push({ stage: "enrich", event: structuredClone(event) });
				return { details: { ...(event.details as any), diagnostic: `diagnostic ${secret}` } };
			}]);
			const downstreamObserver = extension("downstream-observer-no-dcp", [async (event) => {
				stages.push({ stage: "downstream", event: structuredClone(event) });
				return undefined;
			}]);
			const runner = createRunner([
				enricher,
				contextGatewayExtension("observe"),
				truncationMetadataNormalizerExtension(),
				downstreamObserver,
				credentialFirewallExtension(),
			]);
			const original = toolResult({
				toolCallId: "storeless-security-call",
				toolName: "Read",
				content: [
					{ type: "text", text: duplicate },
					image,
					{ type: "text", text: "\nvisible suffix" },
				] as any,
				details: {
					truncation: {
						content: duplicate,
						truncated: true,
						truncatedBy: "bytes",
						totalLines: 100,
						totalBytes: 20_000,
						outputLines: 50,
						outputBytes: 4_000,
						lastLinePartial: false,
						firstLineExceedsLimit: false,
						maxLines: 50,
						maxBytes: 4_000,
					},
					fullOutputPath: "/tmp/native-handle-kept",
				},
				isError: true,
				usage,
			});
			const originalClone = structuredClone(original);
			const result = await runner.emitToolResult(original);

			expect(stages.map((entry) => entry.stage)).toEqual(["enrich", "downstream"]);
			const downstream = stages.find((entry) => entry.stage === "downstream")!.event;
			expect(downstream.toolCallId).toBe("storeless-security-call");
			expect(downstream.details.truncation.content).toBeUndefined();
			expect(downstream.details.diagnostic).toContain(secret);
			expect(JSON.stringify(downstream.content)).toContain(secret);

			expect(result?.isError).toBe(true);
			expect(result?.usage).toEqual(usage);
			expect((result?.content as any[]).find((part) => part.type === "image")).toEqual(image);
			expect(JSON.stringify(result?.content)).not.toContain(secret);
			expect(JSON.stringify(result?.details)).not.toContain(secret);
			expect((result?.details as any).truncation.content).toBeUndefined();
			expect((result?.details as any).truncation).toMatchObject({
				truncated: true,
				truncatedBy: "bytes",
				totalLines: 100,
				maxBytes: 4_000,
			});
			expect((result?.details as any).fullOutputPath).toBe("/tmp/native-handle-kept");
			expect(original).toEqual(originalClone);
		} finally {
			if (previousHygiene === undefined) delete process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE;
			else process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE = previousHygiene;
		}
	});

	test("firewall-off keeps visible content while normalizer still removes only duplicate metadata", async () => {
		const previousHygiene = process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE;
		process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE = "0";
		try {
			const secret = `gho_${"T".repeat(36)}`;
			const duplicate = `prefix-${secret}-${"y".repeat(2_000)}`;
			const runner = createRunner([truncationMetadataNormalizerExtension(), credentialFirewallExtension()]);
			const result = await runner.emitToolResult(toolResult({
				toolName: "read",
				content: [{ type: "text", text: duplicate }] as any,
				details: {
					truncation: {
						content: duplicate,
						truncated: true,
						truncatedBy: "bytes",
						totalLines: 100,
						totalBytes: 20_000,
						outputLines: 50,
						outputBytes: 4_000,
						lastLinePartial: false,
						firstLineExceedsLimit: false,
						maxLines: 50,
						maxBytes: 4_000,
					},
				},
			}));
			expect(JSON.stringify(result?.content)).toContain(secret);
			expect((result?.details as any).truncation.content).toBeUndefined();
		} finally {
			if (previousHygiene === undefined) delete process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE;
			else process.env.PI_SECRET_FIREWALL_SESSION_HYGIENE = previousHygiene;
		}
	});

	test("provider firewall runs before the final Codex sanitizer without restoring secrets or invalid fields", async () => {
		const secret = `glpat-${"P".repeat(32)}`;
		const runner = createRunner([credentialFirewallExtension(), codexReasoningFixExtension()]);
		(runner as any).getModel = () => ({ provider: "openai-codex", id: "gpt-5.6-sol" });
		const payload = {
			model: "openai-codex/gpt-5.6-sol",
			prompt_cache_retention: "24h",
			input: [
				{ type: "message", role: "user", content: `token ${secret}` },
				{ type: "reasoning", content: "spurious-content", summary: [] },
			],
		};
		const sanitized = await runner.emitBeforeProviderRequest(payload) as any;
		expect(JSON.stringify(sanitized)).not.toContain(secret);
		expect(sanitized.prompt_cache_retention).toBeUndefined();
		expect(sanitized.input[0].content).toContain("<SECRET:gitlab_token:1>");
		expect(sanitized.input[1].content).toBeUndefined();
		expect(sanitized.input[1].summary).toEqual([]);
	});
});
