import { describe, expect, test } from "bun:test";

import register from "../src/session/index.js";
import { isSessionRecoveryCall } from "../src/session/actions.js";
import { SESSION_PARAMETERS } from "../src/session/parameters.js";

function setup() {
	const tools = new Map<string, any>();
	let title = "Existing";
	register({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getSessionName: () => title,
		setSessionName: (name: string) => { title = name; },
	} as any);
	return { tools, tool: tools.get("session"), title: () => title };
}

describe("session action dispatch", () => {
	test("registers one flat action-based tool without legacy names", () => {
		const { tools, tool } = setup();
		expect([...tools.keys()]).toEqual(["session"]);
		expect(tool.parameters).toBe(SESSION_PARAMETERS);
		expect(tool.parameters.type).toBe("object");
		expect(tool.parameters.required).toEqual(["action"]);
		expect(tool.parameters.properties.action.enum).toEqual(["name", "overview", "read", "search", "recovery"]);
	});

	test("rejects unknown/missing actions, wrong types, extra and action-incompatible arguments before dispatch", async () => {
		const { tool, title } = setup();
		for (const input of [
			{}, null, { action: "unknown" }, { action: "session_name" },
			{ action: "name", name: 5 }, { action: "name", query: "unexpected" },
			{ action: "overview", name: "Do not rename" }, { action: "read", extra: true },
			{ action: "overview", scope: "other" }, { action: "overview", max_sections: 101 },
			{ action: "read", max_entries: 51 }, { action: "read", max_body_chars: 8_001 },
			{ action: "overview", cursor: "x".repeat(2_001) },
			{ action: "search" }, { action: "search", query: "   " },
			{ action: "search", query: "x".repeat(501) }, { action: "search", query: "x", case_sensitive: "true" },
			{ action: "recovery", recent_error_limit: 21 },
		]) {
			const result = await tool.execute("invalid", input);
			expect(result.isError).toBe(true);
			expect(result.details.valid).toBe(false);
		}
		expect(title()).toBe("Existing");
	});

	test("history actions use the current in-memory session without UI or file paths", async () => {
		const { tool } = setup();
		for (const input of [{ action: "overview" }, { action: "read", entry_id: "missing" }, { action: "search", query: "lost" }, { action: "recovery" }]) {
			const result = await tool.execute("history", input, undefined, undefined, { sessionManager: { getBranch: () => [], getEntries: () => [] } });
			expect(result.isError).not.toBe(true);
			expect(result.content[0].text).toContain("No raw session entries");
		}
	});

	test("recovery classification requires a current history action, never title reads/renames or legacy tools", () => {
		for (const action of ["overview", "read", "search", "recovery"]) expect(isSessionRecoveryCall("session", { action })).toBe(true);
		for (const input of [undefined, null, {}, { action: "name" }, { action: "invalid" }]) expect(isSessionRecoveryCall("session", input)).toBe(false);
		expect(isSessionRecoveryCall("session_search", { query: "history" })).toBe(false);
	});
});
