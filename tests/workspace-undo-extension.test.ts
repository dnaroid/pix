import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import workspaceUndoBridge, {
	WORKSPACE_MUTATION_ENTRY_TYPE,
	WORKSPACE_UNDO_RESULT_CHANNEL,
	WORKSPACE_UNDO_RPC_COMMAND,
	WORKSPACE_UNDO_RPC_ENV,
	workspaceMutationsAfterEntry,
} from "../src/bundled-extensions/workspace-undo/index.js";

type EventHandler = (event: any, ctx: any) => Promise<void> | void;
type CommandHandler = (args: string, ctx: any) => Promise<void> | void;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace undo ACP bridge", () => {
	it("records a session-scoped Write mutation and restores it after rewinding", async () => {
		const root = tempRoot();
		const path = join(root, "note.txt");
		writeFileSync(path, "before\n", "utf8");
		const bridge = loadBridge();

		await bridge.events.get("tool_execution_start")?.({
			type: "tool_execution_start",
			toolCallId: "write-1",
			toolName: "write",
			args: { path: "note.txt", content: "after\n" },
		}, mutationContext(root));
		writeFileSync(path, "after\n", "utf8");
		await bridge.events.get("tool_execution_end")?.({
			type: "tool_execution_end",
			toolCallId: "write-1",
			toolName: "write",
			result: {},
			isError: false,
		}, mutationContext(root));

		assert.equal(bridge.entries.length, 1);
		assert.equal(bridge.entries[0]?.customType, WORKSPACE_MUTATION_ENTRY_TYPE);
		const result = await runUndo(bridge, root);

		assert.equal(readFileSync(path, "utf8"), "before\n");
		assert.deepEqual(result, {
			requestId: "undo-1",
			status: "ok",
			revertedChanges: 1,
			changedFiles: 1,
		});
	});

	it("does not overwrite a file changed by another session after the recorded mutation", async () => {
		const root = tempRoot();
		const path = join(root, "shared.txt");
		writeFileSync(path, "session-a-before\n", "utf8");
		const bridge = loadBridge();

		await bridge.events.get("tool_execution_start")?.({
			type: "tool_execution_start",
			toolCallId: "write-a",
			toolName: "Write",
			args: { file_path: path, content: "session-a-after\n" },
		}, mutationContext(root));
		writeFileSync(path, "session-a-after\n", "utf8");
		await bridge.events.get("tool_execution_end")?.({
			type: "tool_execution_end",
			toolCallId: "write-a",
			toolName: "Write",
			result: {},
			isError: false,
		}, mutationContext(root));

		// Simulates another Pix session (or an editor) touching the same file
		// before Session A asks to undo its branch.
		writeFileSync(path, "session-b-newer\n", "utf8");
		const result = await runUndo(bridge, root);

		assert.equal(readFileSync(path, "utf8"), "session-b-newer\n");
		assert.equal(result.status, "warning");
		assert.match(result.error ?? "", /changed since the recorded command/u);
	});

	it("keeps the tool-start user as mutation owner when a later user message arrives", async () => {
		const root = tempRoot();
		const path = join(root, "owned.txt");
		writeFileSync(path, "before\n", "utf8");
		const bridge = loadBridge();

		await bridge.events.get("tool_execution_start")?.({
			type: "tool_execution_start",
			toolCallId: "write-owned",
			toolName: "write",
			args: { path: "owned.txt", content: "after\n" },
		}, mutationContext(root, ["user-1"]));
		writeFileSync(path, "after\n", "utf8");
		await bridge.events.get("tool_execution_end")?.({
			type: "tool_execution_end",
			toolCallId: "write-owned",
			toolName: "write",
			result: {},
			isError: false,
		}, mutationContext(root, ["user-1", "user-2"]));

		assert.deepEqual(bridge.entries[0]?.data, {
			userEntryId: "user-1",
			mutation: { type: "write", path: "owned.txt", beforeContent: "before\n", afterContent: "after\n", toolName: "write" },
		});
	});

	it("falls back to the legacy TUI undo index only when a user has no session mutation entries", () => {
		const sessionMutation = { type: "write" as const, path: "new.txt", afterContent: "new" };
		const legacySelected = { type: "write" as const, path: "old.txt", afterContent: "old" };
		const legacyLater = { type: "write" as const, path: "later.txt", afterContent: "later" };
		const branch = [
			{ id: "user-1", type: "message", message: { role: "user", content: "first" } },
			{ id: "user-2", type: "message", message: { role: "user", content: "second" } },
			{
				id: "mutation-2",
				type: "custom",
				customType: WORKSPACE_MUTATION_ENTRY_TYPE,
				data: { userEntryId: "user-2", mutation: sessionMutation },
			},
		];

		assert.deepEqual(workspaceMutationsAfterEntry(branch, "user-1", {
			"user-1": [legacySelected],
			"user-2": [legacyLater],
		}), [legacySelected, sessionMutation]);
	});
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pix-workspace-undo-extension-"));
	roots.push(root);
	return root;
}

function mutationContext(cwd: string, userEntryIds: string[] = ["user-1"]) {
	return {
		cwd,
		sessionManager: {
			getBranch: () => userEntryIds.map((id) => ({
				id,
				type: "message",
				message: { role: "user", content: [{ type: "text", text: id }] },
			})),
		},
	};
}

function loadBridge() {
	const previous = process.env[WORKSPACE_UNDO_RPC_ENV];
	process.env[WORKSPACE_UNDO_RPC_ENV] = "1";
	const events = new Map<string, EventHandler>();
	let command: CommandHandler | undefined;
	const entries: Array<{ customType: string; data: unknown }> = [];
	try {
		workspaceUndoBridge({
			on: (name: string, handler: EventHandler) => { events.set(name, handler); },
			registerCommand: (name: string, definition: { handler: CommandHandler }) => {
				assert.equal(name, WORKSPACE_UNDO_RPC_COMMAND);
				command = definition.handler;
			},
			appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
		} as any);
	} finally {
		if (previous === undefined) delete process.env[WORKSPACE_UNDO_RPC_ENV];
		else process.env[WORKSPACE_UNDO_RPC_ENV] = previous;
	}
	assert.ok(command);
	return { events, command, entries };
}

async function runUndo(
	bridge: ReturnType<typeof loadBridge>,
	cwd: string,
): Promise<{ requestId: string; status: string; revertedChanges?: number; changedFiles?: number; error?: string }> {
	let result: { requestId: string; status: string; revertedChanges?: number; changedFiles?: number; error?: string } | undefined;
	const branch = [
		{ id: "user-1", type: "message", message: { role: "user", content: [{ type: "text", text: "change it" }] } },
		...bridge.entries.map((entry, index) => ({
			id: `mutation-${index}`,
			type: "custom",
			customType: entry.customType,
			data: entry.data,
		})),
	];
	await bridge.command(JSON.stringify({ requestId: "undo-1", targetEntryId: "user-1" }), {
		cwd,
		sessionManager: { getBranch: () => branch },
		navigateTree: async (targetEntryId: string) => {
			assert.equal(targetEntryId, "user-1");
			return { cancelled: false };
		},
		ui: {
			setWidget: (key: string, lines: string[]) => {
				assert.equal(key, "pix.session-state");
				assert.equal(lines[0], WORKSPACE_UNDO_RESULT_CHANNEL);
				result = JSON.parse(lines[1] ?? "null") as typeof result;
			},
		},
	});
	assert.ok(result);
	return result;
}
