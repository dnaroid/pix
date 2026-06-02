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
			flushDeferredUserMessages: () => {},
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
			flushDeferredUserMessages: () => {},
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
			flushDeferredUserMessages: () => {},
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
});
