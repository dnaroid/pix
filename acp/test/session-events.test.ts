import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	countChecklist,
	createSessionEventMonitor,
	MAX_TOUCHED_FILES,
	type PlanProgress,
	readPlanProgress,
	type SessionEvent,
	type SessionEventMonitorOptions,
	stalledAfterMs,
} from "../src/acp/session-events.js";

/** Manual clock and timers: nothing fires unless the test advances time. */
function fakeTime() {
	let current = 1_000;
	let nextId = 1;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => current,
		setTimer: (callback: () => void, ms: number) => {
			const id = nextId++;
			timers.set(id, { at: current + ms, callback });
			return id;
		},
		clearTimer: (handle: unknown) => { timers.delete(handle as number); },
		get pending() { return timers.size; },
		advance(ms: number) {
			const target = current + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				current = due[1].at;
				due[1].callback();
			}
			current = target;
		},
	};
}

function harness(overrides: Partial<SessionEventMonitorOptions> = {}) {
	const time = fakeTime();
	const events: SessionEvent[] = [];
	const reports: string[] = [];
	const monitor = createSessionEventMonitor({
		now: time.now,
		setTimer: time.setTimer,
		clearTimer: time.clearTimer,
		report: (message) => reports.push(message),
		...overrides,
	});
	const unsubscribe = monitor.subscribe((event) => events.push(event));
	return { time, events, reports, monitor, unsubscribe };
}

const MIN = 60_000;

test("countChecklist counts task items outside fenced code", () => {
	assert.deepEqual(countChecklist([
		"# Plan",
		"- [x] done",
		"- [ ] next",
		"  * [X] nested done",
		"1. [ ] numbered",
		"- [] not a task",
		"```md",
		"- [ ] example inside fence",
		"```",
		"~~~",
		"- [x] tilde fence",
		"~~~",
	].join("\n")), { completed: 2, total: 4 });
	assert.deepEqual(countChecklist("no tasks"), { completed: 0, total: 0 });
});

test("readPlanProgress returns null for a missing plan", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pix-session-events-"));
	mkdirSync(join(cwd, ".pi/plans"), { recursive: true });
	writeFileSync(join(cwd, ".pi/plans/a.md"), "- [x] a\n- [ ] b\n");
	assert.deepEqual(await readPlanProgress(cwd, ".pi/plans/a.md"), { completed: 1, total: 2 });
	assert.equal(await readPlanProgress(cwd, ".pi/plans/missing.md"), null);
});

test("stalledAfterMs clamps to 5–60 minutes with a 15 minute default", () => {
	assert.equal(stalledAfterMs(), 15 * MIN);
	assert.equal(stalledAfterMs(1), 5 * MIN);
	assert.equal(stalledAfterMs(600), 60 * MIN);
	assert.equal(stalledAfterMs(Number.NaN), 15 * MIN);
});

test("settled carries the stop reason and successful write/edit paths", () => {
	const { events, monitor } = harness();
	const cwd = resolve("/work/proj");
	const outsidePath = resolve("/elsewhere/x.ts");
	const observer = monitor.observe("s1", cwd);
	observer.event({ type: "agent_start" });
	observer.event({ type: "tool_execution_start", toolCallId: "t1", toolName: "Write", args: { file_path: "src/a.ts" } });
	observer.event({ type: "tool_execution_end", toolCallId: "t1", toolName: "Write", isError: false });
	observer.event({ type: "tool_execution_start", toolCallId: "t2", toolName: "edit", args: { path: join(cwd, "src/b.ts") } });
	observer.event({ type: "tool_execution_end", toolCallId: "t2", toolName: "edit", isError: true });
	observer.event({ type: "tool_execution_start", toolCallId: "t3", toolName: "read", args: { path: "src/c.ts" } });
	observer.event({ type: "tool_execution_end", toolCallId: "t3", toolName: "read", isError: false });
	observer.event({ type: "tool_execution_start", toolCallId: "t4", toolName: "edit", args: { path: outsidePath } });
	observer.event({ type: "tool_execution_end", toolCallId: "t4", toolName: "edit", isError: false });
	observer.settled("end_turn");
	assert.deepEqual(events.slice(0, -1), [
		{ type: "file_changed", sessionId: "s1", at: 1_000, path: "src/a.ts" },
		{ type: "file_changed", sessionId: "s1", at: 1_000, path: outsidePath },
	]);
	const settled = events.at(-1) as Extract<SessionEvent, { type: "settled" }>;
	assert.equal(settled.type, "settled");
	assert.equal(settled.sessionId, "s1");
	assert.equal(settled.stopReason, "end_turn");
	assert.deepEqual(settled.touchedFiles, ["src/a.ts", outsidePath]);
});

test("touched files survive runtime replacement until forget, and are bounded", () => {
	const { monitor } = harness();
	const first = monitor.observe("s1", "/p");
	for (let i = 0; i <= MAX_TOUCHED_FILES; i++) {
		first.event({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "write", args: { path: `f${i}` } });
		first.event({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "write", isError: false });
	}
	const second = monitor.observe("s1", "/p");
	second.event({ type: "tool_execution_start", toolCallId: "late", toolName: "write", args: { path: "f0" } });
	first.event({ type: "tool_execution_start", toolCallId: "stale", toolName: "write", args: { path: "stale" } });
	first.event({ type: "tool_execution_end", toolCallId: "stale", toolName: "write", isError: false });
	const files = monitor.touchedFiles("s1");
	assert.equal(files.length, MAX_TOUCHED_FILES);
	assert.equal(files.includes("f0"), false, "oldest dropped");
	assert.equal(files.includes("stale"), false, "a replaced observer records nothing");
	monitor.forget("s1");
	assert.deepEqual(monitor.touchedFiles("s1"), []);
});

test("question is emitted once per pending id and errors are classified", () => {
	const { events, monitor } = harness();
	const observer = monitor.observe("s1", "/p");
	observer.questionPending("q1");
	observer.questionPending("q1");
	observer.event({ type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error", errorMessage: "retrying" }] });
	observer.event({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: "overloaded" }] });
	observer.event({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop" }] });
	observer.event({ type: "compaction_end", result: undefined, aborted: false, willRetry: false, errorMessage: "too big" });
	observer.event({ type: "compaction_end", result: undefined, aborted: true, willRetry: false });
	observer.failed("process", "x".repeat(5_000));
	assert.deepEqual(events.map((event) => event.type === "error" ? `error:${event.source}` : event.type),
		["question", "error:model", "error:compaction", "error:process"]);
	assert.equal((events[1] as { message: string }).message, "overloaded");
	assert.equal((events[3] as { message: string }).message.length, 2_000);
});

test("stalled fires once after quiet time, excluding tool calls and questions", () => {
	const { time, events, monitor } = harness();
	const observer = monitor.observe("s1", "/p");
	observer.event({ type: "message_update" });
	time.advance(60 * MIN);
	assert.equal(events.length, 0, "an idle session never stalls");

	observer.event({ type: "agent_start" });
	time.advance(10 * MIN);
	observer.event({ type: "message_update" });
	time.advance(10 * MIN);
	assert.equal(events.length, 0, "activity postpones the deadline");
	time.advance(5 * MIN);
	assert.deepEqual(events.map(({ type }) => type), ["stalled"]);
	assert.equal((events[0] as { idleMs: number }).idleMs, 15 * MIN);
	time.advance(60 * MIN);
	assert.equal(events.length, 1, "notify once per quiet period");

	observer.event({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	time.advance(120 * MIN);
	assert.equal(events.length, 1, "time inside a tool call does not count");
	observer.event({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false });
	observer.questionPending("q1");
	time.advance(120 * MIN);
	assert.equal(events.filter(({ type }) => type === "stalled").length, 1, "waiting for the user is not stalled");
	observer.questionResolved("q1");
	time.advance(15 * MIN);
	assert.equal(events.filter(({ type }) => type === "stalled").length, 2);

	observer.event({ type: "message_update" });
	observer.settled("end_turn");
	assert.equal(time.pending, 0, "settlement disarms the timer");
});

test("stalled threshold follows the configured minutes", () => {
	const { time, events, monitor } = harness({ stalledAfterMinutes: 5 });
	const observer = monitor.observe("s1", "/p");
	observer.event({ type: "agent_start" });
	time.advance(5 * MIN - 1);
	assert.equal(events.length, 0);
	time.advance(1);
	assert.deepEqual(events.map(({ type }) => type), ["stalled"]);
});

test("checklist is emitted on first observation and on change only", async () => {
	const progress: Array<PlanProgress | null> = [{ completed: 0, total: 2 }, { completed: 0, total: 2 }, { completed: 1, total: 2 }, null];
	const plans = new Map([["s1", ".pi/plans/p.md"]]);
	const { events, monitor } = harness({
		planFor: async (_cwd, sessionId) => plans.get(sessionId),
		readPlanProgress: async () => progress.shift() ?? null,
	});
	const observer = monitor.observe("s1", "/p");
	const other = monitor.observe("s2", "/p");
	observer.settled("end_turn");
	other.settled("end_turn");
	await monitor.whenIdle();
	observer.settled("end_turn");
	await monitor.whenIdle();
	observer.event({ type: "tool_execution_start", toolCallId: "t", toolName: "edit", args: { path: ".pi/plans/p.md" } });
	observer.event({ type: "tool_execution_end", toolCallId: "t", toolName: "edit", isError: false });
	await monitor.whenIdle();
	observer.settled("end_turn");
	await monitor.whenIdle();
	const checklists = events.filter((event) => event.type === "checklist");
	assert.deepEqual(checklists.map((event) => [event.sessionId, event.progress]), [
		["s1", { completed: 0, total: 2 }],
		["s1", { completed: 1, total: 2 }],
		["s1", null],
	]);
});

test("dispose drops timers, pending checklist reads and later events", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const { time, events, reports, monitor } = harness({
		planFor: async () => { await gate; return ".pi/plans/p.md"; },
		readPlanProgress: async () => ({ completed: 1, total: 1 }),
	});
	const observer = monitor.observe("s1", "/p");
	observer.event({ type: "agent_start" });
	assert.equal(time.pending, 1);
	observer.settled("end_turn");
	observer.event({ type: "agent_start" });
	observer.dispose();
	assert.equal(time.pending, 0);
	release();
	await monitor.whenIdle();
	observer.settled("end_turn");
	observer.questionPending("q");
	observer.failed("run", "late");
	time.advance(60 * MIN);
	assert.deepEqual(events.map(({ type }) => type), ["settled"], "only the pre-dispose settlement");
	assert.deepEqual(reports, []);
});

test("unsubscribe and monitor dispose release listeners; listener throws are reported", () => {
	const { events, reports, monitor, unsubscribe } = harness();
	const throwing = monitor.subscribe(() => { throw new Error("boom"); });
	const observer = monitor.observe("s1", "/p");
	observer.settled("end_turn");
	assert.equal(events.length, 1);
	assert.deepEqual(reports, ["session event listener failed: boom"]);
	unsubscribe();
	throwing();
	observer.settled("cancelled");
	assert.equal(events.length, 1);
	monitor.dispose();
	const late = monitor.observe("s2", "/p");
	const lateEvents: SessionEvent[] = [];
	monitor.subscribe((event) => lateEvents.push(event));
	late.event({ type: "agent_start" });
	late.settled("end_turn");
	assert.deepEqual(lateEvents, []);
});

test("apply_patch records added, updated, deleted and both sides of moved files", () => {
	const { events, monitor } = harness();
	const observer = monitor.observe("s1", "/work/proj");
	const input = [
		"*** Begin Patch",
		"*** Add File: src/new.ts",
		"+export {};",
		"*** Update File: src/old.ts",
		"*** Move to: src/renamed.ts",
		"@@",
		"-a",
		"+b",
		"*** Update File: /work/proj/src/edited.ts",
		"@@",
		"-x",
		"+y",
		"*** Delete File: src/gone.ts",
		"*** End Patch",
	].join("\n");
	observer.event({ type: "tool_execution_start", toolCallId: "p1", toolName: "apply_patch", args: { input } });
	observer.event({ type: "tool_execution_end", toolCallId: "p1", toolName: "apply_patch", isError: false,
		result: { details: { changedFiles: ["src/new.ts", "src/renamed.ts", "src/edited.ts", "src/gone.ts"] } } });
	assert.deepEqual(monitor.touchedFiles("s1"),
		["src/new.ts", "src/old.ts", "src/renamed.ts", "src/edited.ts", "src/gone.ts"]);
	assert.deepEqual(events.filter((event) => event.type === "file_changed").length, 5, "one file_changed per file, no duplicates");
});

test("apply_patch with a unified diff, a failed call and a result-only path", () => {
	const { monitor } = harness();
	const observer = monitor.observe("s1", "/p");
	const unified = ["--- a/src/u.ts\t2026-01-01", "+++ b/src/u.ts", "@@ -1 +1 @@", "-a", "+b",
		"--- /dev/null", "+++ b/src/created.ts", "@@ -0,0 +1 @@", "+c"].join("\r\n");
	observer.event({ type: "tool_execution_start", toolCallId: "u", toolName: "apply_patch", args: { input: unified } });
	observer.event({ type: "tool_execution_end", toolCallId: "u", toolName: "apply_patch", isError: false });
	observer.event({ type: "tool_execution_start", toolCallId: "bad", toolName: "apply_patch",
		args: { input: "*** Begin Patch\n*** Update File: src/failed.ts\n*** End Patch" } });
	observer.event({ type: "tool_execution_end", toolCallId: "bad", toolName: "apply_patch", isError: true });
	observer.event({ type: "tool_execution_start", toolCallId: "r", toolName: "apply_patch", args: { input: "opaque" } });
	observer.event({ type: "tool_execution_end", toolCallId: "r", toolName: "apply_patch", isError: false,
		result: { details: { changedFiles: ["src/from-result.ts"] } } });
	assert.deepEqual(monitor.touchedFiles("s1"), ["src/u.ts", "src/created.ts", "src/from-result.ts"]);
});

test("apply_patch wrapped in a heredoc still yields its file headers", () => {
	const { monitor } = harness();
	const observer = monitor.observe("s1", "/p");
	const input = "<<'EOF'\n*** Begin Patch\n*** Update File: src/h.ts\n@@\n-a\n+b\n*** End Patch\nEOF";
	observer.event({ type: "tool_execution_start", toolCallId: "h", toolName: "apply_patch", args: { input } });
	observer.event({ type: "tool_execution_end", toolCallId: "h", toolName: "apply_patch", isError: false });
	assert.deepEqual(monitor.touchedFiles("s1"), ["src/h.ts"]);
});

test("nested codemode calls (parentToolCallId) are tracked like direct calls", () => {
	const { monitor } = harness();
	const observer = monitor.observe("s1", "/p");
	observer.event({ type: "tool_execution_start", toolCallId: "cm", toolName: "codemode", args: { code: "..." } });
	observer.event({ type: "tool_execution_start", toolCallId: "cm/1", toolName: "apply_patch", parentToolCallId: "cm",
		args: { input: "*** Begin Patch\n*** Add File: src/nested.ts\n+x\n*** End Patch" } });
	observer.event({ type: "tool_execution_end", toolCallId: "cm/1", toolName: "apply_patch", parentToolCallId: "cm", isError: false });
	observer.event({ type: "tool_execution_start", toolCallId: "cm/2", toolName: "Edit", parentToolCallId: "cm", args: { file_path: "src/e.ts" } });
	observer.event({ type: "tool_execution_end", toolCallId: "cm/2", toolName: "Edit", parentToolCallId: "cm", isError: false });
	observer.event({ type: "tool_execution_end", toolCallId: "cm", toolName: "codemode", isError: false });
	assert.deepEqual(monitor.touchedFiles("s1"), ["src/nested.ts", "src/e.ts"]);
});

test("unified diff hunk lines that look like file headers are not read as paths", () => {
	const { monitor } = harness();
	const observer = monitor.observe("s1", "/p");
	const input = [
		"--- a/src/real.ts", "+++ b/src/real.ts",
		"@@ -1,2 +1,2 @@",
		"--- not/a/header.ts",
		"+++ also/not.ts",
		" context",
		"\\ No newline at end of file",
		"--- a/src/second.ts", "+++ b/src/second.ts",
		"@@ -1 +1 @@", "-x", "+y",
	].join("\n");
	observer.event({ type: "tool_execution_start", toolCallId: "u", toolName: "apply_patch", args: { input } });
	observer.event({ type: "tool_execution_end", toolCallId: "u", toolName: "apply_patch", isError: false });
	assert.deepEqual(monitor.touchedFiles("s1"), ["src/real.ts", "src/second.ts"]);
});
