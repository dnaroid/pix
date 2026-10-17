import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { getParentSubagentSessionDir, getSubagentSessionDir } from "../../src/async-subagents/core/sessions.js";
import { PARENT_SESSION_ID_PATTERN } from "../../src/async-subagents/core/paths.js";
import { parseSubagentMeta, registerSubagentMetaEntry, SUBAGENT_META_ENTRY, SUBAGENT_META_ENV } from "../../src/async-subagents/core/subagent-meta.js";

const parentId = "0199f0c2-1111-7222-8333-944445555666";

describe("session-native child layout (decision 0072)", () => {
	test("stores children in the project-local parent-scoped dir", () => {
		expect(getParentSubagentSessionDir("/p", parentId)).toBe(path.join("/p", ".pi", "subagents", parentId));
		expect(getSubagentSessionDir("/p/.pi/subagents/run/a1", "/p", parentId)).toBe(getParentSubagentSessionDir("/p", parentId)!);
	});

	test("falls back to the legacy agent dir without a safe parent id", () => {
		for (const value of [undefined, "", "  ", "../x", "2026-10-17T00-00-00-run", `${parentId}/..`]) {
			expect(getParentSubagentSessionDir("/p", value)).toBeUndefined();
			expect(getSubagentSessionDir("/p/.pi/subagents/run/a1", "/p", value)).toBe(path.join("/p/.pi/subagents/run/a1", "sessions"));
		}
	});

	test("parent-id dirs never collide with timestamp-named legacy run dirs", () => {
		expect(PARENT_SESSION_ID_PATTERN.test(parentId)).toBe(true);
		expect(PARENT_SESSION_ID_PATTERN.test("2026-10-17T12-59-54-subagent-redesign-risks")).toBe(false);
	});

	test("parses only valid version-1 metadata", () => {
		const meta = { version: 1, agentId: "a1", batch: "run", runDir: "/p/.pi/subagents/run", cwd: "/p" };
		expect(parseSubagentMeta(JSON.stringify(meta))).toEqual(meta);
		expect(parseSubagentMeta(undefined)).toBeUndefined();
		expect(parseSubagentMeta("{bad")).toBeUndefined();
		expect(parseSubagentMeta(JSON.stringify({ ...meta, version: 2 }))).toBeUndefined();
		expect(parseSubagentMeta(JSON.stringify({ ...meta, agentId: 1 }))).toBeUndefined();
	});

	test("child appends subagent_meta once per session", () => {
		const meta = { version: 1, agentId: "a1", batch: "run", runDir: "/r", cwd: "/p" };
		const handlers: Array<(event: unknown, ctx: unknown) => void> = [];
		const appended: Array<{ type: string; data: unknown }> = [];
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { if (name === "session_start") handlers.push(handler); },
			appendEntry: (type: string, data: unknown) => { appended.push({ type, data }); },
		};
		registerSubagentMetaEntry(pi as never, { [SUBAGENT_META_ENV]: JSON.stringify(meta) });
		expect(handlers).toHaveLength(1);
		handlers[0]!({}, { sessionManager: { getEntries: () => [] } });
		expect(appended).toEqual([{ type: SUBAGENT_META_ENTRY, data: meta }]);
		handlers[0]!({}, { sessionManager: { getEntries: () => [{ type: "custom", customType: SUBAGENT_META_ENTRY }] } });
		expect(appended).toHaveLength(1);
	});

	test("does not register without metadata", () => {
		let registered = 0;
		registerSubagentMetaEntry({ on: () => { registered++; }, appendEntry: () => {} } as never, {});
		expect(registered).toBe(0);
	});
});
