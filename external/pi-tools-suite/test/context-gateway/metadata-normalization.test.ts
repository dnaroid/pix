import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { stream as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions";

import { SessionManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { createBashToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js";
import { createReadToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { registerAstGrepTool } from "../../src/ast-grep/tool.js";
import dcpModule from "../../src/dcp/index.js";
import { loadConfig as loadDcpConfig } from "../../src/dcp/config.js";
import { createState as createDcpState } from "../../src/dcp/state.js";
import { normalizeRedundantTruncationMetadata } from "../../src/context-gateway/metadata-normalization.js";
import truncationMetadataNormalizer from "../../src/truncation-metadata-normalizer/index.js";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function withoutTruncationContent(details: unknown): unknown {
	return normalizeRedundantTruncationMetadata(toolResultMessage(details)).details;
}

function toolResultMessage(details: unknown) {
	const duplicate = `CG_METADATA_DUPLICATE_SENTINEL:${"x".repeat(24_000)}`;
	return {
		role: "toolResult",
		toolCallId: "metadata-normalization-call",
		toolName: "read",
		content: [{ type: "text", text: `${duplicate}\n[Showing lines 1-400 of 2300. Use offset=401 to continue.]` }],
		details,
		isError: false,
		timestamp: 1,
	} as any;
}

function assistantToolCallMessage() {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "metadata-normalization-call", name: "read", arguments: {} }],
		api: "openai-completions",
		provider: "openai",
		model: "metadata-normalization-openai",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	} as any;
}

function rawDetails() {
	return {
		truncation: {
			content: `CG_METADATA_DUPLICATE_SENTINEL:${"x".repeat(24_000)}`,
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 2_300,
			totalBytes: 140_000,
			outputLines: 400,
			outputBytes: 24_000,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines: 2_000,
			maxBytes: 51_200,
		},
	};
}

function createOpenAiModel() {
	return {
		id: "metadata-normalization-openai",
		name: "Metadata normalization OpenAI",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	} as any;
}

async function captureProviderPayload(details: unknown): Promise<unknown> {
	const model = createOpenAiModel();
	let capturedPayload: unknown;
	const response = streamOpenAiCompletions(model, {
		systemPrompt: "",
		messages: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "metadata-normalization-call", name: "read", arguments: {} }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 1,
			},
			toolResultMessage(details),
		],
		tools: [],
	} as any, {
		apiKey: "metadata-normalization-offline-key",
		maxRetries: 0,
		onPayload(payload) {
			capturedPayload = structuredClone(payload);
			throw new Error("STOP_AFTER_METADATA_NORMALIZATION_SERIALIZATION");
		},
	});
	const finalMessage = await response.result();
	if (finalMessage.stopReason !== "error") throw new Error("provider serialization probe did not stop at onPayload");
	return capturedPayload;
}

describe("context gateway non-store experiment: truncation metadata normalization", () => {
	test("opt-in module returns only a details patch for a proven duplicate", async () => {
		const handlers = new Map<string, any[]>();
		truncationMetadataNormalizer({
			on(name: string, handler: any) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
		} as any);
		const message = toolResultMessage(rawDetails());
		const patch = await handlers.get("tool_result")![0]({ ...message, type: "tool_result" }, {});

		expect(patch).toEqual({ details: expect.any(Object) });
		expect(patch.content).toBeUndefined();
		expect(patch.isError).toBeUndefined();
		expect(patch.details.truncation.content).toBeUndefined();
		expect(patch.details.truncation.truncated).toBe(true);
	});

	test("normalizes only a proven duplicate and leaves ambiguous custom metadata untouched", () => {
		const details = rawDetails();
		const normalized = normalizeRedundantTruncationMetadata(toolResultMessage(details));
		expect(normalized.changed).toBe(true);
		expect(normalized.removedBytes).toBeGreaterThan(20_000);
		expect((normalized.details as any).truncation.content).toBeUndefined();
		expect((details as any).truncation.content).toContain("CG_METADATA_DUPLICATE_SENTINEL");

		const ambiguous = normalizeRedundantTruncationMetadata({
			toolName: "custom_tool",
			content: [{ type: "text", text: "different visible result" }],
			details: {
				truncation: {
					truncated: true,
					content: "different visible result",
					truncatedBy: "bytes",
					totalLines: 10,
					totalBytes: 100,
					outputLines: 5,
					outputBytes: 50,
					lastLinePartial: false,
					firstLineExceedsLimit: false,
					maxLines: 5,
					maxBytes: 50,
				},
			},
		});
		expect(ambiguous.changed).toBe(false);
		expect((ambiguous.details as any).truncation.content).toBe("different visible result");

		const malformedKnownTool = normalizeRedundantTruncationMetadata({
			toolName: "Read",
			content: [{ type: "text", text: "visible" }],
			details: { truncation: { truncated: true, content: "visible" } },
		});
		expect(malformedKnownTool.changed).toBe(false);

		const emptyKnownTool = normalizeRedundantTruncationMetadata({
			toolName: "Read",
			content: [],
			details: rawDetails(),
		});
		expect(emptyKnownTool.changed).toBe(false);

		const mismatchedKnownTool = normalizeRedundantTruncationMetadata({
			toolName: "Read",
			content: [{ type: "text", text: "different delivered prefix" }],
			details: rawDetails(),
		});
		expect(mismatchedKnownTool.changed).toBe(false);

		for (const toolName of ["bash", "shell", "shell_command"]) {
			const alias = normalizeRedundantTruncationMetadata({ ...toolResultMessage(rawDetails()), toolName });
			expect(alias.changed).toBe(true);
			expect((alias.details as any).truncation.content).toBeUndefined();
		}
	});

	test("treats a same-name replacement as duplicate cleanup only, not as trusted provenance", () => {
		const duplicate = "override-duplicate-prefix";
		const details = {
			truncation: {
				content: duplicate,
				truncated: true,
				truncatedBy: "bytes",
				totalLines: 100,
				totalBytes: 10_000,
				outputLines: 20,
				outputBytes: 1_000,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines: 20,
				maxBytes: 1_000,
			},
			customOwner: "replacement-extension",
			customSemanticField: "must-survive",
		};
		const normalized = normalizeRedundantTruncationMetadata({
			toolName: "Read",
			content: [{ type: "text", text: `${duplicate}\nvisible` }],
			details,
		});

		expect(normalized.changed).toBe(true);
		expect((normalized.details as any).truncation.content).toBeUndefined();
		expect((normalized.details as any).customOwner).toBe("replacement-extension");
		expect((normalized.details as any).customSemanticField).toBe("must-survive");
		expect(details.truncation.content).toBe(duplicate);
	});

	test("is idempotent and preserves Unicode multipart/image content and the original objects", () => {
		const duplicate = "αβγ🙂-duplicate-prefix";
		const details = {
			truncation: {
				content: duplicate,
				truncated: true,
				truncatedBy: "bytes",
				totalLines: 20,
				totalBytes: 2_000,
				outputLines: 10,
				outputBytes: 1_000,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines: 10,
				maxBytes: 1_000,
			},
			fullOutputPath: "/tmp/kept-handle",
		};
		const content = [
			{ type: "text", text: duplicate },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "\ncontinuation" },
		];
		const originalDetails = structuredClone(details);
		const originalContent = structuredClone(content);

		const first = normalizeRedundantTruncationMetadata({ toolName: "Read", content, details });
		expect(first.changed).toBe(true);
		expect(first.removedBytes).toBe(new TextEncoder().encode(duplicate).byteLength);
		expect((first.details as any).truncation.content).toBeUndefined();
		expect((first.details as any).fullOutputPath).toBe("/tmp/kept-handle");
		expect(details).toEqual(originalDetails);
		expect(content).toEqual(originalContent);

		const second = normalizeRedundantTruncationMetadata({ toolName: "Read", content, details: first.details });
		expect(second.changed).toBe(false);
		expect(second.removedBytes).toBe(0);
		expect(second.details).toBe(first.details);
	});

	test("removing only details.truncation.content substantially reduces persisted JSONL duplication", () => {
		const details = rawDetails();
		const normalized = withoutTruncationContent(details);
		const rawRoot = mkdtempSync(join(tmpdir(), "context-gateway-metadata-raw-"));
		const normalizedRoot = mkdtempSync(join(tmpdir(), "context-gateway-metadata-normalized-"));
		const rawManager = SessionManager.create(rawRoot, join(rawRoot, "sessions"));
		const normalizedManager = SessionManager.create(normalizedRoot, join(normalizedRoot, "sessions"));

		rawManager.appendMessage(assistantToolCallMessage());
		rawManager.appendMessage(toolResultMessage(details));
		normalizedManager.appendMessage(assistantToolCallMessage());
		normalizedManager.appendMessage(toolResultMessage(normalized));

		const rawJsonl = readFileSync(rawManager.getSessionFile()!, "utf8");
		const normalizedJsonl = readFileSync(normalizedManager.getSessionFile()!, "utf8");
		const sentinel = "CG_METADATA_DUPLICATE_SENTINEL";
		expect(rawJsonl.split(sentinel).length - 1).toBe(2);
		expect(normalizedJsonl.split(sentinel).length - 1).toBe(1);
		expect(Buffer.byteLength(rawJsonl) - Buffer.byteLength(normalizedJsonl)).toBeGreaterThan(20_000);
		expect(normalizedJsonl).toContain('"truncated":true');
		expect(normalizedJsonl).toContain('"totalLines":2300');
		expect(normalizedJsonl).toContain('"maxBytes":51200');
	});

	test("the checked OpenAI-completions provider payload is byte-equivalent after metadata normalization", async () => {
		const details = rawDetails();
		const rawPayload = await captureProviderPayload(details);
		const normalizedPayload = await captureProviderPayload(withoutTruncationContent(details));

		expect(normalizedPayload).toEqual(rawPayload);
		expect(JSON.stringify(rawPayload).split("CG_METADATA_DUPLICATE_SENTINEL").length - 1).toBe(1);
	});

	test("DCP observes the same delivered text and normalized structural details", async () => {
		const config = loadDcpConfig({ homeDir: "/__context_gateway_metadata_dcp__" });
		config.enabled = true;
		config.debug = false;
		const state = createDcpState();
		const handlers = new Map<string, any[]>();
		const pi = {
			on(name: string, handler: any) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			appendEntry() {},
			sendMessage() {},
		};
		await dcpModule(pi as any, { config, state });

		const message = toolResultMessage(rawDetails());
		for (const handler of handlers.get("tool_call") ?? []) {
			await handler({ type: "tool_call", toolCallId: message.toolCallId, toolName: message.toolName, input: {} }, {});
		}
		const normalized = normalizeRedundantTruncationMetadata(message);
		for (const handler of handlers.get("tool_result") ?? []) {
			await handler({ ...message, details: normalized.details, type: "tool_result" }, {});
		}

		const record = state.toolCalls.get(message.toolCallId);
		expect(record?.outputText).toBe((message.content[0] as any).text);
		expect((record?.outputDetails as any).truncation.content).toBeUndefined();
		expect((record?.outputDetails as any).truncation).toMatchObject({
			truncated: true,
			totalLines: 2_300,
			maxBytes: 51_200,
		});
	});

	test("normalizes the installed SDK read and bash truncation shapes without changing delivered content", async () => {
		const source = Array.from({ length: 2_300 }, (_, index) => `line-${String(index).padStart(4, "0")}-${"z".repeat(48)}`).join("\n");
		const read = createReadToolDefinition(tmpdir(), {
			operations: {
				async access() {},
				async readFile() { return Buffer.from(source, "utf8"); },
				async detectImageMimeType() { return undefined; },
			},
		});
		const bash = createBashToolDefinition(tmpdir(), {
			exposeSessionEnvironment: false,
			operations: {
				async exec(_command, _cwd, options) {
					options.onData(Buffer.from(source, "utf8"));
					return { exitCode: 0 };
				},
			},
		});

		const readResult = await read.execute("read-normalize", { path: "large.txt" }, undefined, undefined, { cwd: tmpdir() } as any);
		const bashResult = await bash.execute("bash-normalize", { command: "emit large" }, undefined, undefined, { cwd: tmpdir() } as any);
		for (const [toolName, result] of [["read", readResult], ["bash", bashResult]] as const) {
			const visibleBefore = JSON.stringify(result.content);
			const normalization = normalizeRedundantTruncationMetadata({ ...result, toolName });
			expect(normalization.changed).toBe(true);
			expect(normalization.removedBytes).toBeGreaterThan(40_000);
			expect(JSON.stringify(result.content)).toBe(visibleBefore);
			expect((normalization.details as any).truncation.content).toBeUndefined();
			expect((normalization.details as any).truncation.truncated).toBe(true);
		}

		const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as any;
		const renderRead = (details: unknown, expanded: boolean) => {
			const component = read.renderResult!(
				{ ...readResult, details } as any,
				{ expanded, isPartial: false } as any,
				theme,
				{ args: { path: "large.txt" }, cwd: tmpdir(), showImages: false, isError: false, lastComponent: undefined } as any,
			) as any;
			return component.render(120);
		};
		const normalizedRead = normalizeRedundantTruncationMetadata({ toolName: "read", ...readResult });
		expect(renderRead(normalizedRead.details, false)).toEqual(renderRead(readResult.details, false));
		expect(renderRead(normalizedRead.details, true)).toEqual(renderRead(readResult.details, true));
	});

	test("normalizes the real suite ast_grep truncation shape and preserves its native full-output handle", async () => {
		const tools = new Map<string, any>();
		const source = Array.from({ length: 2_300 }, (_, index) => `src/file.ts:${index + 1}: helper(${index}) ${"q".repeat(48)}`).join("\n");
		registerAstGrepTool({
			registerTool(tool: any) { tools.set(tool.name, tool); },
			async exec() { return { stdout: source, stderr: "", code: 0, killed: false }; },
		} as any);
		const tool = tools.get("ast_grep");
		const result = await tool.execute(
			"ast-normalize",
			{ command: "run", pattern: "helper($A)", lang: "ts", paths: ["src"] },
			undefined,
			undefined,
			{ cwd: tmpdir() },
		);
		const fullOutputPath = result.details.fullOutputPath as string;
		try {
			expect(fullOutputPath).toBeTruthy();
			expect(result.details.truncation.content).toBeTruthy();
			const normalized = normalizeRedundantTruncationMetadata({ toolName: "ast_grep", ...result });
			expect(normalized.changed).toBe(true);
			expect((normalized.details as any).truncation.content).toBeUndefined();
			expect((normalized.details as any).fullOutputPath).toBe(fullOutputPath);
			expect(JSON.stringify(result.content)).toContain("Output truncated");

			const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as any;
			const renderAst = (details: unknown, expanded: boolean) => {
				const component = tool.renderResult!(
					{ ...result, details } as any,
					{ expanded, isPartial: false } as any,
					theme,
					{} as any,
				) as any;
				return component.render(120);
			};
			expect(renderAst(normalized.details, false)).toEqual(renderAst(result.details, false));
			expect(renderAst(normalized.details, true)).toEqual(renderAst(result.details, true));
		} finally {
			rmSync(fullOutputPath, { force: true });
			rmSync(join(fullOutputPath, ".."), { recursive: true, force: true });
		}
	});

	test("keeps installed Bash collapsed and expanded rendering equivalent after normalization", async () => {
		initTheme("dark", false);
		const source = Array.from({ length: 2_300 }, (_, index) => `render-${String(index).padStart(4, "0")}-${"v".repeat(48)}`).join("\n");
		const bash = createBashToolDefinition(tmpdir(), {
			exposeSessionEnvironment: false,
			operations: {
				async exec(_command, _cwd, options) {
					options.onData(Buffer.from(source, "utf8"));
					return { exitCode: 0 };
				},
			},
		});
		const result = await bash.execute("bash-render-normalize", { command: "emit large" }, undefined, undefined, { cwd: tmpdir() } as any);
		const normalized = normalizeRedundantTruncationMetadata({ toolName: "bash", ...result });
		expect(normalized.changed).toBe(true);

		const render = (details: unknown, expanded: boolean) => {
			const component = bash.renderResult!(
				{ ...result, details } as any,
				{ expanded, isPartial: false } as any,
				{} as any,
				{ state: {}, showImages: false, isError: false, invalidate() {}, lastComponent: undefined } as any,
			) as any;
			return component.render(120);
		};

		expect(render(normalized.details, false)).toEqual(render(result.details, false));
		expect(render(normalized.details, true)).toEqual(render(result.details, true));
	});

	test("keeps installed Read collapsed/expanded rendering equivalent after normalization", async () => {
		const source = Array.from({ length: 2_300 }, (_, index) => `read-render-${String(index).padStart(4, "0")}-${"u".repeat(48)}`).join("\n");
		const read = createReadToolDefinition(tmpdir(), {
			operations: {
				async access() {},
				async readFile() { return Buffer.from(source, "utf8"); },
				async detectImageMimeType() { return undefined; },
			},
		});
		const result = await read.execute("read-render-normalize", { path: "large.txt" }, undefined, undefined, { cwd: tmpdir() } as any);
		const normalized = normalizeRedundantTruncationMetadata({ toolName: "read", ...result });
		expect(normalized.changed).toBe(true);
		const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
		const render = (details: unknown, expanded: boolean) => {
			const component = read.renderResult!(
				{ ...result, details } as any,
				{ expanded, isPartial: false } as any,
				theme as any,
				{ args: { path: "large.txt" }, showImages: false, cwd: tmpdir(), isError: false, lastComponent: undefined } as any,
			) as any;
			return component.render(120);
		};
		expect(render(normalized.details, false)).toEqual(render(result.details, false));
		expect(render(normalized.details, true)).toEqual(render(result.details, true));
	});

	test("keeps suite ast_grep collapsed/expanded rendering equivalent after normalization", async () => {
		const tools = new Map<string, any>();
		const source = Array.from({ length: 2_300 }, (_, index) => `src/render.ts:${index + 1}: helper(${index}) ${"w".repeat(48)}`).join("\n");
		registerAstGrepTool({
			registerTool(tool: any) { tools.set(tool.name, tool); },
			async exec() { return { stdout: source, stderr: "", code: 0, killed: false }; },
		} as any);
		const tool = tools.get("ast_grep");
		const result = await tool.execute(
			"ast-render-normalize",
			{ command: "run", pattern: "helper($A)", lang: "ts", paths: ["src"] },
			undefined,
			undefined,
			{ cwd: tmpdir() },
		);
		const fullOutputPath = result.details.fullOutputPath as string;
		try {
			const normalized = normalizeRedundantTruncationMetadata({ toolName: "ast_grep", ...result });
			expect(normalized.changed).toBe(true);
			const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
			const render = (details: unknown, expanded: boolean) => {
				const component = tool.renderResult(
					{ ...result, details },
					{ expanded, isPartial: false },
					theme,
					{} as any,
				) as any;
				return component.render(120);
			};
			expect(render(normalized.details, false)).toEqual(render(result.details, false));
			expect(render(normalized.details, true)).toEqual(render(result.details, true));
		} finally {
			rmSync(join(fullOutputPath, ".."), { recursive: true, force: true });
		}
	});
});
