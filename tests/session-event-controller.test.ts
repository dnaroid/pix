import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppSessionEventController } from "../src/app/session/session-event-controller.js";
import type { Entry } from "../src/app/types.js";
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

describe("AppSessionEventController", () => {
	function createController(entries: Entry[] = []): AppSessionEventController {
		return new AppSessionEventController({
			entries,
			runtime: () => ({ session: { isStreaming: false } }) as AgentSessionRuntime,
			conversationViewport: () => ({ deleteEntry: () => {} }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			prepareWorkspaceMutation: () => undefined,
			workspaceMutationFromToolExecution: () => undefined,
			recordWorkspaceMutationForUserEntry: () => {},
			scheduleUserSessionEntryMetadataSync: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			showToast: () => {},
		});
	}

	it("refreshes session status when session info changes", () => {
		const session = {
			sessionName: "Renamed session",
		} as AgentSession;
		const runtime = { session } as AgentSessionRuntime;
		let statusSession: AgentSession | undefined;
		let scheduledRenderCount = 0;
		const controller = new AppSessionEventController({
			entries: [] satisfies Entry[],
			runtime: () => runtime,
			conversationViewport: () => ({ deleteEntry: () => {} }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {
				scheduledRenderCount += 1;
			},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: (updatedSession) => {
				statusSession = updatedSession;
			},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			prepareWorkspaceMutation: () => undefined,
			workspaceMutationFromToolExecution: () => undefined,
			recordWorkspaceMutationForUserEntry: () => {},
			scheduleUserSessionEntryMetadataSync: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			showToast: () => {},
		});

		controller.handleSessionEvent({ type: "session_info_changed", name: "Renamed session" } satisfies AgentSessionEvent);

		assert.equal(statusSession, session);
		assert.equal(scheduledRenderCount, 1);
	});

	it("observes successful todo tool results for the todo widget controller", () => {
		const observed: unknown[] = [];
		const controller = new AppSessionEventController({
			entries: [] satisfies Entry[],
			runtime: () => ({ session: { isStreaming: false } }) as AgentSessionRuntime,
			conversationViewport: () => ({ deleteEntry: () => {} }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			prepareWorkspaceMutation: () => undefined,
			workspaceMutationFromToolExecution: () => undefined,
			recordWorkspaceMutationForUserEntry: () => {},
			scheduleUserSessionEntryMetadataSync: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: (_toolName, details, isError) => {
				observed.push({ details, isError });
			},
			showToast: () => {},
		});
		const details = {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Ship", status: "pending" }],
		};

		controller.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "todo",
			result: { content: [], details },
			isError: false,
		} as unknown as AgentSessionEvent);

		assert.deepEqual(observed, [{ details, isError: false }]);
	});

	it("updates an existing tool entry when update and end events arrive", () => {
		const entries: Entry[] = [];
		const observedSubagents: Array<{ toolName: string; details: unknown }> = [];
		const observedTodo: Array<{ toolName: string; details: unknown; isError?: boolean }> = [];
		const controller = new AppSessionEventController({
			entries,
			runtime: () => ({ session: { isStreaming: false } }) as AgentSessionRuntime,
			conversationViewport: () => ({ deleteEntry: () => {} }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			prepareWorkspaceMutation: () => undefined,
			workspaceMutationFromToolExecution: () => undefined,
			recordWorkspaceMutationForUserEntry: () => {},
			scheduleUserSessionEntryMetadataSync: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: (toolName, details) => {
				observedSubagents.push({ toolName, details });
			},
			observeTodoToolResult: (toolName, details, isError) => {
				observedTodo.push({ toolName, details, isError });
			},
			showToast: () => {},
		});

		controller.handleSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "shell",
			args: { command: "echo hello" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "shell",
			args: { command: "echo hello" },
			partialResult: { content: [{ type: "text", text: "partial" }], details: { progress: 50 } },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "shell",
			result: { content: [{ type: "text", text: "done" }], details: { finished: true } },
			isError: false,
		} as unknown as AgentSessionEvent);

		assert.equal(entries.filter((entry) => entry.kind === "tool").length, 1);
		assert.equal(entries[0]?.kind === "tool" ? entries[0].status : undefined, "done");
		assert.equal(entries[0]?.kind === "tool" ? entries[0].output : undefined, "done");
		assert.deepEqual(entries[0]?.kind === "tool" ? entries[0].details : undefined, { finished: true });
		assert.deepEqual(observedSubagents, [
			{ toolName: "shell", details: { progress: 50 } },
			{ toolName: "shell", details: { finished: true } },
		]);
		assert.deepEqual(observedTodo, [
			{ toolName: "shell", details: { progress: 50 }, isError: undefined },
			{ toolName: "shell", details: { finished: true }, isError: false },
		]);
	});

	it("starts a new assistant entry for text streamed after a tool call", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Before tool" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "shell",
			args: {},
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "shell",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "After tool" },
		} as unknown as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["assistant", "tool", "assistant"]);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "Before tool");
		assert.equal(entries[2]?.kind === "assistant" ? entries[2].text : undefined, "After tool");
	});

	it("holds whitespace-only assistant deltas until more text arrives", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "и" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: " " },
		} as unknown as AgentSessionEvent);

		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "и");

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "ломало" },
		} as unknown as AgentSessionEvent);

		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "и ломало");
	});

	it("flushes held assistant whitespace on final update", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "done" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: " " },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "done" },
		} as unknown as AgentSessionEvent);

		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "done ");
	});

	it("does not drop a visible assistant entry trailing space when flushing before tools", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Before" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: " " },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "shell",
			args: {},
		} as unknown as AgentSessionEvent);

		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "Before ");
		assert.equal(entries[1]?.kind, "tool");
	});

	it("bounds appended conversation entries by pruning the oldest edge", () => {
		const entries: Entry[] = [];
		const deletedEntryIds: string[] = [];
		const controller = new AppSessionEventController({
			entries,
			runtime: () => ({ session: { isStreaming: false } }) as AgentSessionRuntime,
			conversationViewport: () => ({ deleteEntry: (entryId: string) => { deletedEntryIds.push(entryId); } }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			prepareWorkspaceMutation: () => undefined,
			workspaceMutationFromToolExecution: () => undefined,
			recordWorkspaceMutationForUserEntry: () => {},
			scheduleUserSessionEntryMetadataSync: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			showToast: () => {},
		});

		for (let index = 0; index < 361; index += 1) {
			controller.addEntry({ id: `entry-${index}`, kind: "assistant", text: `entry ${index}` });
		}

		assert.equal(entries.length, 300);
		assert.equal(entries[0]?.id, "entry-61");
		assert.equal(entries[entries.length - 1]?.id, "entry-360");
		assert.ok(deletedEntryIds.includes("entry-0"));
	});

	it("bounds prepended older history by pruning the newest edge", () => {
		const entries: Entry[] = Array.from({ length: 300 }, (_, index) => ({ id: `entry-${index}`, kind: "assistant", text: `entry ${index}` }));
		const controller = createController(entries);

		(controller as unknown as { prependEntries(entries: readonly Entry[]): void }).prependEntries(
			Array.from({ length: 61 }, (_, index) => ({ id: `older-${index}`, kind: "assistant", text: `older ${index}` })),
		);

		assert.equal(entries.length, 300);
		assert.equal(entries[0]?.id, "older-0");
		assert.equal(entries[60]?.id, "older-60");
		assert.equal(entries[entries.length - 1]?.id, "entry-238");
	});

	it("buffers split dcp metadata markers so suffix chunks do not leak", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "[d" },
		} as unknown as AgentSessionEvent);
		assert.equal(entries.length, 0);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "cp-id]: # (m051)\n" },
		} as unknown as AgentSessionEvent);
		assert.equal(entries.length, 0);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "answer" },
		} as unknown as AgentSessionEvent);

		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "answer");
	});

	it("holds trailing partial dcp marker lines while continuing visible text", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "answer\n[dcp-block" },
		} as unknown as AgentSessionEvent);

		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "answer\n");

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "-id]: # (b4)\nnext" },
		} as unknown as AgentSessionEvent);

		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "answer\nnext");
	});

	it("records workspace mutations and user metadata from session events", () => {
		const entries: Entry[] = [];
		const preparedCalls: Array<{ toolName: string; args: unknown }> = [];
		const recordedMutations: Array<{ entryId: string; mutation: unknown }> = [];
		let metadataSyncCalls = 0;
		let currentRuntime: AgentSessionRuntime = { session: { isStreaming: false } } as AgentSessionRuntime;
		const controller = new AppSessionEventController({
			entries,
			runtime: () => currentRuntime,
			conversationViewport: () => ({ deleteEntry: () => {} }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			prepareWorkspaceMutation: (toolName, args) => {
				preparedCalls.push({ toolName, args });
				return { toolName, args } as never;
			},
			workspaceMutationFromToolExecution: ({ toolName, args, details, isError, preparation }) => ({
				toolName,
				args,
				details,
				isError,
				preparation,
			}) as never,
			recordWorkspaceMutationForUserEntry: (entryId, mutation) => {
				recordedMutations.push({ entryId, mutation });
			},
			scheduleUserSessionEntryMetadataSync: () => {
				metadataSyncCalls += 1;
			},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			showToast: () => {},
		});

		controller.handleSessionEvent({
			type: "message_start",
			message: { role: "user", content: "hello" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "shell",
			args: { command: "echo hello" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "shell",
			result: { content: [{ type: "text", text: "done" }], details: { changed: true } },
			isError: false,
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_end",
			message: { role: "user", content: "hello" },
		} as unknown as AgentSessionEvent);

		assert.equal(entries[0]?.kind, "user");
		assert.deepEqual(preparedCalls, [{ toolName: "shell", args: { command: "echo hello" } }]);
		assert.equal(recordedMutations.length, 1);
		assert.equal(recordedMutations[0]?.entryId, entries[0]?.id);
		assert.deepEqual(recordedMutations[0]?.mutation, {
			toolName: "shell",
			args: { command: "echo hello" },
			details: { changed: true },
			isError: false,
			preparation: { toolName: "shell", args: { command: "echo hello" } },
		});
		assert.equal(metadataSyncCalls, 2);
	});

	it("keeps the current user entry available when an assistant tool-call message ends before tool execution events", () => {
		const entries: Entry[] = [];
		const recordedMutations: Array<{ entryId: string; mutation: unknown }> = [];
		let metadataSyncCalls = 0;
		const controller = new AppSessionEventController({
			entries,
			runtime: () => ({ session: { isStreaming: false } }) as AgentSessionRuntime,
			conversationViewport: () => ({ deleteEntry: () => {} }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			prepareWorkspaceMutation: () => ({ type: "write", path: "a.txt" }),
			workspaceMutationFromToolExecution: () => ({ type: "write", path: "a.txt", afterContent: "hello\n" }),
			recordWorkspaceMutationForUserEntry: (entryId, mutation) => {
				recordedMutations.push({ entryId, mutation });
			},
			scheduleUserSessionEntryMetadataSync: () => {
				metadataSyncCalls += 1;
			},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			showToast: () => {},
		});

		controller.handleSessionEvent({
			type: "message_start",
			message: { role: "user", content: "создай a.txt" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_end",
			message: { role: "user", content: "создай a.txt" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "Write" }] },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "Write",
			args: { file_path: "/tmp/a.txt", content: "hello\n" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "Write",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		} as unknown as AgentSessionEvent);

		assert.equal(entries[0]?.kind, "user");
		assert.deepEqual(recordedMutations, [
			{
				entryId: entries[0]?.id,
				mutation: { type: "write", path: "a.txt", afterContent: "hello\n" },
			},
		]);
		assert.equal(metadataSyncCalls, 2);
	});

	it("schedules user metadata sync after a tool finishes even without a user message_end event", () => {
		const entries: Entry[] = [];
		let metadataSyncCalls = 0;
		const controller = new AppSessionEventController({
			entries,
			runtime: () => ({ session: { isStreaming: false } }) as AgentSessionRuntime,
			conversationViewport: () => ({ deleteEntry: () => {} }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			prepareWorkspaceMutation: () => ({ type: "write", path: "a.txt" }),
			workspaceMutationFromToolExecution: () => ({ type: "write", path: "a.txt", afterContent: "hello\n" }),
			recordWorkspaceMutationForUserEntry: () => {},
			scheduleUserSessionEntryMetadataSync: () => {
				metadataSyncCalls += 1;
			},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			showToast: () => {},
		});

		controller.handleSessionEvent({
			type: "message_start",
			message: { role: "user", content: "hello" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "Write",
			args: { file_path: "/tmp/a.txt", content: "hello\n" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "Write",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		} as unknown as AgentSessionEvent);

		assert.equal(metadataSyncCalls, 1);
	});

	it("adds a session aborted entry after clearing assistant state", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "partial assistant text" },
		} as unknown as AgentSessionEvent);
		controller.addSessionAbortedEntry();

		assert.deepEqual(entries.map((entry) => entry.kind), ["assistant", "session-aborted"]);
		assert.equal(entries[1]?.kind === "session-aborted" ? entries[1].text : undefined, "Session aborted.");
	});

	it("handles custom messages, assistant thinking, and compaction or retry outcomes", () => {
		const entries: Entry[] = [];
		const statuses: string[] = [];
		const activities: Array<"running" | "thinking" | "idle"> = [];
		const toasts: string[] = [];
		let queuedStatusUpdates = 0;
		const controller = new AppSessionEventController({
			entries,
			runtime: () => ({ session: { isStreaming: false, isCompacting: false } }) as AgentSessionRuntime,
			conversationViewport: () => ({ deleteEntry: () => {} }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: (status) => {
				statuses.push(status);
			},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: (activity) => {
				activities.push(activity);
			},
			updateQueuedMessageStatus: () => {
				queuedStatusUpdates += 1;
			},
			prepareWorkspaceMutation: () => undefined,
			workspaceMutationFromToolExecution: () => undefined,
			recordWorkspaceMutationForUserEntry: () => {},
			scheduleUserSessionEntryMetadataSync: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			showToast: (message, kind) => {
				toasts.push(`${kind}:${message}`);
			},
		});

		controller.handleSessionEvent({
			type: "message_start",
			message: { role: "custom", display: true, customType: "note", content: "custom note" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "answer" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "error", error: { errorMessage: "boom" }, reason: "fallback" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({ type: "queue_update" } as AgentSessionEvent);
		controller.handleSessionEvent({ type: "compaction_start", reason: "trim tree" } as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "compaction_end",
			result: { tokensBefore: 100, tokensAfter: 50 },
		} as AgentSessionEvent);
		controller.handleSessionEvent({ type: "compaction_end", aborted: true } as AgentSessionEvent);
		controller.handleSessionEvent({ type: "compaction_end", errorMessage: "failed" } as AgentSessionEvent);
		controller.handleSessionEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3 } as AgentSessionEvent);
		controller.handleSessionEvent({ type: "auto_retry_end", success: true } as AgentSessionEvent);
		controller.handleSessionEvent({ type: "auto_retry_end", success: false, finalError: "nope" } as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["custom", "thinking", "assistant", "error"]);
		assert.equal(entries[1]?.kind === "thinking" ? entries[1].status : undefined, "done");
		assert.equal(entries[2]?.kind === "assistant" ? entries[2].text : undefined, "answer");
		assert.equal(entries[3]?.kind === "error" ? entries[3].text : undefined, "boom");
		assert.equal(queuedStatusUpdates, 1);
		assert.deepEqual(statuses, ["compacting (trim tree)", "retry 2/3"]);
		assert.deepEqual(activities, ["thinking", "running", "idle", "running", "idle", "idle", "idle", "running", "idle", "idle"]);
		assert.deepEqual(toasts, [
			"success:Compacted 100 tokens",
			"info:Compaction cancelled",
			"error:failed",
			"success:Retry succeeded",
			"error:Retry failed: nope",
		]);
	});

});
