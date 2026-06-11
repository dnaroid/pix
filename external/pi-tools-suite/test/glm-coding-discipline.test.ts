import { describe, expect, mock, test } from "bun:test";

const completeMock = mock(async () => ({
	message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() },
	stopReason: "stop",
}));

const loadPiToolsSuiteConfigMock = mock((_modules?: unknown, _options?: unknown) => ({
	lookupModel: "openai-codex/gpt-5.4-mini",
}));

mock.module("@earendil-works/pi-ai", () => ({ complete: completeMock }));
mock.module("typebox", () => ({
	Type: {
		Object: (properties: any, options?: any) => ({ kind: "object", properties, options }),
		Optional: (schema: any) => ({ kind: "optional", schema }),
		String: (options?: any) => ({ kind: "string", options }),
		Array: (items: any, options?: any) => ({ kind: "array", items, options }),
	},
}));
mock.module("../src/config.js", () => ({ loadPiToolsSuiteConfig: loadPiToolsSuiteConfigMock }));

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

describe("glm coding discipline", () => {
	test("keeps lookup active only for GLM models", async () => {
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
		loadPiToolsSuiteConfigMock.mockImplementation(() => ({ lookupModel: undefined }));
		const { default: register } = await import("../src/glm-coding-discipline/index.js");
		const pi = new FakePi();
		register(pi as any);
		expect(pi.tools.has("lookup")).toBe(false);
		loadPiToolsSuiteConfigMock.mockImplementation((_modules?: unknown, _options?: unknown) => ({
			lookupModel: "openai-codex/gpt-5.4-mini",
		}));
	});
});
