import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentState } from "../../src/async-subagents/lib.js";

mock.module("@mariozechner/pi-tui", () => ({
	Container: class Container {
		children: any[] = [];
		addChild(child: any) { this.children.push(child); }
	},
	Text: class Text {
		constructor(public text: string, public x = 0, public y = 0) {}
		toString() { return this.text; }
	},
	visibleWidth: (text: string) => text.replace(/<[^>]+>/g, "").length,
	truncateToWidth: (text: string, width: number, ellipsis = "…") => {
		const visible = text.replace(/<[^>]+>/g, "");
		if (visible.length <= width) return text;
		if (width <= ellipsis.length) return ellipsis.slice(0, Math.max(0, width));
		return visible.slice(0, width - ellipsis.length) + ellipsis;
	},
}));

const tempDirs: string[] = [];
const originalAsyncSubagentsEnableSessions = process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS;
const originalAsyncSubagentsActivePresetFile = process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE;
const originalAsyncSubagentsConfig = process.env.ASYNC_SUBAGENTS_CONFIG;

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagents-ui-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeFile(filePath: string, content = ""): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function createAgent(runDir: string, id: string, files: Record<string, string> = {}): void {
	writeFile(path.join(runDir, id, "prompt.md"), `prompt for ${id}`);
	for (const [name, content] of Object.entries(files)) writeFile(path.join(runDir, id, name), content);
}

function theme() {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `**${text}**`,
	};
}

afterEach(() => {
	if (originalAsyncSubagentsEnableSessions === undefined) delete process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS;
	else process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS = originalAsyncSubagentsEnableSessions;
	if (originalAsyncSubagentsActivePresetFile === undefined) delete process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE;
	else process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE = originalAsyncSubagentsActivePresetFile;
	if (originalAsyncSubagentsConfig === undefined) delete process.env.ASYNC_SUBAGENTS_CONFIG;
	else process.env.ASYNC_SUBAGENTS_CONFIG = originalAsyncSubagentsConfig;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.serial("format helpers", () => {
	test.serial("formats statuses, labels, glyphs, pluralization, and truncation", async () => {
		const { formatAgentStatus, plural, statusGlyph, statusLabel, truncate } = await import("../../src/async-subagents/format.js");
		expect(formatAgentStatus("done")).toBe("[done]");
		expect(formatAgentStatus("custom")).toBe("[custom]");
		expect(truncate("short", 10)).toBe("short");
		expect(truncate("abcdefghij", 7)).toBe("abcd...");
		expect(plural(1, "agent")).toBe("1 agent");
		expect(plural(2, "agent")).toBe("2 agents");
		expect(plural(2, "entry", "entries")).toBe("2 entries");
		expect(statusGlyph("planned")).toBe("○");
		expect(statusGlyph("running")).toBe("◐");
		expect(statusGlyph("done")).toBe("✓");
		expect(statusGlyph("failed")).toBe("✕");
		expect(statusGlyph("stopped")).toBe("■");
		expect(statusLabel("running")).toBe("in progress");
		expect(statusLabel("done")).toBe("done");
	});
});

describe.serial("task normalization", () => {
	test.serial("validates task arrays and normalizes optional fields", async () => {
		const { normalizeAgentTasks, toTaskPreviews } = await import("../../src/async-subagents/tasks.js");
		expect(normalizeAgentTasks(undefined)).toEqual({ error: "spawn requires at least one task in the tasks array." });
		expect(normalizeAgentTasks([])).toEqual({ error: "spawn requires at least one task in the tasks array." });
		expect(normalizeAgentTasks(["bad"])).toEqual({ error: "Task 1 must be an object." });
		expect(normalizeAgentTasks([{}])).toEqual({ error: "Task 1 is missing a non-empty task description." });
		expect(normalizeAgentTasks([{ id: "dup", task: "a" }, { id: "dup", task: "b" }])).toEqual({ error: 'Duplicate agent ID: "dup". Each agent must have a unique ID.' });
		expect(normalizeAgentTasks([{ id: "../bad", task: "a" }]).error).toContain("Invalid tasks[0].id");

		const normalized = normalizeAgentTasks([
			{ id: "agent-1", task: "  first task  ", scope: " src ", subagentType: " scan ", model: " fast/model ", thinking: " off ", promptAppend: " extra instructions ", promptOverride: " custom prompt ", tools: ["read", "", 1, "grep"], extraArgs: ["--x", "", 2], parentObjective: " objective " },
			{ task: "second task" },
			{ id: "agent-4", task: "fourth task" },
			{ task: "generated skips reserved ids" },
		]);
		expect(normalized.error).toBeUndefined();
		expect(normalized.tasks).toEqual([
			{ id: "agent-1", task: "first task", scope: "src", subagentType: "scan", model: "fast/model", thinking: "off", promptAppend: "extra instructions", promptOverride: "custom prompt", tools: ["read", "grep"], extraArgs: ["--x"], parentObjective: "objective" },
			{ id: "agent-2", task: "second task" },
			{ id: "agent-4", task: "fourth task" },
			{ id: "agent-3", task: "generated skips reserved ids" },
		]);

		const previews = toTaskPreviews([{ id: "a", task: "x".repeat(100), scope: "s".repeat(100) }]);
		expect(previews[0].task).toHaveLength(100);
		expect(previews[0].task?.endsWith("...")).toBe(false);
		expect(previews[0].scope).toHaveLength(80);
	});
});

describe.serial("live run tracking", () => {
	test.serial("creates and reuses a per-run live map", async () => {
		const { getLiveRun } = await import("../../src/async-subagents/live.js");
		const liveAgents = new Map();
		const first = getLiveRun(liveAgents, "/run/one");
		const second = getLiveRun(liveAgents, "/run/one");
		expect(first).toBe(second);
		expect(liveAgents.get("/run/one")).toBe(first);
	});

	test.serial("prunes completed live agents without rendering UI", async () => {
		const { SubagentOverlay } = await import("../../src/async-subagents/subagent-overlay.js");
		const runDir = tempDir();
		createAgent(runDir, "running", {
			pid: String(process.pid),
			started_at: new Date(Date.now() - 1_000).toISOString(),
		});
		createAgent(runDir, "done", { exit_code: "0" });

		const liveAgents = new Map<string, Map<string, any>>([
			[runDir, new Map([
				["running", {
					runDir,
					agentId: "running",
					preview: { id: "running", task: "Investigate async widget", model: "provider/fast-model" },
					completed: Promise.resolve(),
				}],
				["done", { runDir, agentId: "done", completed: Promise.resolve() }],
			])],
		]);

		const overlay = new SubagentOverlay(liveAgents as any);
		overlay.update();

		expect(liveAgents.get(runDir)?.has("running")).toBe(true);
		expect(liveAgents.get(runDir)?.has("done")).toBe(false);

		writeFile(path.join(runDir, "running", "exit_code"), "0");
		overlay.update();
		expect(liveAgents.has(runDir)).toBe(false);
		overlay.dispose();
	});

	test.serial("keeps queued live agents until they become running", async () => {
		const { SubagentOverlay } = await import("../../src/async-subagents/subagent-overlay.js");
		const runDir = tempDir();
		createAgent(runDir, "sleeper-1", {
			pid: String(process.pid),
			started_at: new Date(Date.now() - 1_000).toISOString(),
		});
		createAgent(runDir, "sleeper-2");
		createAgent(runDir, "sleeper-3");

		const liveRun = new Map<string, any>(["sleeper-1", "sleeper-2", "sleeper-3"].map((id) => [id, {
			runDir,
			agentId: id,
			preview: { id, task: `sleep task ${id}` },
			completed: Promise.resolve(),
		}]));
		const liveAgents = new Map([[runDir, liveRun]]);
		const overlay = new SubagentOverlay(liveAgents as any);

		overlay.update();
		expect(liveRun.size).toBe(3);

		for (const id of ["sleeper-2", "sleeper-3"]) {
			writeFile(path.join(runDir, id, "pid"), String(process.pid));
			writeFile(path.join(runDir, id, "started_at"), new Date(Date.now() - 500).toISOString());
		}
		overlay.update();
		expect(liveRun.size).toBe(3);
		overlay.dispose();
	});
});

describe.serial("rendering", () => {
	test.serial("renders compact, expanded, and plain run summaries", async () => {
		const { renderPlainRunSummary, renderSubagentRun, renderSubagentSpawnPrompts } = await import("../../src/async-subagents/render.js");
		const agents: AgentState[] = [
			{ id: "done", status: "done", exitCode: 0, resultLines: 2, startedAt: "2024-01-01T00:00:00Z", finishedAt: "2024-01-01T00:00:02Z" },
			{ id: "failed", status: "failed", exitCode: 1, stderrLines: 1 },
			{ id: "stopped", status: "stopped" },
			{ id: "running", status: "running", pid: 123, eventLines: 4, startedAt: new Date(Date.now() - 1500).toISOString() },
			{ id: "planned", status: "planned" },
			{ id: "extra-1", status: "planned" },
			{ id: "extra-2", status: "planned" },
		];
		const details = { runDir: "/tmp/run", agents, tasks: [{ id: "done", task: "Inspect a very long task description".repeat(4), scope: "src/core" }], mode: "spawn" as const };

		const compact = (renderSubagentRun(details, { expanded: false }, theme() as any) as any).render(80).join("\n");
		expect(compact).toContain("Started 7 subagents");
		expect(compact).toContain("+1 more");
		expect(compact).toContain("ctrl+o to expand");

		const expanded = (renderSubagentRun(details, { expanded: true }, theme() as any) as any).render(160).join("\n");
		expect(expanded).toContain("exit 0");
		expect(expanded).toContain("scope src/core");
		expect(expanded).toContain("pid 123");
		expect(expanded).toContain("run /tmp/run");

		expect(renderPlainRunSummary({ runDir: "/tmp/run", agents: agents.slice(0, 3), mode: "wait" })).toBe([
			"Ran 3 subagents, tracked 1 run",
			"✓ Completed done -> done · 2 output lines",
			"✕ Failed failed -> failed · 1 output line",
			"■ Stopped stopped -> stopped",
		].join("\n"));

		const spawnPromptDetails = {
			runDir: "/tmp/run",
			agents,
			mode: "spawn" as const,
			tasks: agents.map((agent, index) => ({ id: agent.id, task: `Prompt for ${agent.id} with extra detail ${index}`, model: index === 0 ? "provider/fast-model" : undefined })),
		};
		const spawnCompactLines = (renderSubagentSpawnPrompts(spawnPromptDetails, { expanded: false }, theme() as any) as any).render(120);
		expect(spawnCompactLines.join("\n")).toContain("Started 7 subagents");
		expect(spawnCompactLines.join("\n")).toContain("Prompt for done");
		expect(spawnCompactLines.join("\n")).toContain("+3 more prompts");
		expect(spawnCompactLines).toHaveLength(6);

		const spawnExpanded = (renderSubagentSpawnPrompts(spawnPromptDetails, { expanded: true }, theme() as any) as any).render(120).join("\n");
		expect(spawnExpanded).toContain("Prompt for extra-2");
	});

	test.serial("public subagents spawn renders a concise launch message", async () => {
		const { registerSubagentsTool } = await import("../../src/async-subagents/tools/subagents.js");
		const registered = new Map<string, any>();
		registerSubagentsTool({ registerTool: (tool: any) => registered.set(tool.name, tool) } as any, new Map(), () => {});

		const tool = registered.get("subagents");
		const agents: AgentState[] = [
			{ id: "test-agent-1", status: "done", exitCode: 0, resultLines: 35 },
			{ id: "test-agent-2", status: "done", exitCode: 0, resultLines: 20 },
		];
		const details = {
			runDir: "/tmp/run",
			agents,
			mode: "spawn" as const,
			tasks: [
				{ id: "test-agent-1", task: "Probe the compact spawn renderer" },
				{ id: "test-agent-2", task: "Verify the prompt body" },
			],
		};
		const rendered = tool.renderResult(
			{ content: [{ type: "text", text: "Started 2 subagents\nthis fallback should not render" }], details },
			{ expanded: false },
			theme(),
		).render(80).join("\n");

		expect(rendered).toContain("Started 2 subagents");
		expect(rendered).toContain("test-agent-1:");
		expect(rendered).toContain("Probe the compact spawn renderer");
		expect(rendered).not.toContain("35 output lines");
		expect(rendered).not.toContain("this fallback should not render");
	});

	test.serial("truncates every rendered line to the supplied width", async () => {
		const { renderSubagentRun } = await import("../../src/async-subagents/render.js");
		const agents: AgentState[] = [
			{ id: "agent-with-a-very-long-id", status: "running", pid: 12345, eventLines: 554, startedAt: new Date(Date.now() - 68_000).toISOString() },
		];
		const details = {
			runDir: "/Volumes/128GBSSD/Projects/ai-mobile-game-idea-generator/.pi/subagents/2026-05-18T12-50-52-cloud-shepherds-config",
			agents,
			tasks: [{
				id: "agent-with-a-very-long-id",
				task: "CRITICAL: All code must be valid TypeScript that compiles with strict mode and moduleResolution 'Bundler'. No external imports except 'phaser'. Local imports only between the 3 source files.",
				scope: "src/".repeat(80),
			}],
			mode: "spawn" as const,
		};

		const width = 80;
		const lines = (renderSubagentRun(details, { expanded: true }, theme() as any) as any).render(width);
		for (const line of lines) {
			expect(line.replace(/<[^>]+>/g, "").length).toBeLessThanOrEqual(width);
		}
	});
});

describe.serial("polling", () => {
	test.serial("clamps watch seconds", async () => {
		const { clampWatchSeconds } = await import("../../src/async-subagents/polling.js");
		expect(clampWatchSeconds(undefined, 12)).toBe(12);
		expect(clampWatchSeconds(-1)).toBe(0);
		expect(clampWatchSeconds(999)).toBe(300);
		expect(clampWatchSeconds(Number.NaN, 7)).toBe(7);
	});

	test.serial("emits updates and returns when a run is terminal, timed out, or aborted", async () => {
		const { pollRunWithUpdates } = await import("../../src/async-subagents/polling.js");
		const runDir = tempDir();
		createAgent(runDir, "done", { exit_code: "0" });
		const updates: any[] = [];
		const state = await pollRunWithUpdates(runDir, undefined, {
			mode: "status",
			timeoutSeconds: 10,
			onUpdate: (update) => updates.push(update),
		});
		expect(state.agents).toContainEqual(expect.objectContaining({ id: "done", status: "done" }));
		expect(updates).toHaveLength(1);
		expect(updates[0].content[0].text).toContain("Checked 1 subagent");

		const runningRun = tempDir();
		createAgent(runningRun, "running", { pid: String(process.pid) });
		expect((await pollRunWithUpdates(runningRun, undefined, { mode: "wait", timeoutSeconds: 0 })).agents[0].status).toBe("running");

		const abortRun = tempDir();
		createAgent(abortRun, "running", { pid: String(process.pid) });
		const controller = new AbortController();
		controller.abort();
		expect((await pollRunWithUpdates(abortRun, undefined, { mode: "wait", timeoutSeconds: 10, signal: controller.signal })).agents[0].status).toBe("running");

		const abortDuringSleepRun = tempDir();
		createAgent(abortDuringSleepRun, "running", { pid: String(process.pid) });
		const sleepingController = new AbortController();
		setTimeout(() => sleepingController.abort(), 10);
		expect((await pollRunWithUpdates(abortDuringSleepRun, undefined, {
			mode: "wait",
			timeoutSeconds: 1,
			intervalSeconds: 10,
			signal: sleepingController.signal,
		})).agents[0].status).toBe("running");
	});
});

describe.serial("slash command registration", () => {
	test.serial("selects config-defined sub-agent presets without editing config", async () => {
		const { loadSubagentPresetSelection } = await import("../../src/async-subagents/core/presets.js");
		const { registerCommands } = await import("../../src/async-subagents/commands.js");
		const registered = new Map<string, any>();
		const pi = { registerCommand: (name: string, command: any) => { registered.set(name, command); } };
		registerCommands(pi as any);

		const cwd = tempDir();
		process.env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE = path.join(cwd, "active-preset.json");
		process.env.ASYNC_SUBAGENTS_CONFIG = path.join(cwd, "async-subagents.jsonc");
		writeFile(process.env.ASYNC_SUBAGENTS_CONFIG, `{
			"presets": {
				"fast": { "description": "cheap", "model": "zai/fast", "thinking": "off" },
				"deep": { "model": "openai/deep", "thinking": "high", "extraArgs": ["--temperature", "0"] }
			},
			"types": {}
		}`);

		const notifications: any[] = [];
		const selections: string[][] = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				notify: (...args: any[]) => notifications.push(args),
				select: async (_title: string, options: string[]) => {
					selections.push(options);
					return options.find((option) => option.startsWith("fast —"));
				},
			},
		};

		await registered.get("subagent-preset-config").handler("", ctx);
		expect(selections[0]).toEqual(expect.arrayContaining([expect.stringContaining("fast — cheap"), expect.stringContaining("deep — model:openai/deep")]));
		expect(loadSubagentPresetSelection().activePreset).toBe("fast");
		expect(notifications.pop()[0]).toContain('Active sub-agent preset "fast"');

		await registered.get("subagent-preset").handler("clear", ctx);
		expect(loadSubagentPresetSelection().activePreset).toBeUndefined();
	});

	test.serial("registers /sub-status and reports usage, empty runs, and agent status", async () => {
		const { registerCommands } = await import("../../src/async-subagents/commands.js");
		delete process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS;
		const registered = new Map<string, any>();
		const pi = { registerCommand: (name: string, command: any) => { registered.set(name, command); } };
		registerCommands(pi as any);
		expect([...registered.keys()]).toEqual(["subagent-preset", "subagent-preset-config", "ultrawork", "ulw", "hyperplan", "sub-status", "sub-stop"]);
		const command = registered.get("sub-status");

		const cwd = tempDir();
		const notifications: any[] = [];
		const ctx = { cwd, hasUI: true, ui: { notify: (...args: any[]) => notifications.push(args) } };
		await command.handler("", ctx);
		expect(notifications.pop()).toEqual(["Usage: /sub-status [run-dir]", "warning"]);

		await command.handler("missing", ctx);
		expect(notifications.pop()[0]).toContain("No agents found");

		const runDir = path.join(cwd, "run");
		createAgent(runDir, "agent-1", { exit_code: "0" });
		await command.handler("run", ctx);
		expect(notifications.pop()).toEqual(["[done] agent-1", "info"]);

		await command.handler("run", { ...ctx, hasUI: false });
		expect(notifications).toHaveLength(0);
	});

	test.serial("opens sub-agent sessions, reports location, and returns", async () => {
		const { registerCommands } = await import("../../src/async-subagents/commands.js");
		process.env.ASYNC_SUBAGENTS_ENABLE_SESSIONS = "1";
		const registered = new Map<string, any>();
		const pi = { registerCommand: (name: string, command: any) => { registered.set(name, command); } };
		registerCommands(pi as any);
		expect([...registered.keys()]).toEqual(["subagent-preset", "subagent-preset-config", "ultrawork", "ulw", "hyperplan", "sub-status", "sub-open", "sub-back", "sub-where", "sub-stop"]);

		const cwd = tempDir();
		const parentSession = path.join(cwd, "parent.jsonl");
		writeFile(parentSession, "{}");
		const runDir = path.join(cwd, ".pi", "subagents", "2026-run");
		createAgent(runDir, "agent-1", { exit_code: "0" });
		const subSession = path.join(runDir, "agent-1", "sessions", "sub.jsonl");
		writeFile(subSession, "{}");
		writeFile(path.join(runDir, "agent-1", "session_file"), subSession);
		writeFile(path.join(runDir, "agent-1", "parent_session"), parentSession);

		let currentSession = parentSession;
		const notifications: any[] = [];
		const switches: string[] = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (...args: any[]) => notifications.push(args), select: async () => undefined },
			sessionManager: { getSessionFile: () => currentSession },
			switchSession: async (sessionPath: string, options?: any) => {
				switches.push(sessionPath);
				currentSession = sessionPath;
				await options?.withSession?.({ ui: { notify: (...args: any[]) => notifications.push(args) } });
				return { cancelled: false };
			},
		};

		await registered.get("sub-open").handler(`${runDir} agent-1`, ctx);
		expect(switches).toEqual([subSession]);
		expect(fs.readFileSync(path.join(runDir, "agent-1", "return_session"), "utf-8")).toBe(parentSession);
		expect(notifications.pop()[0]).toContain("Opened sub-agent agent-1");

		await registered.get("sub-where").handler("", ctx);
		expect(notifications.pop()[0]).toContain("Sub-agent session: agent-1");

		await registered.get("sub-back").handler("", ctx);
		expect(switches).toEqual([subSession, parentSession]);
		expect(notifications.pop()[0]).toContain("Returned from sub-agent agent-1");
	});
});
