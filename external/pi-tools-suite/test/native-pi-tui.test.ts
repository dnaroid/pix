import { afterEach, describe, expect, test } from "bun:test";

import {
	PIX_HOST_RUNTIME_SYMBOL,
	isNativePiTui,
	isPixOwnedHost,
} from "../src/lib/native-pi-tui.js";
import {
	TODO_NATIVE_WIDGET_KEY,
	updateTodoNativeWidget,
} from "../src/todo/native-tui.js";
import {
	SUBAGENTS_NATIVE_WIDGET_KEY,
	updateSubagentsNativeWidget,
} from "../src/async-subagents/native-tui.js";
import type { SubagentsLiveStateEvent } from "../src/async-subagents/types.js";
import type { TaskState } from "../src/todo/state/state.js";
import {
	DCP_NATIVE_WIDGET_KEY,
	buildDcpCapacityMap,
	updateDcpNativeWidget,
} from "../src/dcp/native-tui.js";
import questionExtension from "../src/question/index.js";
import { QUESTION_NATIVE_WIDGET_KEY } from "../src/question/native-tui.js";

type WidgetFactory = (tui: unknown, theme: TestTheme) => { render(width: number): string[] };

interface TestTheme {
	fg(_color: string, text: string): string;
	bold(text: string): string;
}

const theme: TestTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const nativeQuestionTheme = {
	fg(color: string, text: string) {
		const supported = new Set(["accent", "success", "error", "warning", "muted", "dim", "text"]);
		if (!supported.has(color)) throw new Error("Unknown native Pi foreground color: " + color);
		return text;
	},
	bg(color: string, text: string) {
		if (color !== "selectedBg") throw new Error("Unknown native Pi background color: " + color);
		return text;
	},
	bold(text: string) {
		return text;
	},
};

const pixGlobal = globalThis as typeof globalThis & { [PIX_HOST_RUNTIME_SYMBOL]?: boolean };
const previousBridge = process.env.PIX_ACP_SESSION_STATE_BRIDGE;
const previousQuestionBridge = process.env.PIX_QUESTION_RPC_BRIDGE;
const previousProfile = process.env.PIX_CONFIG_PROFILE;

afterEach(() => {
	delete pixGlobal[PIX_HOST_RUNTIME_SYMBOL];
	if (previousBridge === undefined) delete process.env.PIX_ACP_SESSION_STATE_BRIDGE;
	else process.env.PIX_ACP_SESSION_STATE_BRIDGE = previousBridge;
	if (previousQuestionBridge === undefined) delete process.env.PIX_QUESTION_RPC_BRIDGE;
	else process.env.PIX_QUESTION_RPC_BRIDGE = previousQuestionBridge;
	if (previousProfile === undefined) delete process.env.PIX_CONFIG_PROFILE;
	else process.env.PIX_CONFIG_PROFILE = previousProfile;
});

describe.serial("native pi TUI host boundary", () => {
	test("accepts clean pi TUI and rejects Pix-owned hosts", () => {
		expect(isPixOwnedHost({}, globalThis as never)).toBe(false);
		expect(isNativePiTui({ mode: "tui", hasUI: true })).toBe(true);
		expect(isNativePiTui({ mode: "print", hasUI: false })).toBe(false);

		pixGlobal[PIX_HOST_RUNTIME_SYMBOL] = true;
		expect(isPixOwnedHost()).toBe(true);
		expect(isNativePiTui({ mode: "tui", hasUI: true })).toBe(false);

		delete pixGlobal[PIX_HOST_RUNTIME_SYMBOL];
		process.env.PIX_ACP_SESSION_STATE_BRIDGE = "1";
		expect(isNativePiTui({ mode: "tui", hasUI: true })).toBe(false);
	});

	test("does not register the clean-pi question tool in Pix", () => {
		let registrations = 0;
		const pi = { registerTool() { registrations++; } };

		questionExtension(pi as never);
		expect(registrations).toBe(1);

		pixGlobal[PIX_HOST_RUNTIME_SYMBOL] = true;
		questionExtension(pi as never);
		expect(registrations).toBe(1);
	});

	test("keeps the clean-pi questionnaire immediately above the composer", async () => {
		let registered: any;
		questionExtension({
			registerTool(tool: unknown) {
				registered = tool;
			},
		} as never);
		expect(registered?.name).toBe("question");

		const widgets = new Map<string, WidgetFactory | undefined>();
		const input = {} as {
			handler?: (data: string) => { consume?: boolean; data?: string } | undefined;
		};
		const ctx = createWidgetContext(widgets, { tokens: 40, contextWindow: 100 }, new Map(), input);
		updateTodoNativeWidget(ctx as never, {
			tasks: [{ id: 1, subject: "Keep plan visible", status: "pending" as const }],
			nextId: 2,
		});
		updateSubagentsNativeWidget(ctx as never, {
			version: 1,
			count: 1,
			runs: [{
				runDir: "/tmp/run",
				agents: [{ id: "research", status: "running" }],
				tasks: [{ id: "research", task: "Background research" }],
			}],
			checkedAt: Date.now(),
		});

		const execution = registered.execute(
			"question-call",
			{
				questions: [{
					id: "strategy",
					label: "Strategy",
					prompt: "Which strategy?",
					choices: [
						{ value: "safe", label: "Safe" },
						{ value: "fast", label: "Fast" },
					],
				}],
			},
			undefined,
			undefined,
			ctx as never,
		);

		expect([...widgets.keys()]).toEqual([
			TODO_NATIVE_WIDGET_KEY,
			SUBAGENTS_NATIVE_WIDGET_KEY,
			QUESTION_NATIVE_WIDGET_KEY,
		]);
		const questionFactory = widgets.get(QUESTION_NATIVE_WIDGET_KEY);
		expect(questionFactory).toBeFunction();
		const questionComponent = questionFactory!({ requestRender() {} }, nativeQuestionTheme);
		expect(questionComponent.render(80).join("\n")).toContain("Which strategy?");

		// A background subagent refresh must not slip below the active question.
		updateSubagentsNativeWidget(ctx as never, {
			version: 1,
			count: 1,
			runs: [{
				runDir: "/tmp/run",
				agents: [{ id: "research", status: "running", lastActivity: { label: "still working", at: new Date().toISOString() } }],
				tasks: [{ id: "research", task: "Background research" }],
			}],
			checkedAt: Date.now(),
		});
		expect([...widgets.keys()].at(-1)).toBe(QUESTION_NATIVE_WIDGET_KEY);
		expect(input.handler).toBeFunction();
		expect(input.handler!("\r")).toEqual({ consume: true });

		const result = await execution;
		expect(result.details.canceled).toBe(false);
		expect(result.details.answers[0]).toMatchObject({
			id: "strategy",
			value: "safe",
			label: "Safe",
		});
		expect(widgets.has(QUESTION_NATIVE_WIDGET_KEY)).toBe(false);
	});
});

describe.serial("native pi TUI widgets", () => {
	test("renders active todos and stays absent in Pix", () => {
		const widgets = new Map<string, WidgetFactory | undefined>();
		const ctx = createWidgetContext(widgets, { tokens: 40, contextWindow: 100 });
		const state = {
			tasks: [
				{ id: 1, subject: "Implement widgets", activeForm: "wiring TUI", status: "in_progress" as const },
				{ id: 2, subject: "Verify isolation", status: "pending" as const, blockedBy: [1] },
			],
			nextId: 3,
		};

		updateTodoNativeWidget(ctx as never, state);
		const factory = widgets.get(TODO_NATIVE_WIDGET_KEY);
		expect(factory).toBeFunction();
		expect(factory!({}, theme).render(100).join("\n")).toContain("Implement widgets");
		expect(factory!({}, theme).render(100).join("\n")).toContain("1 blocked");

		widgets.clear();
		pixGlobal[PIX_HOST_RUNTIME_SYMBOL] = true;
		updateTodoNativeWidget(ctx as never, state);
		expect(widgets.size).toBe(0);
	});

	test("renders live subagent activity only while agents are active", () => {
		const widgets = new Map<string, WidgetFactory | undefined>();
		const ctx = createWidgetContext(widgets, { tokens: 40, contextWindow: 100 });
		updateSubagentsNativeWidget(ctx as never, {
			version: 1,
			count: 2,
			runs: [{
				runDir: "/tmp/run",
				agents: [
					{ id: "research", status: "running", lastActivity: { label: "reading types", at: new Date().toISOString() } },
					{ id: "verify", status: "planned" },
				],
				tasks: [
					{ id: "research", task: "Audit native UI" },
					{ id: "verify", task: "Run tests" },
				],
			}],
			checkedAt: Date.now(),
		});
		const factory = widgets.get(SUBAGENTS_NATIVE_WIDGET_KEY);
		expect(factory).toBeFunction();
		const text = factory!({}, theme).render(100).join("\n");
		expect(text).toContain("1 running");
		expect(text).toContain("1 queued");
		expect(text).toContain("reading types");
	});

	test("renders todo and subagent widgets from their update snapshots", () => {
		const widgets = new Map<string, WidgetFactory | undefined>();
		const ctx = createWidgetContext(widgets, { tokens: 40, contextWindow: 100 });
		const todoState: TaskState = {
			tasks: [
				{ id: 1, subject: "Original task", activeForm: "working", status: "in_progress" },
				{ id: 2, subject: "Task 2", status: "pending" },
				{ id: 3, subject: "Task 3", status: "pending" },
				{ id: 4, subject: "Task 4", status: "pending" },
				{ id: 5, subject: "Task 5", status: "pending" },
				{ id: 6, subject: "Task 6", status: "pending" },
			],
			nextId: 7,
		};
		updateTodoNativeWidget(ctx as never, todoState);
		todoState.tasks[0]!.subject = "Mutated task";
		todoState.tasks.length = 0;
		const todoText = widgets.get(TODO_NATIVE_WIDGET_KEY)!({}, theme).render(100).join("\n");
		expect(todoText).toContain("Original task — working");
		expect(todoText).toContain("1 active · 5 pending");
		expect(todoText).toContain("… 1 more");

		const subagentState: SubagentsLiveStateEvent = {
			version: 1,
			count: 1,
			runs: [{
				runDir: "/tmp/run",
				agents: [{ id: "research", status: "running", lastActivity: { label: "original activity", at: new Date().toISOString() } }],
				tasks: [{ id: "research", task: "Original preview" }],
			}],
			checkedAt: Date.now(),
		};
		updateSubagentsNativeWidget(ctx as never, subagentState);
		subagentState.runs[0]!.agents[0]!.status = "planned";
		subagentState.runs.length = 0;
		const subagentText = widgets.get(SUBAGENTS_NATIVE_WIDGET_KEY)!({}, theme).render(100).join("\n");
		expect(subagentText).toContain("1 running");
		expect(subagentText).toContain("research · Original preview");
		expect(subagentText).toContain("original activity");
	});

	test("uses live context capacity and only classifies occupied tokens with DCP estimates", () => {
		const map = buildDcpCapacityMap(
			{ tokens: 40, contextWindow: 100 },
			{
				revision: 1,
				sessionEpoch: 0,
				generatedAt: 1,
				tokenEstimates: { retained: 10, candidate: 10, protected: 5, compressed: 5 },
			},
			10,
		);
		expect(map.occupiedTokens).toBe(40);
		expect(map.freeTokens).toBe(60);
		expect(map.occupiedPercent).toBe(40);
		expect(map.hasEstimates).toBe(true);
		expect(map.categoryTokens).toEqual({ retained: 20, candidate: 10, protected: 5, compressed: 5 });
		const freeShare = map.cells.flatMap((cell) => cell.segments)
			.filter((segment) => segment.kind === "free")
			.reduce((sum, segment) => sum + segment.share, 0);
		expect(freeShare).toBeCloseTo(6);

		const unknown = buildDcpCapacityMap(
			{ tokens: null, contextWindow: 100 },
			{
				revision: 1,
				sessionEpoch: 0,
				generatedAt: 1,
				tokenEstimates: { retained: 20, candidate: 20, protected: 0, compressed: 0 },
			},
			10,
		);
		expect(unknown.freeTokens).toBeUndefined();
		expect(unknown.cells.every((cell) => cell.segments[0]?.kind === "unknown")).toBe(true);
	});

	test("mounts DCP below the editor in clean pi but never in Pix", () => {
		const widgets = new Map<string, WidgetFactory | undefined>();
		const placements = new Map<string, unknown>();
		const ctx = createWidgetContext(widgets, { tokens: 42, contextWindow: 100 }, placements);
		updateDcpNativeWidget(ctx as never, 12, undefined);
		expect(widgets.get(DCP_NATIVE_WIDGET_KEY)).toBeFunction();
		expect(placements.get(DCP_NATIVE_WIDGET_KEY)).toEqual({ placement: "belowEditor" });
		expect(widgets.get(DCP_NATIVE_WIDGET_KEY)!({}, theme).render(100).join("\n")).toContain("42%");

		widgets.clear();
		pixGlobal[PIX_HOST_RUNTIME_SYMBOL] = true;
		updateDcpNativeWidget(ctx as never, 12, undefined);
		expect(widgets.size).toBe(0);
	});
});

function createWidgetContext(
	widgets: Map<string, WidgetFactory | undefined>,
	usage: { tokens: number | null; contextWindow: number },
	placements = new Map<string, unknown>(),
	input = {} as {
		handler?: (data: string) => { consume?: boolean; data?: string } | undefined;
	},
) {
	const sessionManager = {};
	return {
		mode: "tui",
		hasUI: true,
		sessionManager,
		getContextUsage: () => usage,
		ui: {
			setWidget(key: string, content: WidgetFactory | undefined, options?: unknown) {
				widgets.delete(key);
				if (content !== undefined) widgets.set(key, content);
				placements.set(key, options);
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
				input.handler = handler;
				return () => {
					if (input.handler === handler) input.handler = undefined;
				};
			},
		},
	};
}
