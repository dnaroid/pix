import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateSubagentChanges } from "../src/app/session/session-subagent-changes.js";
import { aggregateSessionUsage } from "../src/app/session/session-usage.js";

function evidence(agentId: string | undefined, toolCallId: string, files: unknown[], gaps: string[] = [], runDir = "/run") {
	return { type: "custom", customType: "pi-tools-suite:session-changes", data: { version: 1, agentId, toolCallId, toolName: "apply_patch", files, gaps, runDir } };
}

describe("subagent changed files", () => {
	it("combines child evidence, deduplicates paths and preserves last deletion/recreation and moves", () => {
		const entries = [
			evidence(undefined, "parent", [{ path: "parent.ts", operation: "edit" }]),
			evidence("a", "1", [{ path: "a.ts", operation: "create" }, { path: "gone.ts", operation: "edit" }]),
			evidence("b", "2", [{ path: "a.ts", operation: "delete" }, { path: "gone.ts", operation: "delete" }]),
			evidence("a", "3", [{ path: "a.ts", operation: "write" }, { path: "new.ts", operation: "move", previousPath: "old.ts" }]),
		];
		const before = structuredClone(entries);
		const changes = aggregateSessionUsage(entries).subagents!.changes;
		assert.deepEqual(changes, { files: [
			{ path: "a.ts", operation: "write" }, { path: "gone.ts", operation: "delete" },
			{ path: "new.ts", operation: "move", previousPath: "old.ts" },
		], gaps: [] });
		assert.deepEqual(entries, before);
	});
	it("distinguishes missing evidence from explicit empty evidence and preserves coverage gaps", () => {
		assert.equal(aggregateSubagentChanges([]), undefined);
		assert.deepEqual(aggregateSubagentChanges([evidence("a", "shell", [], ["shell side effects not inferred"])]), {
			files: [], gaps: ["a: shell side effects not inferred"],
		});
		assert.deepEqual(aggregateSubagentChanges([evidence("a", "read", [])]), { files: [], gaps: [] });
	});
	it("separates colliding tool ids across runs and agents and ignores malformed versions", () => {
		const a = evidence("a", "1", [{ path: "one", operation: "edit" }]);
		const b = evidence("a", "1", [{ path: "two", operation: "edit" }], [], "/another-run");
		assert.equal(aggregateSubagentChanges([a, b])!.files.length, 2);
		assert.equal(aggregateSubagentChanges([{ ...a, data: { ...a.data, version: 2 } }]), undefined);
		assert.equal(aggregateSubagentChanges([evidence("a", "bad", [{ path: "one", operation: "oops" }])]), undefined);
	});
});
