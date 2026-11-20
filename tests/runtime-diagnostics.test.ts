import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentSessionRuntime, type AgentSession, type AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { reportRuntimeDiagnostics } from "../src/app/session/runtime-diagnostics.js";
import type { Entry } from "../src/app/types.js";

function runtimeWith(diagnostics: { type: "info" | "warning" | "error"; message: string }[]): AgentSessionRuntime {
	const session = { sessionId: "s1" } as unknown as AgentSession;
	const services = { cwd: "/tmp/project" } as unknown as AgentSessionServices;
	return new AgentSessionRuntime(session, services, (async () => { throw new Error("unused"); }) as never, diagnostics);
}

describe("reportRuntimeDiagnostics", () => {
	it("shows each runtime diagnostic once and logs only scalar metadata for warnings/errors", () => {
		const runtime = runtimeWith([
			{ type: "warning", message: "No models match pattern \"x/secret\"" },
			{ type: "error", message: "Extension failed to load" },
			{ type: "info", message: "fyi" },
		]);
		const entries: Entry[] = [];
		const logs: unknown[][] = [];
		const log = (...args: unknown[]) => { logs.push(args); };

		reportRuntimeDiagnostics(runtime, (entry) => entries.push(entry), "startup", log as never);
		reportRuntimeDiagnostics(runtime, (entry) => entries.push(entry), "replacement", log as never);

		assert.deepEqual(entries.map((entry) => [entry.kind, "text" in entry ? entry.text : undefined]), [
			["system", "[warning] No models match pattern \"x/secret\""],
			["error", "[error] Extension failed to load"],
			["system", "[info] fyi"],
		]);
		assert.deepEqual(logs.map(([level, event, details]) => [level, event, details]), [
			["warn", "session:runtime-diagnostic", { diagnosticType: "warning", phase: "startup" }],
			["error", "session:runtime-diagnostic", { diagnosticType: "error", phase: "startup" }],
		]);
		assert.equal(JSON.stringify(logs).includes("secret"), false);
	});

	it("tolerates runtimes without the SDK method", () => {
		const entries: Entry[] = [];
		reportRuntimeDiagnostics({ cwd: "/tmp" } as unknown as AgentSessionRuntime, (entry) => entries.push(entry), "startup", (() => {}) as never);
		assert.equal(entries.length, 0);
	});
});
