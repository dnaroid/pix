import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareUserMessageEdit, commitUserMessageEdit } from "../src/app/workspace/user-message-edit.js";
import { AppWorkspaceActionsController } from "../src/app/workspace/workspace-actions-controller.js";
import { InputEditor } from "../src/input-editor.js";

const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };

function fixture(parentId: string | null = "parent") {
	let leaf: string | null = "answer";
	let current = true;
	let cancelled = false;
	let reserved = false;
	const calls: string[] = [];
	const entries = [{ id: "user", parentId, type: "message", message: { role: "user", content: [{ type: "text", text: "canonical\n[Pix attachment: file:///tmp/a.txt]" }, image] } }];
	const manager = { getLeafId: () => leaf, getSessionFile: () => "same.jsonl", getBranch: () => entries };
	const runtime = { session: { isStreaming: false, isCompacting: false, sessionManager: manager, navigateTree: async (id: string) => {
		assert.equal(reserved, true); assert.equal(id, "user"); calls.push("navigate");
		if (!cancelled) leaf = parentId;
		return { cancelled };
	} } };
	const options = {
		runtime: runtime as any, isCurrent: () => current,
		reserve: () => { assert.equal(reserved, false); reserved = true; return () => { reserved = false; }; },
		reloadHistory: () => calls.push("reload"),
		resend: (message: unknown) => { assert.equal(reserved, false); assert.deepEqual(message, { text: "edited", images: [image] }); calls.push("send"); },
	};
	return { options, calls, entries, setCurrent: (value: boolean) => { current = value; },
		setLeaf: (value: string | null) => { leaf = value; }, setCancelled: () => { cancelled = true; }, reserved: () => reserved };
}

test("prepare loads canonical text and attachments without navigation", () => {
	const f = fixture();
	const pending = prepareUserMessageEdit(f.options.runtime, "user");
	assert.equal(pending.text, "canonical\n[Pix attachment: file:///tmp/a.txt]");
	assert.deepEqual(pending.images, [image]);
	assert.deepEqual(f.calls, []);
});

for (const parent of ["parent", null]) test(`Send rewinds to ${parent ?? "root"} in the same tree then resends normally`, async () => {
	const f = fixture(parent);
	const pending = prepareUserMessageEdit(f.options.runtime, "user");
	await commitUserMessageEdit({ ...f.options, pending, edit: { text: "edited", images: [image] } });
	assert.deepEqual(f.calls, ["navigate", "reload", "send"]);
	assert.equal(f.entries[0]!.message.content[0]!.type, "text");
	assert.equal(f.reserved(), false);
});

test("session/branch changes while composer editing fail closed", async () => {
	for (const stale of ["session", "branch"]) {
		const f = fixture();
		const pending = prepareUserMessageEdit(f.options.runtime, "user");
		if (stale === "session") f.setCurrent(false); else f.setLeaf("new-answer");
		await assert.rejects(commitUserMessageEdit({ ...f.options, pending, edit: { text: "edited", images: [] } }), /conversation changed/);
		assert.deepEqual(f.calls, []);
	}
});

test("extension cancellation does not resend and releases reservation", async () => {
	const f = fixture(); f.setCancelled();
	const pending = prepareUserMessageEdit(f.options.runtime, "user");
	assert.equal(await commitUserMessageEdit({ ...f.options, pending, edit: { text: "edited", images: [] } }), false);
	assert.deepEqual(f.calls, ["navigate"]); assert.equal(f.reserved(), false);
});

test("missing identity and leaf-only user messages fail closed", () => {
	const missing = fixture();
	assert.throws(() => prepareUserMessageEdit(missing.options.runtime, "missing"), /active branch/);
	const leaf = fixture(); leaf.setLeaf("user");
	assert.throws(() => prepareUserMessageEdit(leaf.options.runtime, "user"), /no response/);
	assert.deepEqual(missing.calls, []); assert.deepEqual(leaf.calls, []);
});

function composerFixture() {
	const f = fixture();
	let active = f.options.runtime;
	const editor = new InputEditor();
	editor.setText("existing draft"); editor.attachImage("saved", "image/png");
	const previous = editor.draftState;
	const sent: unknown[] = [];
	const controller = new AppWorkspaceActionsController({
		entries: [], runtime: () => active, isRunning: () => true,
		awaitCurrentSessionExtensions: async () => {},
		getInputDraft: () => editor.draftState, setInputDraft: (draft) => editor.restoreDraftState(draft),
		loadEditDraft: (edit) => { editor.clear(); editor.setText(edit.text); for (const item of edit.images) editor.attachImage(item.data, item.mimeType); },
		getEditedInput: () => ({ text: editor.promptText, images: editor.images }), inputVersion: () => editor.contentVersion,
		clearEditedInput: () => editor.clear(), canEditUserMessage: () => true,
		reserveMessageEdit: f.options.reserve, resendEditedUserMessage: (_runtime, edit) => { sent.push(edit); f.calls.push("send"); },
		resetSessionView: () => f.calls.push("reload"), loadSessionHistory: () => {},
		findUserEntry: () => ({ id: "user", kind: "user", text: "canonical", sessionEntryId: "user" }), touchEntry: () => {}, addEntry: () => {}, setInput: () => {}, getInput: () => "",
		setStatus: () => {}, setSessionStatus: () => {}, showToast: () => {}, render: () => {}, forkSessionEntryInNewTab: async () => false,
	});
	return { ...f, editor, previous, controller, sent, switchSession: () => { active = { session: {} } as any; },
		returnToSource: () => { active = f.options.runtime; } };
}

test("TUI edit loads MAIN input, cancel restores complete prior draft and never navigates", async () => {
	const f = composerFixture();
	await f.controller.editUserMessage("user");
	assert.equal(f.controller.messageEditActive, true);
	assert.ok(f.editor.text.startsWith("canonical")); assert.deepEqual(f.editor.images, [image]);
	assert.deepEqual(f.calls, []);
	assert.equal(f.controller.cancelMessageEdit(), true);
	assert.equal(f.controller.messageEditActive, false);
	assert.deepEqual(f.editor.draftState, f.previous); assert.deepEqual(f.calls, []);
});

test("TUI ordinary composer Send commits edited draft with removed image/file markers", async () => {
	const f = composerFixture(); await f.controller.editUserMessage("user");
	assert.equal(f.editor.removeAttachmentAtCursor(), true);
	f.editor.setText("changed");
	assert.equal(await f.controller.submitMessageEdit(), true);
	assert.deepEqual(f.sent, [{ text: "changed", images: [] }]);
	assert.deepEqual(f.calls, ["navigate", "reload", "send"]);
	assert.equal(f.editor.text, ""); assert.equal(f.controller.messageEditActive, false);
});

test("TUI ordinary Send in a different session cannot consume pending edit", async () => {
	const f = composerFixture(); await f.controller.editUserMessage("user"); f.switchSession();
	assert.equal(f.controller.messageEditActive, false);
	assert.equal(await f.controller.submitMessageEdit(), false); assert.deepEqual(f.calls, []);
});

test("TUI selection changes after rewind release pending edit without restoring or clearing text", async () => {
	const f = composerFixture(); await f.controller.editUserMessage("user");
	f.editor.setText("keep edited text");
	const navigate = f.options.runtime.session.navigateTree;
	f.options.runtime.session.navigateTree = async (id: string) => {
		const result = await navigate(id); f.switchSession(); return result;
	};
	await f.controller.submitMessageEdit(); f.returnToSource();
	assert.equal(f.controller.messageEditActive, false);
	assert.equal(f.editor.text, "keep edited text");
	assert.deepEqual(f.calls, ["navigate"]); assert.equal(f.reserved(), false);
	assert.equal(await f.controller.submitMessageEdit(), false);
});

for (const outcome of ["cancel", "reject"] as const) test(`TUI partially moved ${outcome} navigation does not strand the edit`, async () => {
	const f = composerFixture(); await f.controller.editUserMessage("user");
	f.editor.setText("keep edited text");
	f.options.runtime.session.navigateTree = async () => {
		f.setLeaf("parent");
		if (outcome === "reject") throw new Error("extension failed after navigation");
		return { cancelled: true };
	};
	await f.controller.submitMessageEdit();
	assert.equal(f.controller.messageEditActive, false);
	assert.equal(f.editor.text, "keep edited text");
	assert.deepEqual(f.sent, []); assert.equal(f.reserved(), false);
});
