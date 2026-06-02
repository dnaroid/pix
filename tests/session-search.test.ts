import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { createSessionSearchMenuItems, searchResultScrollNeedles, searchResultTargetEntry, type SessionSearchResult } from "../src/app/session/session-search.js";
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
