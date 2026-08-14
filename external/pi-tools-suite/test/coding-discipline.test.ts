import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAiMock } from "./support/pi-ai-mock.js";
import { createTypeboxMock } from "./support/typebox-mock.js";

const completeMock = mock(async () => ({
	message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() },
	stopReason: "stop",
}));

function installBaseMocks(): void {
	const piAiMock = createPiAiMock({
			Type: {
				Object: (properties: any, options?: any) => ({ kind: "object", properties, options }),
				Optional: (schema: any) => ({ kind: "optional", schema }),
				String: (options?: any) => ({ kind: "string", options }),
				Array: (items: any, options?: any) => ({ kind: "array", items, options }),
				Number: (options?: any) => ({ kind: "number", options }),
				Boolean: (options?: any) => ({ kind: "boolean", options }),
				Record: (key: any, value: any, options?: any) => ({ kind: "record", key, value, options }),
				Unknown: (options?: any) => ({ kind: "unknown", options }),
			},
			complete: completeMock,
		});
	mock.module("@earendil-works/pi-ai", () => piAiMock);
	mock.module("@earendil-works/pi-ai/compat", () => piAiMock);
	mock.module("typebox", () => createTypeboxMock());
}

class FakePi {
	tools = new Map<string, any>();
	handlers = new Map<string, any>();
	activeTools: string[] = ["read", "lookup", "custom"];
	setCalls: string[][] = [];
	thinkingLevel = "off";
	thinkingCalls: string[] = [];
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	on(name: string, handler: any) { this.handlers.set(name, handler); }
	getActiveTools() { return this.activeTools; }
	setActiveTools(tools: string[]) { this.setCalls.push(tools); this.activeTools = tools; }
	getThinkingLevel() { return this.thinkingLevel; }
	setThinkingLevel(level: string) { this.thinkingLevel = level; this.thinkingCalls.push(level); }
	async emit(name: string, event: any, ctx: any) { return await this.handlers.get(name)?.(event, ctx); }
}

installBaseMocks();

const tempDirs: string[] = [];
const originalPiConfigDir = process.env.PI_CONFIG_DIR;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "coding-discipline-"));
	tempDirs.push(dir);
	return dir;
}

function setPiConfigDirConfig(body: string): string {
	const configDir = tempDir();
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "pi-tools-suite.jsonc"), body);
	process.env.PI_CONFIG_DIR = configDir;
	return configDir;
}

afterEach(() => {
	mock.clearAllMocks();
	if (originalPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalPiConfigDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("coding discipline", () => {
	test("recognizes GLM-5.3 without a version-specific branch", async () => {
		const { isGlmModel } = await import("../src/coding-discipline/index.js");

		expect(isGlmModel("zai/glm-5.3")).toBe(true);
		expect(isGlmModel("glm-5.3")).toBe(true);
		expect(isGlmModel("anthropic/claude-sonnet-4")).toBe(false);
	});

	test("patches GLM-5.3 thinking metadata and sends the selected reasoning effort", async () => {
		setPiConfigDirConfig(`{ "lookupModel": null }`);
		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		pi.thinkingLevel = "medium";
		register(pi as any);

		const model = {
			provider: "zai",
			id: "glm-5.3",
			reasoning: true,
			compat: { thinkingFormat: "zai", supportsReasoningEffort: false },
		};
		const ctx = {
			cwd: "/tmp/project",
			model,
			thinkingLevel: "medium",
			modelRegistry: { getAll: () => [model] },
		};

		await pi.emit("session_start", {}, ctx);
		expect(pi.thinkingLevel).toBe("high");
		expect(pi.thinkingCalls).toEqual(["high"]);
		expect((model as any).thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(model.compat.supportsReasoningEffort).toBe(true);

		const result = await pi.emit(
			"before_provider_request",
			{ payload: { system: "base prompt", model: "glm-5.3", thinking: { type: "disabled" } } },
			{ ...ctx, thinkingLevel: "high" },
		);
		expect(result.reasoning_effort).toBe("high");
		expect(result.thinking).toEqual({ type: "enabled", clear_thinking: false });
	});

	test("keeps lookup active only for GLM models", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		expect(pi.tools.has("lookup")).toBe(true);

		await pi.emit("session_start", {}, { cwd: "/tmp/project", model: { provider: "anthropic", id: "claude-sonnet-4" } });
		expect(pi.activeTools).toEqual(["read", "custom"]);

		await pi.emit("model_select", { model: { provider: "zai", id: "glm-4.5" } }, { cwd: "/tmp/project" });
		expect(pi.activeTools).toEqual(["read", "custom", "lookup"]);

		await pi.emit("model_select", { model: { provider: "openai", id: "gpt-5" } }, { cwd: "/tmp/project" });
		expect(pi.activeTools).toEqual(["read", "custom"]);
	});

	test("does not register lookup when lookupModel is disabled", async () => {
		setPiConfigDirConfig(`{ "lookupModel": null }`);

		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);
		expect(pi.tools.has("lookup")).toBe(false);
	});

	test("does not inject discipline into non-GLM main-agent requests", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const result = await pi.emit(
			"before_provider_request",
			{ payload: { system: "base prompt", model: "anthropic/claude-sonnet-4" } },
			{ cwd: "/tmp/project", model: { provider: "anthropic", id: "claude-sonnet-4" } },
		);

		expect(result).toBeUndefined();
	});

	test("deduplicates the injected discipline block across repeated provider requests", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		const {
			default: register,
			buildCodingDisciplinePrompt,
		} = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const first = await pi.emit(
			"before_provider_request",
			{ payload: { system: "base prompt", model: "zai/glm-5.2" } },
			{ cwd: "/tmp/project", model: { provider: "zai", id: "glm-5.2" } },
		);
		const second = await pi.emit(
			"before_provider_request",
			{ payload: first },
			{ cwd: "/tmp/project", model: { provider: "zai", id: "glm-5.2" } },
		);

		expect(first).toEqual({
			system: `${buildCodingDisciplinePrompt({ lookupEnabled: true })}\n\nbase prompt`,
			model: "zai/glm-5.2",
		});
		expect(second).toEqual(first);
		expect((second.system.match(/<glm_coding_discipline>/g) ?? []).length).toBe(1);
	});

	test("strips pi's built-in Pi documentation block from the system prompt", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		const {
			default: register,
			buildCodingDisciplinePrompt,
		} = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const piPrompt = [
			"You are an expert coding assistant operating inside pi.",
			"",
			"Guidelines:",
			"- Be concise",
			"",
			"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
			"- Main documentation: /path/to/README.md",
			"- Additional docs: /path/to/docs",
			"- Examples: /path/to/examples (extensions, custom tools, SDK)",
			"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
			"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
			"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
			"",
			"<available_skills>",
			"</available_skills>",
			"",
			"Current date: 2026-01-01",
		].join("\n");

		const result = await pi.emit(
			"before_provider_request",
			{ payload: { system: piPrompt, model: "zai/glm-5.2" } },
			{ cwd: "/tmp/project", model: { provider: "zai", id: "glm-5.2" } },
		);

		const system = result.system as string;
		expect(system.startsWith(buildCodingDisciplinePrompt({ lookupEnabled: true }))).toBe(true);
		expect(system).not.toContain("Pi documentation");
		expect(system).not.toContain("tui.md for TUI API details");
		expect(system).toContain("<available_skills>");
		expect(system).toContain("Current date: 2026-01-01");
		expect(system).toContain("Guidelines:");
		// No more than two consecutive newlines after stripping the block.
		expect(/\n{3,}/.test(system)).toBe(false);
	});

	test("injects <available_skills> when pi-core's gate failed and skills are loaded", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		// Core registered the read tool as PascalCase "Read" (Claude alias),
		// so tools.includes("read") is false and pi-core skips the block.
		const result = await pi.emit(
			"before_agent_start",
			{
				systemPrompt: "You are an expert coding assistant.\n\nCurrent date: 2026-01-01",
				systemPromptOptions: {
					selectedTools: ["repo_search", "Read", "Bash"],
					skills: [
						{
							name: "skill-creator",
							description: "Author and edit pi Agent-Skills.",
							filePath: "/skills/skill-creator/SKILL.md",
							disableModelInvocation: false,
						},
						{
							name: "hidden-skill",
							description: "Should not appear.",
							filePath: "/skills/hidden/SKILL.md",
							disableModelInvocation: true,
						},
					],
				},
			},
			{ cwd: "/tmp/project" },
		);

		expect(result).toBeDefined();
		const system = result.systemPrompt as string;
		expect(system).toContain("<available_skills>");
		expect(system).toContain("<name>skill-creator</name>");
		expect(system).toContain("<location>/skills/skill-creator/SKILL.md</location>");
		expect(system).not.toContain("hidden-skill");
		expect(system).toContain("Current date: 2026-01-01");
		// Exactly one block (no duplicate).
		expect((system.match(/<available_skills>/g) ?? []).length).toBe(1);
	});

	test("does not re-inject <available_skills> when the block is already present", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const existing = [
			"You are an expert coding assistant.",
			"",
			"<available_skills>",
			"  <skill>",
			"    <name>already-here</name>",
			"  </skill>",
			"</available_skills>",
		].join("\n");

		const result = await pi.emit(
			"before_agent_start",
			{
				systemPrompt: existing,
				systemPromptOptions: {
					selectedTools: ["Read"],
					skills: [{ name: "other-skill", description: "x", filePath: "/x/SKILL.md" }],
				},
			},
			{ cwd: "/tmp/project" },
		);

		// Idempotent: block already present -> no modification.
		expect(result).toBeUndefined();
	});

	test("does not inject <available_skills> when no skills are loaded", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const result = await pi.emit(
			"before_agent_start",
			{
				systemPrompt: "You are an expert coding assistant.\n\nCurrent date: 2026-01-01",
				systemPromptOptions: { selectedTools: ["Read"], skills: [] },
			},
			{ cwd: "/tmp/project" },
		);

		expect(result).toBeUndefined();
	});
});

describe("coding discipline strictness", () => {
	function assistantToolCallText(text: string): unknown {
		return {
			role: "assistant",
			content: [
				{ type: "text", text },
				{ type: "toolCall", toolName: "read", input: {} },
			],
		};
	}

	function assistantToolCallThinking(text: string): unknown {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", text: "reasoning" },
				{ type: "text", text },
				{ type: "toolCall", toolName: "read", input: {} },
			],
		};
	}

	function userTurn(text: string): unknown {
		return { role: "user", content: [{ type: "text", text }] };
	}

	// `count` alternating user/assistant turns; every assistant turn is chatty.
	function chattyTurns(withThinking: boolean, count = 5): unknown[] {
		const messages: unknown[] = [];
		for (let i = 0; i < count; i++) {
			messages.push(userTurn(`turn ${i}`));
			messages.push(withThinking ? assistantToolCallThinking(`nav ${i}`) : assistantToolCallText(`nav ${i}`));
		}
		return messages;
	}

	function lastMessage(result: unknown): unknown {
		const messages = (result as { messages: unknown[] }).messages;
		return messages[messages.length - 1];
	}

	const glmCtx = { cwd: "/tmp/project", model: { provider: "zai", id: "glm-5.2" } };

	test("lenient ignores reasoning text when no thinking block is present", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "zai/glm-5.2", "codingDisciplineStrictness": "lenient" }`);
		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const result = await pi.emit("context", { messages: chattyTurns(false) }, glmCtx);
		expect(result).toBeUndefined();
	});

	test("strict flags reasoning text and injects a developer-role reminder", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "zai/glm-5.2", "codingDisciplineStrictness": "strict" }`);
		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const result = await pi.emit("context", { messages: chattyTurns(false) }, glmCtx);
		expect(result).toBeDefined();
		const reminder = lastMessage(result) as {
			role: string;
			content: { type: string; text: string }[];
		};
		expect(reminder.role).toBe("developer");
		expect(reminder.content[0].text).toContain("silence reminder");
	});

	test("lenient still flags chatter when a thinking block is present", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "zai/glm-5.2", "codingDisciplineStrictness": "lenient" }`);
		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const result = await pi.emit("context", { messages: chattyTurns(true) }, glmCtx);
		expect(result).toBeDefined();
		const reminder = lastMessage(result) as { role: string };
		expect(reminder.role).toBe("developer");
	});

	test("resets the chatter baseline after compaction truncates the history", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "zai/glm-5.2", "codingDisciplineStrictness": "strict" }`);
		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		// Long history: 10 chatty strict turns -> reminder fires, peak baseline grows to 20.
		const before = await pi.emit("context", { messages: chattyTurns(false, 10) }, glmCtx);
		expect(before).toBeDefined();

		// Compaction: history shrinks to 2 chatty turns (4 messages). Without a baseline
		// reset the stale violation peak (10) would suppress this; the reset lets it fire.
		const after = await pi.emit("context", { messages: chattyTurns(false, 2) }, glmCtx);
		expect(after).toBeDefined();
		const reminder = lastMessage(after) as { role: string };
		expect(reminder.role).toBe("developer");
	});

	test("buildCodingDisciplinePrompt differs between lenient and strict", async () => {
		const { buildCodingDisciplinePrompt } = await import("../src/coding-discipline/index.js");
		const lenient = buildCodingDisciplinePrompt({ lookupEnabled: true });
		const strict = buildCodingDisciplinePrompt({ lookupEnabled: true, strictness: "strict" });
		expect(lenient).toContain("Batch independent calls");
		expect(lenient).toContain("thinking/reasoning channel is available");
		expect(lenient).not.toContain("emit exactly one tool call with empty text");
		expect(lenient).toContain("Treat the current GLM coding endpoint as text-only");
		expect(strict).toContain("emit exactly one tool call with empty text");
		expect(strict).toContain("No transition permits commentary between tool calls");
		expect(strict).not.toContain("Batch independent calls");
	});

	test("strictness config flows into the injected system prompt", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "zai/glm-5.2", "codingDisciplineStrictness": "strict" }`);
		const { default: register } = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const result = await pi.emit(
			"before_provider_request",
			{ payload: { system: "base prompt", model: "zai/glm-5.2" } },
			glmCtx,
		);
		expect((result as { system: string }).system).toContain("emit exactly one tool call with empty text");
	});
});
