import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadSessionHistoryEntriesAsync, type SessionHistoryOlderLoader } from "../src/app/session/session-history.js";
import type { Entry } from "../src/app/types.js";

describe("loadSessionHistoryEntriesAsync", () => {
	it("renders pix system custom messages as system entries", async () => {
		const entries: Entry[] = [];

		await loadSessionHistoryEntriesAsync({
			messages: [
				{ role: "custom", customType: "pix-system", display: true, content: "idx update completed" },
			],
			addEntry: (entry) => entries.push(entry),
			prependEntries: (newEntries) => entries.unshift(...newEntries),
			setToolEntryId: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			isCancelled: () => false,
			render: () => {},
		});

		assert.deepEqual(entries.map((entry) => ({ kind: entry.kind, text: entryText(entry) })), [
			{ kind: "system", text: "idx update completed" },
		]);
	});

	it("renders the tail first and prepends older entries in order", async () => {
		const entries: Entry[] = [];
		const snapshots: string[][] = [];

		const completed = await loadSessionHistoryEntriesAsync({
			messages: [
				{ role: "user", content: "old" },
				{ role: "assistant", content: [{ text: "middle" }] },
				{ role: "user", content: "tail" },
			],
			addEntry: (entry) => entries.push(entry),
			prependEntries: (newEntries) => entries.unshift(...newEntries),
			setToolEntryId: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			isCancelled: () => false,
			render: () => {
				snapshots.push(entries.map(entryText));
			},
			chunkSize: 1,
			tailMessageCount: 1,
		});

		assert.equal(completed, true);
		assert.deepEqual(snapshots[0], ["tail"]);
		assert.deepEqual(entries.map(entryText), ["old", "middle", "tail"]);
	});

	it("can keep older history lazy until the caller requests it", async () => {
		const entries: Entry[] = [];
		const snapshots: string[][] = [];
		let olderLoader: SessionHistoryOlderLoader | undefined;

		const completed = await loadSessionHistoryEntriesAsync({
			messages: [
				{ role: "user", content: "old" },
				{ role: "assistant", content: [{ text: "middle" }] },
				{ role: "user", content: "tail" },
			],
			addEntry: (entry) => entries.push(entry),
			prependEntries: (newEntries) => entries.unshift(...newEntries),
			setToolEntryId: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			isCancelled: () => false,
			render: () => {
				snapshots.push(entries.map(entryText));
			},
			chunkSize: 1,
			tailMessageCount: 1,
			lazyOlderHistory: true,
			onOlderLoaderReady: (loader) => {
				olderLoader = loader;
			},
		});

		assert.equal(completed, true);
		assert.deepEqual(snapshots, [["tail"]]);
		assert.deepEqual(entries.map(entryText), ["tail"]);
		assert.equal(olderLoader?.hasOlder(), true);

		assert.equal(await olderLoader?.loadOlder(), true);
		assert.deepEqual(entries.map(entryText), ["middle", "tail"]);

		assert.equal(await olderLoader?.loadOlder(), true);
		assert.deepEqual(entries.map(entryText), ["old", "middle", "tail"]);
		assert.equal(olderLoader, undefined);
	});

	it("does not split a trailing tool result from its assistant tool call", async () => {
		const entries: Entry[] = [];
		const snapshots: Array<Array<Pick<Entry, "kind"> & { output?: string }>> = [];

		await loadSessionHistoryEntriesAsync({
			messages: [
				{ role: "user", content: "old" },
				{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo hi" } }] },
				{ role: "toolResult", toolCallId: "call-1", toolName: "shell", content: [{ text: "hi" }], isError: false },
			],
			addEntry: (entry) => entries.push(entry),
			prependEntries: (newEntries) => entries.unshift(...newEntries),
			setToolEntryId: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			isCancelled: () => false,
			render: () => {
				snapshots.push(entries.map((entry) => ({ kind: entry.kind, ...(entry.kind === "tool" ? { output: entry.output } : {}) })));
			},
			chunkSize: 1,
			tailMessageCount: 1,
		});

		assert.deepEqual(snapshots[0], [{ kind: "tool", output: "hi" }]);
		assert.deepEqual(entries.map((entry) => entry.kind), ["user", "tool"]);
	});

	it("does not hydrate the current todo widget from historical todo tool results", async () => {
		const entries: Entry[] = [];
		let observedTodoResults = 0;

		await loadSessionHistoryEntriesAsync({
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", id: "todo-old", name: "todo", arguments: { action: "create" } }] },
				{
					role: "toolResult",
					toolCallId: "todo-old",
					toolName: "todo",
					content: [{ text: "Created 3 tasks" }],
					details: {
						action: "create",
						params: {},
						nextId: 4,
						tasks: [{ id: 1, subject: "Find color palette", status: "pending" }],
					},
					isError: false,
				},
				{ role: "user", content: "newer message" },
			],
			addEntry: (entry) => entries.push(entry),
			prependEntries: (newEntries) => entries.unshift(...newEntries),
			setToolEntryId: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {
				observedTodoResults += 1;
			},
			isCancelled: () => false,
			render: () => {},
			chunkSize: 1,
			tailMessageCount: 1,
		});

		assert.equal(observedTodoResults, 0);
		assert.deepEqual(entries.map((entry) => entry.kind), ["tool", "user"]);
	});

	it("marks historical subagent tool results as non-visual observations", async () => {
		const entries: Entry[] = [];
		const observedOptions: Array<{ showSnapshot?: boolean } | undefined> = [];

		await loadSessionHistoryEntriesAsync({
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", id: "subagents-old", name: "subagents", arguments: { action: "status" } }] },
				{
					role: "toolResult",
					toolCallId: "subagents-old",
					toolName: "subagents",
					content: [{ text: "old active snapshot" }],
					details: {
						runDir: "/repo/.pi/subagents/old-run",
						agents: [{ id: "agent-1", status: "running" }],
						mode: "status",
					},
					isError: false,
				},
				{ role: "user", content: "newer message" },
			],
			addEntry: (entry) => entries.push(entry),
			prependEntries: (newEntries) => entries.unshift(...newEntries),
			setToolEntryId: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: (_toolName, _details, options) => {
				observedOptions.push(options);
			},
			observeTodoToolResult: () => {},
			isCancelled: () => false,
			render: () => {},
			chunkSize: 1,
			tailMessageCount: 1,
		});

		assert.deepEqual(entries.map((entry) => entry.kind), ["tool", "user"]);
		assert.ok(observedOptions.length > 0);
		assert.ok(observedOptions.every((options) => options?.showSnapshot === false));
	});

	it("stops prepending history when cancelled", async () => {
		const entries: Entry[] = [];
		let cancelled = false;

		const completed = await loadSessionHistoryEntriesAsync({
			messages: [
				{ role: "user", content: "old" },
				{ role: "user", content: "new" },
			],
			addEntry: (entry) => entries.push(entry),
			prependEntries: (newEntries) => entries.unshift(...newEntries),
			setToolEntryId: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			isCancelled: () => cancelled,
			render: () => {
				cancelled = true;
			},
			chunkSize: 1,
			tailMessageCount: 1,
		});

		assert.equal(completed, false);
		assert.deepEqual(entries.map(entryText), ["new"]);
	});
});

function entryText(entry: Entry): string {
	return "text" in entry ? entry.text : "";
}
