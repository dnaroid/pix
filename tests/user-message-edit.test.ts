import assert from "node:assert/strict";
import { test } from "node:test";
import { editUserMessageInSession, requestUserMessageEdit } from "../src/app/workspace/user-message-edit.js";

const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };

test("message edit retains attachments and lets the user remove originals", async () => {
	const selected = ["Remove image 1", "Remove file 1: [Pix attachment: file:///tmp/a.txt]", "Save and resend"];
	let prefill = "";
	const result = await requestUserMessageEdit({
		editor: async (_title, text) => { prefill = text!; return "edited\nmultiline"; },
		select: async (_title, choices) => { const choice = selected.shift()!; assert.ok(choices.includes(choice)); return choice; },
	}, "original\n[Pix attachment: file:///tmp/a.txt]", [image]);
	assert.equal(prefill.includes("Pix attachment"), false);
	assert.deepEqual(result, { text: "edited\nmultiline", images: [] });
	const kept = await requestUserMessageEdit({ editor: async () => "edited", select: async () => "Save and resend" },
		"original\n[Pix attachment: file:///tmp/a.txt]", [image]);
	assert.deepEqual(kept, { text: "edited\n\n[Pix attachment: file:///tmp/a.txt]", images: [image] });
});

function fixture(parentId: string | null = "parent") {
	let leaf: string | null = "answer";
	let current = true;
	let edit: string | undefined = "edited";
	let cancelled = false;
	let reserved = false;
	const calls: string[] = [];
	const entries = [{ id: "user", parentId, type: "message", message: { role: "user", content: [{ type: "text", text: "canonical" }, image] } }];
	const manager = { getLeafId: () => leaf, getSessionFile: () => "same.jsonl", getBranch: () => entries };
	const runtime = { session: { sessionManager: manager, navigateTree: async (id: string) => {
		assert.equal(reserved, true); assert.equal(id, "user"); calls.push("navigate");
		if (!cancelled) leaf = parentId;
		return { cancelled };
	} } };
	const options = {
		runtime: runtime as any, entryId: "user", isCurrent: () => current,
		ui: { editor: async (_title: string, prefill?: string) => { assert.equal(prefill, "canonical"); return edit; }, select: async () => "Save and resend" },
		reserve: () => { assert.equal(reserved, false); reserved = true; return () => { reserved = false; }; },
		reloadHistory: () => calls.push("reload"),
		resend: (message: unknown) => { assert.equal(reserved, false); assert.deepEqual(message, { text: "edited", images: [image] }); calls.push("send"); },
	};
	return { options, calls, entries, setEdit: (value?: string) => { edit = value; }, setCurrent: (value: boolean) => { current = value; },
		setLeaf: (value: string | null) => { leaf = value; }, setCancelled: () => { cancelled = true; }, reserved: () => reserved };
}

for (const parent of ["parent", null]) test(`edit rewinds to ${parent ?? "root"} in the same tree and resends normally`, async () => {
	const f = fixture(parent);
	await editUserMessageInSession(f.options);
	assert.deepEqual(f.calls, ["navigate", "reload", "send"]);
	assert.deepEqual(f.entries[0]!.message.content[0], { type: "text", text: "canonical" });
	assert.equal(f.reserved(), false);
});

test("cancel is a strict no-op before navigation", async () => {
	const f = fixture(); f.setEdit(undefined);
	await editUserMessageInSession(f.options);
	assert.deepEqual(f.calls, []);
});

test("session/branch changes during editing fail closed", async () => {
	for (const stale of ["session", "branch"]) {
		const f = fixture();
		f.options.ui.editor = async () => { if (stale === "session") f.setCurrent(false); else f.setLeaf("new-answer"); return "edited"; };
		await assert.rejects(editUserMessageInSession(f.options), /conversation changed/);
		assert.deepEqual(f.calls, []);
	}
});

test("extension cancellation does not resend and releases reservation", async () => {
	const f = fixture(); f.setCancelled();
	await editUserMessageInSession(f.options);
	assert.deepEqual(f.calls, ["navigate"]); assert.equal(f.reserved(), false);
});

test("missing identity and leaf-only user messages never trigger navigation", async () => {
	const missing = fixture(); missing.options.entryId = "missing";
	await assert.rejects(editUserMessageInSession(missing.options), /active branch/);
	const leaf = fixture(); leaf.setLeaf("user");
	await assert.rejects(editUserMessageInSession(leaf.options), /no response/);
	assert.deepEqual(missing.calls, []); assert.deepEqual(leaf.calls, []);
});
