import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import brainstormExtension, { BRAINSTORM_SKILL_PATH } from "../../src/brainstorm/index.ts";
import councilGuard from "../../src/brainstorm/skill/council-guard.ts";

type Handler = (...args: any[]) => any;

function fakePi(tools: string[] = []) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const sent: Array<{ text: string; options: unknown }> = [];
	let active: string[] = [];
	const pi = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerCommand(name: string, command: { handler: Handler }) { commands.set(name, command); },
		registerTool() { throw new Error("the council must not register a tool"); },
		sendUserMessage(text: string, options: unknown) { sent.push({ text, options }); },
		getAllTools() { return tools.map((name) => ({ name })); },
		setActiveTools(names: string[]) { active = names; },
	};
	return { pi: pi as any, handlers, commands, sent, active: () => active };
}

describe("brainstorm skill module", () => {
	test("ships the skill through resources_discover", () => {
		const { pi, handlers } = fakePi();
		brainstormExtension(pi);
		const [discover] = handlers.get("resources_discover") ?? [];
		const result = discover!();
		expect(result.skillPaths).toEqual([BRAINSTORM_SKILL_PATH]);
		expect(existsSync(BRAINSTORM_SKILL_PATH)).toBe(true);
		const skill = readFileSync(BRAINSTORM_SKILL_PATH, "utf8");
		expect(skill).toMatch(/^---\nname: brainstorm\ndescription: .+\ndisable-model-invocation: true\n---\n/);
		expect(skill).toContain("scripts/council.mjs");
	});

	test("/brainstorm expands the skill with the raw request", async () => {
		const { pi, commands, sent } = fakePi();
		brainstormExtension(pi);
		const notes: string[] = [];
		const ctx = { waitForIdle: async () => {}, ui: { notify: (message: string) => notes.push(message) } };
		await commands.get("brainstorm")!.handler("   ", ctx);
		expect(sent).toHaveLength(0);
		expect(notes[0]).toContain("Usage: /brainstorm");
		await commands.get("brainstorm")!.handler(" --mode audit review docs/x.md ", ctx);
		expect(sent).toEqual([{ text: "/skill:brainstorm --mode audit review docs/x.md", options: { expandPromptTemplates: true } }]);
	});

	test("participant guard keeps only read-only tools", () => {
		const { pi, handlers, active } = fakePi(["read", "grep", "bash", "edit", "web_search", "project_search", "todo", "subagents"]);
		councilGuard(pi);
		handlers.get("session_start")![0]!();
		expect(active()).toEqual(["read", "grep", "web_search", "project_search", "todo"]);
		const [toolCall] = handlers.get("tool_call")!;
		expect(toolCall!({ toolName: "read" })).toBeUndefined();
		expect(toolCall!({ toolName: "Grep" })).toBeUndefined();
		expect(toolCall!({ toolName: "bash" })).toMatchObject({ block: true });
		expect(toolCall!({ toolName: "subagents" })).toMatchObject({ block: true });
	});
});
