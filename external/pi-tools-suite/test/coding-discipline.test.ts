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
	mock.module("@earendil-works/pi-ai", () =>
		createPiAiMock({
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
		}),
	);
	mock.module("typebox", () => createTypeboxMock());
}

class FakePi {
	tools = new Map<string, any>();
	handlers = new Map<string, any>();
	activeTools: string[] = ["read", "lookup", "custom"];
	setCalls: string[][] = [];
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	on(name: string, handler: any) { this.handlers.set(name, handler); }
	getActiveTools() { return this.activeTools; }
	setActiveTools(tools: string[]) { this.setCalls.push(tools); this.activeTools = tools; }
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

	test("injects discipline into non-GLM main-agent requests without enabling lookup guidance", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		const {
			default: register,
			buildCodingDisciplinePrompt,
		} = await import("../src/coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);

		const result = await pi.emit(
			"before_provider_request",
			{ payload: { system: "base prompt", model: "anthropic/claude-sonnet-4" } },
			{ cwd: "/tmp/project", model: { provider: "anthropic", id: "claude-sonnet-4" } },
		);

		expect(result).toEqual({
			system: `${buildCodingDisciplinePrompt()}\n\nbase prompt`,
			model: "anthropic/claude-sonnet-4",
		});
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
			{ payload: { system: "base prompt", model: "anthropic/claude-sonnet-4" } },
			{ cwd: "/tmp/project", model: { provider: "anthropic", id: "claude-sonnet-4" } },
		);
		const second = await pi.emit(
			"before_provider_request",
			{ payload: first },
			{ cwd: "/tmp/project", model: { provider: "anthropic", id: "claude-sonnet-4" } },
		);

		expect(first).toEqual({
			system: `${buildCodingDisciplinePrompt()}\n\nbase prompt`,
			model: "anthropic/claude-sonnet-4",
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
			{ payload: { system: piPrompt, model: "anthropic/claude-sonnet-4" } },
			{ cwd: "/tmp/project", model: { provider: "anthropic", id: "claude-sonnet-4" } },
		);

		const system = result.system as string;
		expect(system.startsWith(buildCodingDisciplinePrompt())).toBe(true);
		expect(system).not.toContain("Pi documentation");
		expect(system).not.toContain("tui.md for TUI API details");
		expect(system).toContain("<available_skills>");
		expect(system).toContain("Current date: 2026-01-01");
		expect(system).toContain("Guidelines:");
		// No more than two consecutive newlines after stripping the block.
		expect(/\n{3,}/.test(system)).toBe(false);
	});
});
