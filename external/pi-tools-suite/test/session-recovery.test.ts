import { describe, expect, mock, test } from "bun:test";

import { createTypeboxMock } from "./support/typebox-mock.js";

mock.module("typebox", () => createTypeboxMock());

class FakePi {
	tools = new Map<string, any>();

	registerTool(tool: any) {
		this.tools.set(tool.name, tool);
	}
}

class FakeSessionManager {
	constructor(
		private readonly activeEntries: unknown[],
		private readonly allEntries: unknown[],
	) {}

	getBranch() { return this.activeEntries; }
	getEntries() { return this.allEntries; }
	getHeader() { return { type: "session", id: "session-1", parentSession: "/sessions/parent.jsonl" }; }
	getSessionFile() { return "/sessions/current.jsonl"; }
	getSessionId() { return "session-1"; }
	getSessionName() { return "Recovery test"; }
}

function textPart(text: string) {
	return { type: "text", text };
}

function toolCall(id: string, name: string, args: unknown) {
	return { type: "toolCall", id, name, arguments: args };
}

function fixture() {
	const active = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "Fix ФАЙЛ alpha before compaction" },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [textPart("Inspecting alpha"), toolCall("call-read", "read", { path: "src/read.ts" })],
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [textPart("alpha source")],
				isError: false,
			},
		},
		{
			type: "compaction",
			id: "comp1",
			parentId: "r1",
			timestamp: "2026-01-01T00:00:03.000Z",
			summary: "Earlier alpha work was compacted",
			firstKeptEntryId: "u2",
			tokensBefore: 42_000,
			details: { readFiles: ["carried-read.ts"], modifiedFiles: ["carried-write.ts"] },
		},
		{
			type: "message",
			id: "u2",
			parentId: "comp1",
			timestamp: "2026-01-01T00:00:04.000Z",
			message: { role: "user", content: [textPart("Latest instruction: finish recovery")] },
		},
		{
			type: "message",
			id: "a2",
			parentId: "u2",
			timestamp: "2026-01-01T00:00:05.000Z",
			message: {
				role: "assistant",
				content: [toolCall("call-patch", "apply_patch", {
					input: "*** Begin Patch\n*** Update File: src/changed.ts\n*** End Patch",
				})],
			},
		},
		{
			type: "message",
			id: "r2",
			parentId: "a2",
			timestamp: "2026-01-01T00:00:06.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-patch",
				toolName: "apply_patch",
				content: [textPart("Patch failed")],
				isError: true,
			},
		},
		{
			type: "message",
			id: "a3",
			parentId: "r2",
			timestamp: "2026-01-01T00:00:07.000Z",
			message: {
				role: "assistant",
				content: [
					toolCall("pending-other", "read", { path: "src/pending.ts" }),
					toolCall("current-call", "session_recovery_context", {}),
				],
			},
		},
		{ type: "custom", id: "custom1", parentId: "a3", timestamp: "2026-01-01T00:00:08.000Z", customType: "safe", data: { value: 1 } },
		{ type: "message", message: { role: "user", content: "malformed without id" } },
	];
	const abandoned = {
		type: "message",
		id: "u-abandoned",
		parentId: "u1",
		timestamp: "2026-01-01T00:00:03.500Z",
		message: { role: "user", content: "Abandoned branch phrase" },
	};
	return { active, all: [...active, abandoned] };
}

async function setup() {
	const { default: register } = await import("../src/session-recovery/index.js");
	const pi = new FakePi();
	register(pi as any);
	const entries = fixture();
	const ctx = { sessionManager: new FakeSessionManager(entries.active, entries.all) };
	return { pi, ctx };
}

async function execute(tool: any, callId: string, params: unknown, ctx: unknown) {
	return tool.execute(callId, params, undefined, undefined, ctx);
}

function jsonContent(result: any) {
	return JSON.parse(result.content[0].text);
}

describe("session recovery tools", () => {
	test("registers four tools and maps stable active/all sections", async () => {
		const { pi, ctx } = await setup();
		expect([...pi.tools.keys()]).toEqual([
			"session_overview",
			"session_read_section",
			"session_search",
			"session_recovery_context",
		]);

		const activeResult = await execute(pi.tools.get("session_overview"), "overview", {}, ctx);
		const allResult = await execute(pi.tools.get("session_overview"), "overview", { scope: "all" }, ctx);
		const active = jsonContent(activeResult);
		const all = jsonContent(allResult);

		expect(active.session).toEqual({ id: "session-1", name: "Recovery test", persisted: true, hasParentSession: true });
		expect(active.sections.map((section: any) => section.id)).toEqual(["section:u1", "section:comp1", "section:u2"]);
		expect(active.counts.activeEntries).toBe(9);
		expect(active.counts.allEntries).toBe(10);
		expect(all.sections.map((section: any) => section.id)).toContain("section:u-abandoned");
	});

	test("searches raw pre-compaction history and Unicode case-insensitively", async () => {
		const { pi, ctx } = await setup();
		const activeResult = await execute(pi.tools.get("session_search"), "search", { query: "файл" }, ctx);
		const active = jsonContent(activeResult);

		expect(active.totalMatches).toBe(1);
		expect(active.matches[0]).toMatchObject({ entryId: "u1", sectionId: "section:u1", role: "user" });

		const hiddenResult = await execute(pi.tools.get("session_search"), "search", { query: "Abandoned" }, ctx);
		expect(jsonContent(hiddenResult).totalMatches).toBe(0);

		const allResult = await execute(pi.tools.get("session_search"), "search", { query: "Abandoned", scope: "all" }, ctx);
		expect(jsonContent(allResult).matches[0].entryId).toBe("u-abandoned");
	});

	test("reads a bounded section and reports unknown section IDs normally", async () => {
		const { pi, ctx } = await setup();
		const readResult = await execute(pi.tools.get("session_read_section"), "read-section", {
			section_id: "section:u1",
			max_entries: 2,
			max_body_chars: 100,
		}, ctx);

		expect(readResult.content[0].text).toContain("Fix ФАЙЛ alpha");
		expect(readResult.details).toMatchObject({ sectionId: "section:u1", entryCount: 3, renderedCount: 2, omittedEntries: 1, truncated: true });

		const missing = await execute(pi.tools.get("session_read_section"), "read-section", { section_id: "section:nope" }, ctx);
		expect(missing.details).toMatchObject({ found: false, sectionId: "section:nope" });
	});

	test("recovers deterministic context, file evidence, errors, and pending calls", async () => {
		const { pi, ctx } = await setup();
		const result = await execute(pi.tools.get("session_recovery_context"), "current-call", {}, ctx);
		const recovered = jsonContent(result);

		expect(recovered.originalUserRequest).toMatchObject({ entryId: "u1", sectionId: "section:u1" });
		expect(recovered.latestUserInstruction).toMatchObject({ entryId: "u2", sectionId: "section:u2" });
		expect(recovered.readFiles).toEqual(["src/read.ts", "carried-read.ts", "src/pending.ts"]);
		expect(recovered.modifiedFiles).toEqual(["carried-write.ts", "src/changed.ts"]);
		expect(recovered.recentErrors).toHaveLength(1);
		expect(recovered.recentErrors[0]).toMatchObject({ entryId: "r2", toolName: "apply_patch", message: "Patch failed" });
		expect(recovered.pendingToolCalls).toEqual([
			{ id: "pending-other", name: "read", entryId: "a3", sectionId: "section:u2" },
		]);
		expect(recovered.lastMeaningfulAction).toMatchObject({ entryId: "a3", toolCalls: [{ id: "pending-other", name: "read" }] });
		expect(recovered.compactionCount).toBe(1);
	});

	test("returns a clear normal result for an empty or unavailable session", async () => {
		const { pi } = await setup();
		const result = await execute(pi.tools.get("session_overview"), "overview", {}, {});

		expect(result.content[0].text).toContain("No raw session entries are available");
		expect(result.details).toEqual({ scope: "active", entryCount: 0 });
	});

	test("bounds rendered entry bodies", async () => {
		const { pi } = await setup();
		const longEntry = {
			type: "message",
			id: "long-user",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "x".repeat(10_000) },
		};
		const ctx = { sessionManager: new FakeSessionManager([longEntry], [longEntry]) };
		const result = await execute(pi.tools.get("session_read_section"), "read", {
			section_id: "section:long-user",
			max_body_chars: 100,
		}, ctx);

		expect(result.content[0].text).toContain("[truncated]");
		expect(result.content[0].text.length).toBeLessThan(1_000);
	});
});
