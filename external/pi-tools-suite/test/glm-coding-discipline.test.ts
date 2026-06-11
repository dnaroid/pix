import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = mock(async () => ({
	message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() },
	stopReason: "stop",
}));

function installBaseMocks(): void {
	mock.module("@earendil-works/pi-ai", () => ({ complete: completeMock }));
	mock.module("typebox", () => ({
		Type: {
			Object: (properties: any, options?: any) => ({ kind: "object", properties, options }),
			Optional: (schema: any) => ({ kind: "optional", schema }),
			String: (options?: any) => ({ kind: "string", options }),
			Array: (items: any, options?: any) => ({ kind: "array", items, options }),
			Number: (options?: any) => ({ kind: "number", options }),
			Boolean: (options?: any) => ({ kind: "boolean", options }),
		},
	}));
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
	const dir = mkdtempSync(join(tmpdir(), "glm-coding-discipline-"));
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

describe("glm coding discipline", () => {
	test("keeps lookup active only for GLM models", async () => {
		setPiConfigDirConfig(`{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		const { default: register } = await import("../src/glm-coding-discipline/index.js");
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

		const { default: register } = await import("../src/glm-coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);
		expect(pi.tools.has("lookup")).toBe(false);
	});
});
