import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isMessageEditRewindPosition } from "../src/app/session/message-edit-rewind.js";

for (const root of [false, true]) test(`rewind position allows custom metadata with the real SDK (root=${root})`, () => {
	const manager = SessionManager.inMemory();
	const parentId = root ? null : manager.appendCustomEntry("parent", {});
	const userId = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
	manager.appendCustomEntry("old-branch", {});
	if (parentId === null) manager.resetLeaf(); else manager.branch(parentId);
	assert.equal(isMessageEditRewindPosition(manager, parentId), true);
	manager.appendCustomEntry("dcp-diagnostic", { event: "epoch" });
	manager.appendCustomEntry("dcp-journal", {});
	assert.equal(isMessageEditRewindPosition(manager, parentId), true);
	assert.equal(isMessageEditRewindPosition(manager, userId), false, "must not accept the abandoned branch");
	assert.ok(manager.getEntry(userId), "original entry is retained");
	manager.appendMessage({ role: "user", content: "another prompt", timestamp: 2 });
	assert.equal(isMessageEditRewindPosition(manager, parentId), false);
});

test("rewind position fails closed on broken, cyclic, wrong-lineage or context-changing suffixes", () => {
	for (const suffix of [
		[{ id: "leaf", parentId: "missing", type: "custom" }],
		[{ id: "leaf", parentId: "leaf", type: "custom" }],
		[{ id: "leaf", parentId: "other-root", type: "custom" }, { id: "other-root", parentId: null, type: "custom" }],
		...["message", "custom_message", "branch_summary", "compaction", "context_edit"].map((type) => [{ id: "leaf", parentId: "parent", type }]),
	]) {
		const manager = { getLeafId: () => "leaf", getEntry: (id: string) => suffix.find((entry) => entry.id === id) };
		assert.equal(isMessageEditRewindPosition(manager, "parent"), false, JSON.stringify(suffix));
	}
});
