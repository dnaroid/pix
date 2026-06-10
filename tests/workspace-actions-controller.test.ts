import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import { AppWorkspaceActionsController } from "../src/app/workspace/workspace-actions-controller.js";
import type { Entry } from "../src/app/types.js";

describe("AppWorkspaceActionsController undo changes", () => {
	it("reverts recorded mutations from the selected message onward and restores the prompt text", async () => {
		const { cwd, cleanup } = createTempWorkspace();
		try {
			writeFileSync(join(cwd, "first.txt"), "agent-first\n", "utf8");
			writeFileSync(join(cwd, "second.txt"), "agent-second\n", "utf8");

			const entries: Entry[] = [
				{
					id: "visible-1",
					kind: "user",
					text: "Original prompt",
					sessionEntryId: "session-1",
					workspaceMutations: [{ type: "write", path: "first.txt", beforeContent: "before-first\n", afterContent: "agent-first\n" }],
				},
				{
					id: "visible-2",
					kind: "user",
					text: "Follow-up prompt",
					sessionEntryId: "session-2",
					workspaceMutations: [{ type: "write", path: "second.txt", beforeContent: "before-second\n", afterContent: "agent-second\n" }],
				},
			];

			const branch = [
				messageEntry("session-1", null, "user", "Original prompt"),
				messageEntry("assistant-1", "session-1", "assistant", "Done"),
				messageEntry("session-2", "assistant-1", "user", "Follow-up prompt"),
			];

			const calls = { resetSessionView: 0, loadSessionHistory: 0, render: 0 };
			const addedEntries: Entry[] = [];
			const toasts: Array<{ message: string; kind: string }> = [];
			let input = "existing draft";

			const runtime = {
				cwd,
				session: {
					isStreaming: false,
					isCompacting: false,
					sessionFile: join(cwd, "session.jsonl"),
					sessionManager: { getBranch: () => branch, getSessionId: () => "session-id" },
					navigateTree: async (targetId: string) => {
						assert.equal(targetId, "session-1");
						return { cancelled: false, editorText: "Rewritten prompt" };
					},
				},
			} as unknown as AgentSessionRuntime;

			const controller = new AppWorkspaceActionsController({
				entries,
				runtime: () => runtime,
				findUserEntry: (entryId) => entries.find((entry): entry is Extract<Entry, { kind: "user" }> => entry.kind === "user" && entry.id === entryId),
				touchEntry: () => {},
				resetSessionView: () => {
					calls.resetSessionView += 1;
				},
				loadSessionHistory: () => {
					calls.loadSessionHistory += 1;
				},
				addEntry: (entry) => {
					addedEntries.push(entry);
				},
				setInput: (value) => {
					input = value;
				},
				getInput: () => input,
				setStatus: () => {},
				setSessionStatus: () => {},
				showToast: (message, kind) => {
					toasts.push({ message, kind });
				},
				render: () => {
					calls.render += 1;
				},
				isRunning: () => false,
				forkSessionEntryInNewTab: async () => false,
			});

			await controller.undoChangesFromUserMessage("visible-1");

			assert.equal(readFileSync(join(cwd, "first.txt"), "utf8"), "before-first\n");
			assert.equal(readFileSync(join(cwd, "second.txt"), "utf8"), "before-second\n");
			assert.equal(input, "Rewritten prompt");
			assert.equal(calls.resetSessionView, 1);
			assert.equal(calls.loadSessionHistory, 1);
			assert.equal(toasts[toasts.length - 1]?.kind, "success");
			const lastAddedEntry = addedEntries[addedEntries.length - 1];
			assert.match((lastAddedEntry?.kind === "system" ? lastAddedEntry.text : ""), /Reverted 2 commands across 2 files\./u);
		} finally {
			cleanup();
		}
	});

	it("still rewinds the session when no mutation log is available", async () => {
		const entries: Entry[] = [{ id: "visible-no-log", kind: "user", text: "Original prompt", sessionEntryId: "session-no-log" }];
		const addedEntries: Entry[] = [];
		const toasts: Array<{ message: string; kind: string }> = [];
		let input = "stale draft";

		const runtime = {
			cwd: "/tmp/workspace",
			session: {
				isStreaming: false,
				isCompacting: false,
				sessionFile: "/tmp/workspace/session.jsonl",
				sessionManager: {
					getBranch: () => [messageEntry("session-no-log", null, "user", "Original prompt")],
					getSessionId: () => "session-no-log-id",
				},
				navigateTree: async () => ({ cancelled: false, editorText: "Original prompt" }),
			},
		} as unknown as AgentSessionRuntime;

		const controller = new AppWorkspaceActionsController({
			entries,
			runtime: () => runtime,
			findUserEntry: (entryId) => entries.find((entry): entry is Extract<Entry, { kind: "user" }> => entry.kind === "user" && entry.id === entryId),
			touchEntry: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			addEntry: (entry) => {
				addedEntries.push(entry);
			},
			setInput: (value) => {
				input = value;
			},
			getInput: () => input,
			setStatus: () => {},
			setSessionStatus: () => {},
			showToast: (message, kind) => {
				toasts.push({ message, kind });
			},
			render: () => {},
			isRunning: () => false,
			forkSessionEntryInNewTab: async () => false,
		});

		await controller.undoChangesFromUserMessage("visible-no-log");

		assert.equal(input, "Original prompt");
		assert.equal(toasts[toasts.length - 1]?.kind, "warning");
		const lastAddedEntry = addedEntries[addedEntries.length - 1];
		assert.match((lastAddedEntry?.kind === "system" ? lastAddedEntry.text : ""), /No recorded file mutations were available/u);
	});

	it("assigns the user session entry id while recording a mutation for a fresh user message", () => {
		const entries: Entry[] = [{ id: "visible-1", kind: "user", text: "Original prompt", workspaceMutations: [] }];

		const runtime = {
			cwd: "/tmp/workspace",
			session: {
				isStreaming: false,
				isCompacting: false,
				sessionFile: "/tmp/workspace/session.jsonl",
				sessionManager: {
					getBranch: () => [messageEntry("session-1", null, "user", "Original prompt")],
					getSessionId: () => "session-id",
				},
			},
		} as unknown as AgentSessionRuntime;

		const controller = new AppWorkspaceActionsController({
			entries,
			runtime: () => runtime,
			findUserEntry: (entryId) => entries.find((entry): entry is Extract<Entry, { kind: "user" }> => entry.kind === "user" && entry.id === entryId),
			touchEntry: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			addEntry: () => {},
			setInput: () => {},
			getInput: () => "",
			setStatus: () => {},
			setSessionStatus: () => {},
			showToast: () => {},
			render: () => {},
			isRunning: () => false,
			forkSessionEntryInNewTab: async () => false,
		});

		controller.recordWorkspaceMutationForUserEntry("visible-1", {
			type: "write",
			path: "created.txt",
			afterContent: "hello\n",
		});

		assert.equal(entries[0]?.kind === "user" ? entries[0].sessionEntryId : undefined, "session-1");
		assert.deepEqual(entries[0]?.kind === "user" ? entries[0].workspaceMutations : undefined, [
			{ type: "write", path: "created.txt", afterContent: "hello\n" },
		]);
	});
});

function createTempWorkspace(): { cwd: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pix-workspace-actions-test-"));
	mkdirSync(join(root, "workspace"));
	return {
		cwd: join(root, "workspace"),
		cleanup: () => rmSync(root, { force: true, recursive: true }),
	};
}

function messageEntry(id: string, parentId: string | null, role: "user" | "assistant", content: string) {
	return { type: "message", id, parentId, message: { role, content } };
}
