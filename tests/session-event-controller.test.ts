import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppSessionEventController } from "../src/app/session/session-event-controller.js";
import type { Entry } from "../src/app/types.js";
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

describe("AppSessionEventController", () => {
	function createController(entries: Entry[] = [], runtime: AgentSessionRuntime = ({ session: { isStreaming: false } }) as AgentSessionRuntime): AppSessionEventController {
		return new AppSessionEventController({
			entries,
			runtime: () => runtime,
			conversationViewport: () => ({ deleteEntry: () => {} }) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			flushAutoUserMessages: () => {},
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

	it("moves a cursor over the full history window without pruned newer buffers", async () => {
		const entries: Entry[] = [];
		const branch = Array.from({ length: 430 }, (_value, index) => ({
			type: "message",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
			message: { role: "user", content: `message ${index}` },
		}));
		const controller = createController(entries, {
			session: {
				isStreaming: false,
				messages: [],
				sessionManager: { getBranch: () => branch },
			},
		} as unknown as AgentSessionRuntime);

		await controller.loadSessionHistoryAsync({
			isCancelled: () => false,
			render: () => {},
			lazyOlderHistory: true,
		});

		assert.deepEqual(entries.map(historyEntryText).slice(0, 2), ["message 130", "message 131"]);
		assert.equal(lastEntryText(entries), "message 429");

		assert.equal(await controller.loadOlderSessionHistory({ render: false }), true);

		assert.equal(controller.hasNewerSessionHistory(), true);
		assert.deepEqual(entries.map(historyEntryText).slice(0, 2), ["message 80", "message 81"]);
		assert.equal(lastEntryText(entries), "message 379");

		assert.equal(await controller.loadNewerSessionHistory({ render: false }), true);

		assert.deepEqual(entries.map(historyEntryText).slice(0, 2), ["message 130", "message 131"]);
		assert.equal(lastEntryText(entries), "message 429");
		assert.equal(controller.hasNewerSessionHistory(), false);
	});

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
			flushAutoUserMessages: () => {},
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
			flushAutoUserMessages: () => {},
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
			flushAutoUserMessages: () => {},
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

	for (const toolName of ["edit", "shell", "todo"] as const) {
		it(`marks a pending ${toolName} tool entry done when a toolResult message ends without a tool_execution_end event`, () => {
			const entries: Entry[] = [];
			const controller = createController(entries);

			controller.handleSessionEvent({
				type: "message_update",
				assistantMessageEvent: {
					type: "done",
					reason: "toolUse",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: { sample: true } }],
						stopReason: "toolUse",
					},
				},
			} as unknown as AgentSessionEvent);

			controller.handleSessionEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName,
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			} as unknown as AgentSessionEvent);

			assert.equal(entries.filter((entry) => entry.kind === "tool").length, 1);
			assert.equal(entries[0]?.kind === "tool" ? entries[0].status : undefined, "done");
			assert.equal(entries[0]?.kind === "tool" ? entries[0].output : undefined, "ok");
		});
	}

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
			flushAutoUserMessages: () => {},
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
		let measuredLineCountCalls = 0;
		const controller = new AppSessionEventController({
			entries,
			runtime: () => ({ session: { isStreaming: false } }) as AgentSessionRuntime,
			conversationViewport: () => ({
				deleteEntry: () => {},
				measuredLineCountForEntries: () => {
					measuredLineCountCalls += 1;
					return 1;
				},
			}) as never,
			isRunning: () => false,
			render: () => {},
			scheduleRender: () => {},
			setStatus: () => {},
			restoreSessionStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			updateQueuedMessageStatus: () => {},
			flushAutoUserMessages: () => {},
			prepareWorkspaceMutation: () => undefined,
			workspaceMutationFromToolExecution: () => undefined,
			recordWorkspaceMutationForUserEntry: () => {},
			scheduleUserSessionEntryMetadataSync: () => {},
			toolDefaultExpanded: () => false,
			observeSubagentsToolResult: () => {},
			observeTodoToolResult: () => {},
			showToast: () => {},
		});

		(controller as unknown as { prependEntries(entries: readonly Entry[]): void }).prependEntries(
			Array.from({ length: 61 }, (_, index) => ({ id: `older-${index}`, kind: "assistant", text: `older ${index}` })),
		);

		assert.equal(entries.length, 300);
		assert.equal(entries[0]?.id, "older-0");
		assert.equal(entries[60]?.id, "older-60");
		assert.equal(entries[entries.length - 1]?.id, "entry-238");
		assert.equal(measuredLineCountCalls, 0);
	});

	it("reconciles streamed assistant text from text_end so missing tail chunks are restored", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { role: "assistant", content: [] } },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "visible prefix", partial: { role: "assistant", content: [{ text: "visible prefix" }] } },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "visible prefix and restored suffix", partial: { role: "assistant", content: [{ text: "visible prefix and restored suffix" }] } },
		} as unknown as AgentSessionEvent);

		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "visible prefix and restored suffix");
	});

	it("reconciles an open assistant text block from the final done message", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: { role: "assistant", content: [] } },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "сделал" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "следующее" },
		} as unknown as AgentSessionEvent);

		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "сделалследующее");

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal" },
						{ type: "text", text: "сделал следующее" },
					],
				},
			},
		} as unknown as AgentSessionEvent);

		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "сделал следующее");
	});

	it("ignores late text_end for an assistant text block already flushed before a tool", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Before tool", partial: { role: "assistant", content: [{ type: "text", text: "Before tool" }] } },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: { role: "assistant", content: [{ type: "text", text: "Before tool" }, { type: "toolCall" }] },
			},
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Before tool", partial: { role: "assistant", content: [{ type: "text", text: "Before tool" }] } },
		} as unknown as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["assistant", "tool"]);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "Before tool");
	});

	it("creates pending tool entries from toolcall_end and reuses them for execution events", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Before tool" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } },
				partial: { role: "assistant", content: [] },
			},
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "shell",
			args: { command: "echo ok" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "shell",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		} as unknown as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["assistant", "tool"]);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "Before tool");
		assert.equal(entries[1]?.kind === "tool" ? entries[1].toolCallId : undefined, "call-1");
		assert.equal(entries[1]?.kind === "tool" ? entries[1].status : undefined, "done");
		assert.equal(entries[1]?.kind === "tool" ? entries[1].output : undefined, "ok");
	});

	it("shows tool calls while arguments are still streaming", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Before tool", partial: { role: "assistant", content: [{ type: "text", text: "Before tool" }] } },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: { role: "assistant", content: [{ type: "text", text: "Before tool" }, { type: "toolCall" }] },
			},
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 1,
				delta: "{\"command\":\"echo",
				partial: { role: "assistant", content: [{ type: "text", text: "Before tool" }, { type: "toolCall", name: "shell", arguments: { command: "echo" } }] },
			},
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } },
				partial: { role: "assistant", content: [{ type: "text", text: "Before tool" }, { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } }] },
			},
		} as unknown as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["assistant", "tool"]);
		assert.equal(entries[1]?.kind === "tool" ? entries[1].toolCallId : undefined, "call-1");
		assert.equal(entries[1]?.kind === "tool" ? entries[1].toolName : undefined, "shell");
		assert.equal(entries[1]?.kind === "tool" ? entries[1].argsText.includes("echo ok") : undefined, true);
		assert.equal(entries[1]?.kind === "tool" ? entries[1].status : undefined, "running");
	});

	it("recovers missing streamed toolcall events from the final assistant message", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				reason: "toolUse",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/app.ts" } }],
					stopReason: "toolUse",
				},
			},
		} as unknown as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["tool"]);
		assert.equal(entries[0]?.kind === "tool" ? entries[0].toolCallId : undefined, "call-1");
		assert.equal(entries[0]?.kind === "tool" ? entries[0].toolName : undefined, "read");
		assert.equal(entries[0]?.kind === "tool" ? entries[0].status : undefined, "running");
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
			flushAutoUserMessages: () => {},
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
			flushAutoUserMessages: () => {},
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
			flushAutoUserMessages: () => {},
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

	it("ignores stale thinking updates after assistant text has started", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "final answer" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end", content: "thinking with late tail" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "late thinking delta" },
		} as unknown as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["thinking", "assistant"]);
		assert.equal(entries[0]?.kind === "thinking" ? entries[0].status : undefined, "done");
		assert.equal(entries[0]?.kind === "thinking" ? entries[0].text : undefined, "thinking");
		assert.equal(entries[1]?.kind === "assistant" ? entries[1].text : undefined, "final answer");
	});

	it("ignores thinking updates that arrive after the assistant message is closed", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "final answer" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "done" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end", content: "late thinking" },
		} as unknown as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["assistant"]);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "final answer");
	});

	it("does not render empty thinking signature blocks", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end", content: "" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "visible answer" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { type: "toolCall", id: "call-1", name: "shell", arguments: { command: "echo ok" } },
				partial: { role: "assistant", content: [] },
			},
		} as unknown as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["assistant", "tool"]);
		assert.equal(entries[0]?.kind === "assistant" ? entries[0].text : undefined, "visible answer");
		assert.equal(entries[1]?.kind === "tool" ? entries[1].toolName : undefined, "shell");
	});

	it("keeps accumulated thinking when thinking_end carries only an empty signature block", () => {
		const entries: Entry[] = [];
		const controller = createController(entries);

		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "real reasoning" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end", content: "" },
		} as unknown as AgentSessionEvent);
		controller.handleSessionEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "answer" },
		} as unknown as AgentSessionEvent);

		assert.deepEqual(entries.map((entry) => entry.kind), ["thinking", "assistant"]);
		assert.equal(entries[0]?.kind === "thinking" ? entries[0].text : undefined, "real reasoning");
		assert.equal(entries[0]?.kind === "thinking" ? entries[0].status : undefined, "done");
		assert.equal(entries[1]?.kind === "assistant" ? entries[1].text : undefined, "answer");
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
			flushAutoUserMessages: () => {},
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

function historyEntryText(entry: Entry): string {
	return "text" in entry ? entry.text : "";
}

function lastEntryText(entries: readonly Entry[]): string | undefined {
	const entry = entries[entries.length - 1];
	return entry ? historyEntryText(entry) : undefined;
}
