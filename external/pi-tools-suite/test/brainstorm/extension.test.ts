import { expect, test } from "bun:test";
import register from "../../src/brainstorm/index.js";

function fixture() {
	const tools = new Map<string, any>(), commands = new Map<string, any>(), messages: string[] = [];
	register({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), sendUserMessage: (text: string) => messages.push(text) } as any);
	return { tool: tools.get("brainstorm"), command: commands.get("brainstorm"), messages };
}

test("registration is lazy and exposes only a model-orchestrated tool", () => {
	const f = fixture();
	expect(f.tool.exposure).toBe("model-only");
	expect(f.messages).toHaveLength(0);
	expect(f.tool.description).toContain("explicitly requested");
});

test("command queues one council request, preserving dissent without implementation", async () => {
	const f = fixture(); let idle = false;
	await f.command.handler("Design storage", { waitForIdle: async () => { idle = true; } });
	expect(idle).toBe(true);
	expect(f.messages).toHaveLength(1);
	expect(f.messages[0]).toContain("Design storage");
	expect(f.messages[0]).toContain("unresolved disagreements/minority views");
	expect(f.messages[0]).toContain("Do not invent consensus or begin implementation");
	expect(f.messages[0]).toContain("Ask the user only about material uncertainty");
	expect(f.messages[0]).toContain("without a mandatory approval round");
	expect(f.messages[0]).toContain("action='review'");
	expect(f.messages[0]).toContain("revisionNotes");
});

test("empty command gives usage without paid work", async () => {
	const f = fixture(); const notices: string[] = [];
	await f.command.handler("  ", { ui: { notify: (text: string) => notices.push(text) } });
	expect(notices[0]).toContain("five paid rounds");
	expect(f.messages).toHaveLength(0);
});

test("missing run/finalize parameters and unavailable subagents fail without writes", async () => {
	const { tool } = fixture();
	await expect(tool.execute("id", { action: "finalize" }, undefined, undefined, {})).rejects.toThrow("runDir and proposal");
	await expect(tool.execute("id", { action: "run" }, undefined, undefined, {})).rejects.toThrow("topic");
	await expect(tool.execute("id", { action: "review" }, undefined, undefined, {})).rejects.toThrow("runDir and proposal");
	await expect(tool.execute("id", { action: "run", topic: "test" }, undefined, undefined, {})).rejects.toThrow("brief");
	await expect(tool.execute("id", { action: "run", topic: "test", brief: "goals", mode: "brainstorm" }, undefined, undefined, { tools: [] })).rejects.toThrow("active async-subagents");
});

test("command routing is contextual, transparent and respects explicit overrides", async () => {
	for (const [args, mode, topic] of [["Проверь GDD", "auto", "Проверь GDD"], ["--mode audit Проверь GDD", "audit", "Проверь GDD"], ["--mode=brainstorm Развей идею", "brainstorm", "Развей идею"], ["--mode auto Plan", "auto", "Plan"]]) {
		const f = fixture();
		await f.command.handler(args, { waitForIdle: async () => {} });
		expect(f.messages[0]).toContain(`Requested mode: ${mode}.`);
		expect(f.messages[0]).toContain(JSON.stringify(topic));
		expect(f.messages[0]).toContain("not keyword matching");
		expect(f.messages[0]).toContain("For mixed requests ask");
		expect(f.messages[0]).toContain("explicit --mode overrides inference");
		expect(f.messages[0]).toContain("Announce the selected mode");
		expect(f.messages[0]).toContain("material is missing or inaccessible");
	}
});

test("invalid or empty mode commands never queue council work", async () => {
	for (const args of ["--mode", "--mode invalid Topic", "--mode audit --mode brainstorm Topic", "--mode audit", "--unknown Topic"]) {
		const f = fixture(); const notices: string[] = [];
		await f.command.handler(args, { ui: { notify: (text: string) => notices.push(text) }, waitForIdle: async () => { throw new Error("must not queue"); } });
		expect(f.messages).toHaveLength(0);
		expect(notices).toHaveLength(1);
	}
});

test("tool rejects unresolved mode and continuation overrides before preflight or writes", async () => {
	const { tool } = fixture();
	for (const mode of [undefined, "auto", "invalid", null]) {
		await expect(tool.execute("id", { action: "run", topic: "test", brief: "goals", mode }, undefined, undefined, {})).rejects.toThrow("Run mode");
	}
	for (const action of ["review", "finalize"]) {
		await expect(tool.execute("id", { action, mode: "audit", runDir: "/irrelevant", proposal: "draft", revisionNotes: "none" }, undefined, undefined, {})).rejects.toThrow("Mode is fixed");
	}
});
