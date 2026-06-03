import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { createSessionSearchMenuItems, searchResultScrollNeedles, searchResultTargetEntry, searchSessions, type SessionSearchResult } from "../src/app/session/session-search.js";
import type { Entry } from "../src/app/types.js";

describe("session search helpers", () => {
	it("prefers a user entry with the matching session entry id", () => {
		const result = fakeResult({ sessionEntryId: "session-user-2", text: "needle" });
		const entries: Entry[] = [
			{ id: "user-1", kind: "user", text: "needle appears earlier", sessionEntryId: "session-user-1" },
			{ id: "user-2", kind: "user", text: "target message", sessionEntryId: "session-user-2" },
		];

		assert.equal(searchResultTargetEntry(entries, result)?.id, "user-2");
	});

	it("falls back from a non-user session entry id to the visible match text", () => {
		const result = fakeResult({ sessionEntryId: "assistant-session-entry", text: "needle from session history" });
		const entries: Entry[] = [
			{ id: "assistant-1", kind: "assistant", text: "no match here" },
			{ id: "assistant-2", kind: "assistant", text: "needle from session history" },
		];

		assert.equal(searchResultTargetEntry(entries, result)?.id, "assistant-2");
	});

	it("falls back to matching visible entry text case-insensitively", () => {
		const result = fakeResult({ text: "long assistant text with Needle across history" });
		const entries: Entry[] = [
			{ id: "user-1", kind: "user", text: "no match" },
			{ id: "assistant-1", kind: "assistant", text: "The needle is here" },
		];

		assert.equal(searchResultTargetEntry(entries, result)?.id, "assistant-1");
	});

	it("formats menu items with snippet and session metadata", () => {
		const [item] = createSessionSearchMenuItems([fakeResult({ text: "needle", snippet: "…needle…" })]);

		assert.equal(item?.label, "Named session");
		assert.match(item?.description ?? "", /…needle…/);
		assert.match(item?.description ?? "", /2 msg/);
		assert.equal(item?.value.session.id, "session-id");
	});

	it("builds scroll needles from the found text sample", () => {
		const needles = searchResultScrollNeedles(fakeResult({
			text: "before words around the Needle result and after words",
			snippet: "…around the Needle result…",
		}));

		assert.match(needles[0] ?? "", /Needle result/);
		assert.ok(needles.some((needle) => needle === "needle"));
		assert.ok(needles.every((needle) => !needle.startsWith("…") && !needle.endsWith("…")));
	});

	it("searches persisted sessions and reports progress", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-session-search-"));
		const agentDir = join(dir, "agent");
		const sessionDir = join(agentDir, "sessions");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
		try {
			const matchingSession = SessionManager.create(dir, undefined, { id: "session-match" });
			matchingSession.appendMessage({ role: "user", content: "A very visible needle in a haystack" } as never);
			matchingSession.appendMessage({ role: "assistant", content: "reply" } as never);
			const otherSession = SessionManager.create(dir, undefined, { id: "session-other" });
			otherSession.appendMessage({ role: "user", content: "Something unrelated" } as never);

			const progress: Array<[number, number]> = [];
			const results = await searchSessions("needle", {
				cwd: dir,
				maxResults: 5,
				snippetLength: 40,
				onProgress: (loaded, total) => {
					progress.push([loaded, total]);
				},
			});

			assert.equal(results.length, 1);
			assert.equal(results[0]?.session.id, "session-match");
			assert.match(results[0]?.snippet ?? "", /needle/i);
			assert.equal(results[0]?.match.role, "user");
			assert.equal(progress.length > 0, true);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
			else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
		}
	});
	it("limits search results to the requested maximum", async () => {
		const originalList = SessionManager.list;
		const originalOpen = SessionManager.open;
		const sessions: SessionInfo[] = [
			{
				path: "/tmp/session-a.jsonl",
				id: "session-a",
				cwd: "/tmp",
				name: "Alpha",
				created: new Date("2026-01-01T00:00:00Z"),
				modified: new Date("2026-01-02T00:00:00Z"),
				messageCount: 1,
				firstMessage: "needle one",
				allMessagesText: "needle one",
			},
			{
				path: "/tmp/session-b.jsonl",
				id: "session-b",
				cwd: "/tmp",
				name: "Beta",
				created: new Date("2026-01-03T00:00:00Z"),
				modified: new Date("2026-01-04T00:00:00Z"),
				messageCount: 1,
				firstMessage: "needle two",
				allMessagesText: "needle two",
			},
		];
		try {
			SessionManager.list = async () => sessions as never;
			SessionManager.open = ((path: string) => ({
				getBranch: () => [{ id: path.endsWith("a.jsonl") ? "entry-a" : "entry-b", type: "message", message: { role: "user", content: path.endsWith("a.jsonl") ? "needle one" : "needle two" } }],
			})) as never;

			const results = await searchSessions("needle", {
				cwd: "/tmp",
				maxResults: 1,
				snippetLength: 32,
			});

			assert.equal(results.length, 1);
			assert.equal(results[0]?.session.id, "session-a");
		} finally {
			SessionManager.list = originalList;
			SessionManager.open = originalOpen;
		}
	});

	it("matches visible tool text when a session search result has no persisted entry id", () => {
		const result = fakeResult({ text: "tool output with Needle inside" });
		const entries: Entry[] = [
			{ id: "tool-1", kind: "tool", toolName: "shell", argsText: "{}", output: "tool output with needle inside", expanded: false, isError: false, status: "done" },
		];

		assert.equal(searchResultTargetEntry(entries, result)?.id, "tool-1");
	});

});

function fakeResult(overrides: Partial<SessionSearchResult["match"]> & { snippet?: string } = {}): SessionSearchResult {
	const session: SessionInfo = {
		path: "/tmp/session.jsonl",
		id: "session-id",
		cwd: "/tmp",
		name: "Named session",
		created: new Date("2026-01-01T10:00:00Z"),
		modified: new Date("2026-01-02T11:30:00Z"),
		messageCount: 2,
		firstMessage: "first message",
		allMessagesText: "needle",
	};

	return {
		session,
		query: "needle",
		snippet: overrides.snippet ?? "needle",
		match: {
			text: overrides.text ?? "needle",
			matchIndex: overrides.matchIndex ?? 0,
			...(overrides.sessionEntryId === undefined ? {} : { sessionEntryId: overrides.sessionEntryId }),
			...(overrides.role === undefined ? {} : { role: overrides.role }),
		},
	};
}