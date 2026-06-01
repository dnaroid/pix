import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	prepareWorkspaceMutation,
	revertWorkspaceMutations,
	workspaceMutationFromToolExecution,
	type WorkspaceMutation,
} from "../src/app/workspace-undo.js";

test("revertWorkspaceMutations applies recorded patches bottom-up and preserves unrelated files", () => {
	const { cwd, cleanup } = createTempWorkspace();
	try {
		writeFileSync(join(cwd, "notes.txt"), numberedLines({ 5: "before" }), "utf8");
		writeFileSync(join(cwd, "notes.txt"), numberedLines({ 5: "agent" }), "utf8");
		writeFileSync(join(cwd, "parallel.txt"), "keep me\n", "utf8");

		const reverted = revertWorkspaceMutations(cwd, [
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

test("revertWorkspaceMutations rolls back earlier undo steps when a later command conflicts", () => {
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
		const reverted = revertWorkspaceMutations(cwd, mutations);

		assert.equal(reverted.ok, false);
		assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), agentA);
		assert.equal(readFileSync(join(cwd, "b.txt"), "utf8"), numberedLines({ 5: "parallel-b" }));
	} finally {
		cleanup();
	}
});

test("write tool mutations restore the previous file content or remove created files", () => {
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
		const reverted = revertWorkspaceMutations(cwd, [existingMutation, createdMutation]);

		assert.equal(reverted.ok, true);
		assert.equal(readFileSync(join(cwd, "existing.txt"), "utf8"), "before\n");
		assert.throws(() => readFileSync(join(cwd, "created.txt"), "utf8"));
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
