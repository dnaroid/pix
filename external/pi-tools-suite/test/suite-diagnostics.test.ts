import { expect, test } from "bun:test";
import {
	createSuiteDiagnostics, diagnosticErrorType, diagnosticSearchReason, type SuiteDiagnosticSink,
} from "../src/lib/suite-diagnostics.js";

type Captured = Parameters<SuiteDiagnosticSink>;
const capture = () => {
	const records: Captured[] = [];
	const sink: SuiteDiagnosticSink = (...values) => { records.push(values); };
	return { records, sink };
};
const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

test("suite diagnostics do nothing outside Pix, including no module lookup", async () => {
	let imports = 0;
	const reporter = createSuiteDiagnostics({
		enabled: () => false,
		loadSink: async () => { imports++; throw new Error("not loaded"); },
	});
	reporter.report("warn", "loader", "module-load-failed", "/workspace");
	await tick();
	expect(imports).toBe(0);
});

test("Pix-injected sink works for separately installed suite copies", async () => {
	const symbol = Symbol.for("pix.diagnostics.sink");
	const globals = globalThis as Record<symbol, unknown>;
	const previous = globals[symbol];
	const { records, sink } = capture();
	globals[symbol] = sink;
	try {
		const reporter = createSuiteDiagnostics({ enabled: () => true });
		reporter.report("warn", "loader", "module-load-failed", "/projects/copied-suite", { count: 1 });
		await tick();
		expect(records).toEqual([[
			"warn", "suite:module-load-failed", { count: 1 },
			{ project: "/projects/copied-suite", module: "suite.loader" },
		]]);
	} finally {
		if (previous === undefined) delete globals[symbol];
		else globals[symbol] = previous;
	}
});

test("reporting never waits for the logger and limits queued startup records", async () => {
	let release!: (sink: SuiteDiagnosticSink) => void;
	let imports = 0;
	const { records, sink } = capture();
	const reporter = createSuiteDiagnostics({
		enabled: () => true,
		loadSink: async () => {
			imports++;
			return await new Promise<SuiteDiagnosticSink>((resolve) => { release = resolve; });
		},
	});
	for (let i = 0; i < 300; i++) reporter.report("info", "loader", `loaded-${i}`, "/workspace");
	// Even an unresolved import never makes an extension call wait.
	expect(records).toHaveLength(0);
	await tick();
	expect(imports).toBe(1);
	release(sink);
	await tick();
	expect(records).toHaveLength(32);
	expect(records[0]).toEqual(["info", "suite:loaded-0", {}, { project: "/workspace", module: "suite.loader" }]);
	reporter.report("info", "loader", "ready", "/workspace");
	expect(records).toHaveLength(33);
});

test("same warnings are coalesced by project, with suppressed count on next window", async () => {
	let time = 1000;
	const { records, sink } = capture();
	const reporter = createSuiteDiagnostics({
		enabled: () => true,
		loadSink: async () => sink,
		now: () => time,
	});
	reporter.report("warn", "dcp", "progress-blocked", "/workspace");
	await tick();
	for (let i = 0; i < 30; i++) reporter.report("warn", "dcp", "progress-blocked", "/workspace");
	reporter.report("warn", "dcp", "progress-blocked", "/other-project");
	expect(records).toHaveLength(2);
	time += 60_000;
	reporter.report("warn", "dcp", "progress-blocked", "/workspace");
	expect(records).toHaveLength(3);
	expect(records[2]![2]).toEqual({ suppressed: 30 });
});

test("debug is opt-in and the shared record receives only bounded safe scalar metadata", async () => {
	const { records, sink } = capture();
	const reporter = createSuiteDiagnostics({ enabled: () => true, debug: () => false, loadSink: async () => sink });
	reporter.report("debug", "search", "index-completed", "/workspace");
	reporter.report("error", "subagents", "launch-failed", "/workspace", {
		errorType: diagnosticErrorType(new Error("private password=123")),
		action: "spawn",
		count: 4,
		token: 123456,
		content: "private body",
		request: "top-secret",
		source: "../private/path",
		phase: "failed",
	});
	await tick();
	expect(records).toHaveLength(1);
	expect(records[0]).toEqual(["error", "suite:launch-failed",
		{ errorType: "Error", action: "spawn", count: 4, phase: "failed" },
		{ module: "suite.subagents", project: "/workspace" }]);
	expect(JSON.stringify(records)).not.toContain("private");
	expect(diagnosticErrorType({ message: "private" })).toBe("UnknownFailure");
	const custom = new Error("safe message");
	custom.name = "PrivateSessionToken";
	expect(diagnosticErrorType(custom)).toBe("OtherError");
});

test("DCP reasons are safe, and distinct causes remain distinguishable without spamming", async () => {
	const { records, sink } = capture();
	const reporter = createSuiteDiagnostics({ enabled: () => true, loadSink: async () => sink });
	reporter.report("warn", "dcp", "auto-compression-failed", "/workspace", { reason: "non-positive-gain" });
	await tick();
	reporter.report("warn", "dcp", "auto-compression-failed", "/workspace", { reason: "non-positive-gain" });
	reporter.report("warn", "dcp", "auto-compression-failed", "/workspace", { reason: "summarizer-unavailable" });
	reporter.report("warn", "dcp", "auto-compression-failed", "/workspace", { reason: "private user message" });
	expect(records.map((r) => r[2].reason)).toEqual(["non-positive-gain", "summarizer-unavailable", "other"]);
	expect(JSON.stringify(records)).not.toContain("private user message");
});

test("separate sessions in the same project never suppress each other's failures", async () => {
	const { records, sink } = capture();
	const reporter = createSuiteDiagnostics({ enabled: () => true, loadSink: async () => sink });
	const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } });
	reporter.report("error", "dcp", "provider-request-blocked", "/workspace",
		{ reason: "budget-exhausted" }, ctx("s1"));
	await tick();
	reporter.report("error", "dcp", "provider-request-blocked", "/workspace",
		{ reason: "budget-exhausted" }, ctx("s2"));
	reporter.report("error", "dcp", "provider-request-blocked", "/workspace",
		{ reason: "budget-exhausted" }, ctx("s1"));
	expect(records.map((r) => r[3].sessionId)).toEqual(["s1", "s2"]);
	const hostile = { sessionManager: { getSessionId() { throw new Error("secret session"); } } };
	expect(() => reporter.report("warn", "dcp", "journal-load-failed", "/workspace", {}, hostile)).not.toThrow();
	expect(records[2]![3].sessionId).toBeUndefined();
});

test("failed loading or broken log sinks cannot affect operations or retry endlessly", async () => {
	let attempts = 0;
	const absent = createSuiteDiagnostics({
		enabled: () => true,
		loadSink: async () => { attempts++; throw new Error("not available"); },
	});
	absent.report("warn", "todo", "load-failed");
	await tick();
	absent.report("warn", "todo", "sync-failed");
	await tick();
	expect(attempts).toBe(1);

	let sent = 0;
	const broken = createSuiteDiagnostics({
		enabled: () => true,
		loadSink: async () => { return () => { sent++; return Promise.reject(new Error("I/O failed")); }; },
	});
	broken.report("warn", "todo", "sync-failed");
	await tick();
	broken.report("warn", "todo", "load-failed");
	await tick();
	expect(sent).toBe(2);
});

test("search failure reasons are fixed categories and never carry the message", async () => {
	expect(diagnosticSearchReason(new Error("Search source busy; update deferred"))).toBe("busy");
	expect(diagnosticSearchReason(new Error("Search work ownership expired"))).toBe("ownership-expired");
	expect(diagnosticSearchReason(new Error("Search source selection changed"))).toBe("policy-changed");
	expect(diagnosticSearchReason(new Error("Semantic configuration changed"))).toBe("config-changed");
	expect(diagnosticSearchReason(new Error("Task embedding identity is incompatible"))).toBe("incompatible");
	expect(diagnosticSearchReason(new Error("database is locked"))).toBe("locked");
	expect(diagnosticSearchReason(Object.assign(new Error("x"), { code: "SEARCH_WORK_NEEDS_CONTINUE" }))).toBe("needs-continue");
	expect(diagnosticSearchReason(new Error("/Users/me/secret"))).toBe("other");
	expect(diagnosticSearchReason("busy")).toBe("other");
	const { records, sink } = capture();
	const reporter = createSuiteDiagnostics({ enabled: () => true, loadSink: async () => sink });
	reporter.report("warn", "search", "background-task-index-failed", "/workspace", { source: "tasks", errorType: "Error", reason: "busy" });
	reporter.report("warn", "search", "background-task-index-failed", "/workspace", { source: "tasks", errorType: "Error", reason: "locked" });
	await tick();
	expect(records.map((r) => r[2].reason)).toEqual(["busy", "locked"]);
});
