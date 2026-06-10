import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	loadWorkspaceUndoIndex,
	prepareWorkspaceMutation,
	revertWorkspaceMutations,
	saveWorkspaceUndoIndex,
	workspaceMutationFromToolExecution,
	workspaceUndoIndexKey,
	type WorkspaceMutation,
} from "../src/app/workspace/workspace-undo.js";

test("revertWorkspaceMutations applies recorded patches bottom-up and preserves unrelated files", async () => {
	const { cwd, cleanup } = createTempWorkspace();
	try {
		writeFileSync(join(cwd, "notes.txt"), numberedLines({ 5: "before" }), "utf8");
		writeFileSync(join(cwd, "notes.txt"), numberedLines({ 5: "agent" }), "utf8");
		writeFileSync(join(cwd, "parallel.txt"), "keep me\n", "utf8");

		const reverted = await revertWorkspaceMutations(cwd, [
			{
				type: "patch",
				patch: unifiedPatch("notes.txt", numberedLines({ 5: "before" }), numberedLines({ 5: "agent" })),
				toolName: "edit",
			},
		]);

		assert.equal(reverted.ok, true);
		assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), numberedLines({ 5: "before" }));
		assert.equal(readFileSync(join(cwd, "parallel.txt"), "utf8"), "keep me\n");
	} finally {
		cleanup();
	}
});

test("revertWorkspaceMutations accepts edit patches recorded with absolute workspace paths", async () => {
	const { cwd, cleanup } = createTempWorkspace();
	try {
		const absolutePath = join(cwd, "a.txt");
		writeFileSync(absolutePath, "hello world\n", "utf8");
		const absolutePatch = [
			`--- ${absolutePath}`,
			`+++ ${absolutePath}`,
			"@@ -1,1 +1,1 @@",
			"-hello",
			"+hello world",
			"",
		].join("\n");

		const reverted = await revertWorkspaceMutations(cwd, [{ type: "patch", patch: absolutePatch, toolName: "Edit" }]);

		assert.equal(reverted.ok, true);
		assert.equal(readFileSync(absolutePath, "utf8"), "hello\n");
	} finally {
		cleanup();
	}
});

test("revertWorkspaceMutations rolls back earlier undo steps when a later command conflicts", async () => {
	const { cwd, cleanup } = createTempWorkspace();
	try {
		const baseA = numberedLines({ 5: "before-a" });
		const agentA = numberedLines({ 5: "agent-a" });
		const baseB = numberedLines({ 5: "before-b" });
		const agentB = numberedLines({ 5: "agent-b" });

		writeFileSync(join(cwd, "a.txt"), agentA, "utf8");
		writeFileSync(join(cwd, "b.txt"), agentB, "utf8");

		const mutations: WorkspaceMutation[] = [
			{ type: "patch", patch: unifiedPatch("b.txt", baseB, agentB), toolName: "edit" },
			{ type: "patch", patch: unifiedPatch("a.txt", baseA, agentA), toolName: "edit" },
		];

		writeFileSync(join(cwd, "b.txt"), numberedLines({ 5: "parallel-b" }), "utf8");
		const reverted = await revertWorkspaceMutations(cwd, mutations);

		assert.equal(reverted.ok, false);
		assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), agentA);
		assert.equal(readFileSync(join(cwd, "b.txt"), "utf8"), numberedLines({ 5: "parallel-b" }));
	} finally {
		cleanup();
	}
});

test("write tool mutations restore the previous file content or remove created files", async () => {
	const { cwd, cleanup } = createTempWorkspace();
	try {
		writeFileSync(join(cwd, "existing.txt"), "before\n", "utf8");

		const existingPreparation = prepareWorkspaceMutation(cwd, "write", { path: "existing.txt", content: "after\n" });
		writeFileSync(join(cwd, "existing.txt"), "after\n", "utf8");
		const existingMutation = workspaceMutationFromToolExecution({
			cwd,
			toolName: "write",
			args: { path: "existing.txt", content: "after\n" },
			details: undefined,
			isError: false,
			preparation: existingPreparation,
		});

		const createdPreparation = prepareWorkspaceMutation(cwd, "write", { path: "created.txt", content: "new\n" });
		writeFileSync(join(cwd, "created.txt"), "new\n", "utf8");
		const createdMutation = workspaceMutationFromToolExecution({
			cwd,
			toolName: "write",
			args: { path: "created.txt", content: "new\n" },
			details: undefined,
			isError: false,
			preparation: createdPreparation,
		});

		assert.ok(existingMutation);
		assert.ok(createdMutation);
		const reverted = await revertWorkspaceMutations(cwd, [existingMutation, createdMutation]);

		assert.equal(reverted.ok, true);
		assert.equal(readFileSync(join(cwd, "existing.txt"), "utf8"), "before\n");
		assert.throws(() => readFileSync(join(cwd, "created.txt"), "utf8"));
	} finally {
		cleanup();
	}
});

test("write mutation parsing accepts SDK Write args that use absolute file_path", async () => {
	const { cwd, cleanup } = createTempWorkspace();
	try {
		const absolutePath = join(cwd, "a.txt");
		const preparation = prepareWorkspaceMutation(cwd, "Write", { file_path: absolutePath, content: "hello\n" });
		assert.deepEqual(preparation, { type: "write", path: "a.txt" });

		writeFileSync(absolutePath, "hello\n", "utf8");
		assert.deepEqual(
			workspaceMutationFromToolExecution({
				cwd,
				toolName: "Write",
				args: { file_path: absolutePath, content: "hello\n" },
				details: undefined,
				isError: false,
				preparation,
			}),
			{ type: "write", path: "a.txt", afterContent: "hello\n", toolName: "Write" },
		);
	} finally {
		cleanup();
	}
});

test("workspace undo index load/save is resilient to missing and invalid files", () => {
	const { cwd, cleanup } = createTempWorkspace();
	try {
		assert.equal(workspaceUndoIndexKey(undefined, "session", "entry-1"), "entry-1");
		assert.deepEqual(loadWorkspaceUndoIndex(cwd), { version: 1, entries: {} });

		saveWorkspaceUndoIndex(cwd, { version: 1, entries: { "entry-1": [{ type: "write", path: "a.txt", afterContent: "next" }] } });
		assert.deepEqual(loadWorkspaceUndoIndex(cwd).entries["entry-1"], [{ type: "write", path: "a.txt", afterContent: "next" }]);

		writeFileSync(join(cwd, "pix", "workspace-undo", "index.json"), "{bad json", "utf8");
		assert.deepEqual(loadWorkspaceUndoIndex(cwd), { version: 1, entries: {} });

		writeFileSync(join(cwd, "pix", "workspace-undo", "index.json"), JSON.stringify({ version: 999, entries: {} }), "utf8");
		assert.deepEqual(loadWorkspaceUndoIndex(cwd), { version: 1, entries: {} });
	} finally {
		cleanup();
	}
});

test("mutation parsing rejects unsafe or no-op tool executions and accepts patch details", () => {
	const { cwd, cleanup } = createTempWorkspace();
	try {
		writeFileSync(join(cwd, "same.txt"), "same", "utf8");

		assert.equal(prepareWorkspaceMutation(cwd, "read", { path: "same.txt", content: "next" }), undefined);
		assert.equal(prepareWorkspaceMutation(cwd, "write", { path: "../outside.txt", content: "next" }), undefined);
		assert.equal(prepareWorkspaceMutation(cwd, "write", { path: "same.txt" }), undefined);

		const samePreparation = prepareWorkspaceMutation(cwd, "functions.write", { path: "same.txt", content: "same" });
		assert.equal(workspaceMutationFromToolExecution({ cwd, toolName: "functions.write", args: { path: "same.txt", content: "same" }, details: undefined, isError: false, preparation: samePreparation }), undefined);
		assert.equal(workspaceMutationFromToolExecution({ cwd, toolName: "write", args: { path: "same.txt", content: "changed" }, details: undefined, isError: true, preparation: samePreparation }), undefined);

		const patch = unifiedPatch("notes.txt", numberedLines({ 5: "before" }), numberedLines({ 5: "after" }));
		assert.deepEqual(workspaceMutationFromToolExecution({ cwd, toolName: "functions.apply_patch", args: {}, details: { diff: patch }, isError: false }), {
			type: "patch",
			patch: prefixedUnifiedPatch("notes.txt", numberedLines({ 5: "before" }), numberedLines({ 5: "after" })),
			toolName: "functions.apply_patch",
		});

		const absolutePatch = [
			`--- ${join(cwd, "absolute.txt")}`,
			`+++ ${join(cwd, "absolute.txt")}`,
			"@@ -1,1 +1,1 @@",
			"-before",
			"+after",
			"",
		].join("\n");
		assert.deepEqual(workspaceMutationFromToolExecution({ cwd, toolName: "Edit", args: {}, details: { patch: absolutePatch }, isError: false }), {
			type: "patch",
			patch: ["--- a/absolute.txt", "+++ b/absolute.txt", "@@ -1,1 +1,1 @@", "-before", "+after", ""].join("\n"),
			toolName: "Edit",
		});
		assert.equal(workspaceMutationFromToolExecution({ cwd, toolName: "apply_patch", args: { input: "not a patch" }, details: undefined, isError: false }), undefined);
	} finally {
		cleanup();
	}
});

test("write reverts refuse outside paths and changed content", async () => {
	const { cwd, cleanup } = createTempWorkspace();
	try {
		writeFileSync(join(cwd, "changed.txt"), "parallel", "utf8");
		const changed = await revertWorkspaceMutations(cwd, [{ type: "write", path: "changed.txt", beforeContent: "before", afterContent: "after" }]);
		assert.equal(changed.ok, false);
		assert.match(changed.ok ? "" : changed.error, /file content changed/u);

		const unsafe = await revertWorkspaceMutations(cwd, [{ type: "write", path: "../outside.txt", afterContent: "after" }]);
		assert.equal(unsafe.ok, false);
		assert.match(unsafe.ok ? "" : unsafe.error, /outside workspace/u);
	} finally {
		cleanup();
	}
});

function createTempWorkspace(): { cwd: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pix-workspace-undo-test-"));
	mkdirSync(join(root, "workspace"));
	return {
		cwd: join(root, "workspace"),
		cleanup: () => rmSync(root, { force: true, recursive: true }),
	};
}

function numberedLines(overrides: Record<number, string>): string {
	return Array.from({ length: 20 }, (_, index) => overrides[index + 1] ?? `line ${index + 1}`).join("\n") + "\n";
}

function unifiedPatch(path: string, before: string, after: string): string {
	return [
		`--- ${path}`,
		`+++ ${path}`,
		"@@ -1,20 +1,20 @@",
		...before.split("\n").slice(0, -1).map((line, index) => {
			const afterLine = after.split("\n")[index];
			return line === afterLine ? ` ${line}` : `-${line}\n+${afterLine}`;
		}),
		"",
	].join("\n");
}

function prefixedUnifiedPatch(path: string, before: string, after: string): string {
	return unifiedPatch(path, before, after).replace(`--- ${path}`, `--- a/${path}`).replace(`+++ ${path}`, `+++ b/${path}`);
}
