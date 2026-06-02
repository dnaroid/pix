import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "../../input-editor.js";
import { isOnlyHiddenMetadata } from "../../markdown-format.js";
import type { ConversationViewport } from "../rendering/conversation-viewport.js";
import { createId } from "../id.js";
import { extractImageContents, renderContent, renderUserMessageContent, stringifyUnknown } from "../rendering/message-content.js";
import { customMessageEntry, loadSessionHistoryEntries, loadSessionHistoryEntriesAsync } from "./session-history.js";
import type { Entry, SessionActivity } from "../types.js";
import { isRecord } from "../guards.js";
import type { WorkspaceMutation, WorkspaceMutationPreparation } from "../workspace/workspace-undo.js";

type ToolEntryUpdate = {
	toolName?: string;
	argsText?: string;
	output?: string;
	images?: ImageContent[];
	details?: unknown;
	isError?: boolean;
	status?: "running" | "done";
};

export type AppSessionEventControllerHost = {
	readonly entries: Entry[];
	runtime(): AgentSessionRuntime | undefined;
	conversationViewport(): ConversationViewport;
	isRunning(): boolean;
	render(): void;
	setStatus(status: string): void;
	restoreSessionStatus(): void;
	setSessionStatus(session: AgentSessionRuntime["session"] | undefined): void;
	setSessionActivity(activity: SessionActivity): void;
	flushDeferredUserMessages(): void;
	updateQueuedMessageStatus(): void;
	prepareWorkspaceMutation(toolName: string, args: unknown): WorkspaceMutationPreparation | undefined;
	recordWorkspaceMutationForUserEntry(entryId: string, mutation: WorkspaceMutation): void;
	workspaceMutationFromToolExecution(input: {
		toolName: string;
		args: unknown;
		details: unknown;
		isError: boolean;
		preparation?: WorkspaceMutationPreparation | undefined;
	}): WorkspaceMutation | undefined;
	scheduleUserSessionEntryMetadataSync(): void;
	toolDefaultExpanded(toolName: string): boolean;
	observeSubagentsToolResult(toolName: string, details: unknown, options?: { showSnapshot?: boolean }): void;
	observeTodoToolResult(toolName: string, details: unknown, isError?: boolean): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
};

export class AppSessionEventController {
	readonly entryRenderVersions = new Map<string, number>();

	private readonly toolEntryIdsByCallId = new Map<string, string>();
	private readonly toolMutationPreparationsByCallId = new Map<string, { userEntryId: string; args: unknown; preparation?: WorkspaceMutationPreparation }>();
	private currentUserEntryId: string | undefined;
	private currentAssistantEntryId: string | undefined;
	private currentThinkingEntryId: string | undefined;

	constructor(private readonly host: AppSessionEventControllerHost) {}

	reset(): void {
		this.toolEntryIdsByCallId.clear();
		this.toolMutationPreparationsByCallId.clear();
		this.currentUserEntryId = undefined;
		this.entryRenderVersions.clear();
		this.currentAssistantEntryId = undefined;
		this.currentThinkingEntryId = undefined;
	}

	loadSessionHistory(): void {
		const runtime = this.host.runtime();
		if (!runtime) return;

		loadSessionHistoryEntries({
			messages: runtime.session.messages,
			addEntry: (entry) => this.addEntry(entry),
			setToolEntryId: (toolCallId, entryId) => this.toolEntryIdsByCallId.set(toolCallId, entryId),
			toolDefaultExpanded: (toolName) => this.host.toolDefaultExpanded(toolName),
			observeSubagentsToolResult: (toolName, details, options) => this.host.observeSubagentsToolResult(toolName, details, options),
			observeTodoToolResult: (toolName, details, isError) => this.host.observeTodoToolResult(toolName, details, isError),
		});
	}

	async loadSessionHistoryAsync(options: { isCancelled: () => boolean; render: () => void }): Promise<boolean> {
		const runtime = this.host.runtime();
		if (!runtime) return !options.isCancelled();

		return loadSessionHistoryEntriesAsync({
			messages: runtime.session.messages,
			addEntry: (entry) => this.addEntry(entry),
			prependEntries: (entries) => this.prependEntries(entries),
			setToolEntryId: (toolCallId, entryId) => this.toolEntryIdsByCallId.set(toolCallId, entryId),
			toolDefaultExpanded: (toolName) => this.host.toolDefaultExpanded(toolName),
			observeSubagentsToolResult: (toolName, details, options) => this.host.observeSubagentsToolResult(toolName, details, options),
			observeTodoToolResult: (toolName, details, isError) => this.host.observeTodoToolResult(toolName, details, isError),
			isCancelled: options.isCancelled,
			render: options.render,
		});
	}

	handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "session_info_changed":
				this.host.setSessionStatus(this.host.runtime()?.session);
				break;
			case "message_start":
				this.handleMessageStart(event.message);
				break;
			case "message_end":
				this.handleMessageEnd(event.message);
				break;
			case "agent_start":
				this.host.setSessionActivity("running");
				this.host.setSessionStatus(this.host.runtime()?.session);
				this.host.flushDeferredUserMessages();
				break;
			case "thinking_level_changed":
				this.host.setSessionStatus(this.host.runtime()?.session);
				break;
			case "agent_end":
				this.finishCurrentThinkingEntry();
				this.clearCurrentAssistantState();
				this.currentUserEntryId = undefined;
				this.host.setSessionActivity("idle");
				this.host.setSessionStatus(this.host.runtime()?.session);
				this.host.flushDeferredUserMessages();
				break;
			case "queue_update":
				this.host.updateQueuedMessageStatus();
				break;
			case "message_update":
				this.handleMessageUpdate(event.assistantMessageEvent);
				break;
			case "tool_execution_start":
				this.finishCurrentThinkingEntry();
				this.currentAssistantEntryId = undefined;
				this.host.setSessionActivity("running");
				this.prepareToolWorkspaceMutation(event.toolCallId, event.toolName, event.args);
				this.upsertToolEntry(event.toolCallId, {
					toolName: event.toolName,
					argsText: stringifyUnknown(event.args),
					status: "running",
				});
				break;
			case "tool_execution_update":
				this.host.setSessionActivity("running");
				this.host.observeSubagentsToolResult(event.toolName, isRecord(event.partialResult) ? event.partialResult.details : undefined);
				this.host.observeTodoToolResult(event.toolName, isRecord(event.partialResult) ? event.partialResult.details : undefined);
				this.upsertToolEntry(event.toolCallId, {
					toolName: event.toolName,
					argsText: stringifyUnknown(event.args),
					output: renderContent(event.partialResult.content),
					images: extractImageContents(event.partialResult.content),
					...(isRecord(event.partialResult) && event.partialResult.details !== undefined ? { details: event.partialResult.details } : {}),
					status: "running",
				});
				break;
			case "tool_execution_end":
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				this.recordToolWorkspaceMutation(event.toolCallId, event.toolName, event.result.details, event.isError);
				this.host.observeSubagentsToolResult(event.toolName, isRecord(event.result) ? event.result.details : undefined);
				this.host.observeTodoToolResult(event.toolName, isRecord(event.result) ? event.result.details : undefined, event.isError);
				this.upsertToolEntry(event.toolCallId, {
					toolName: event.toolName,
					output: renderContent(event.result.content),
					images: extractImageContents(event.result.content),
					details: event.result.details,
					isError: event.isError,
					status: "done",
				});
				break;
			case "compaction_start":
				this.host.setSessionActivity("running");
				this.host.setStatus(`compacting (${event.reason})`);
				break;
			case "compaction_end": {
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				this.host.restoreSessionStatus();
				const message = event.result
					? `Compacted ${event.result.tokensBefore} tokens`
					: event.aborted
						? "Compaction cancelled"
						: event.errorMessage ?? "Compaction failed";
				this.host.showToast(message, event.result ? "success" : event.aborted ? "info" : "error");
				this.host.flushDeferredUserMessages();
				break;
			}
			case "auto_retry_start":
				this.host.setSessionActivity("running");
				this.host.setStatus(`retry ${event.attempt}/${event.maxAttempts}`);
				break;
			case "auto_retry_end":
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				this.host.restoreSessionStatus();
				this.host.showToast(
					event.success ? "Retry succeeded" : `Retry failed: ${event.finalError}`,
					event.success ? "success" : "error",
				);
				break;
			default:
				break;
		}
		this.host.render();
	}

	addCustomMessageEntry(message: Record<string, unknown>): void {
		const entry = customMessageEntry(message);
		if (entry) this.addEntry(entry);
	}

	findEntry(id: string): Entry | undefined {
		return this.host.entries.find((entry) => entry.id === id);
	}

	findUserEntry(id: string): Extract<Entry, { kind: "user" }> | undefined {
		const entry = this.findEntry(id);
		return entry?.kind === "user" ? entry : undefined;
	}

	touchEntry(entry: Entry): void {
		this.entryRenderVersions.set(entry.id, (this.entryRenderVersions.get(entry.id) ?? 0) + 1);
		this.host.conversationViewport().deleteEntry(entry.id);
	}

	addEntry(entry: Entry): void {
		this.host.entries.push(entry);
		this.entryRenderVersions.set(entry.id, 1);
		this.host.conversationViewport().deleteEntry(entry.id);
	}

	private prependEntries(entries: readonly Entry[]): void {
		this.host.entries.unshift(...entries);
		for (const entry of entries) {
			this.entryRenderVersions.set(entry.id, 1);
			this.host.conversationViewport().deleteEntry(entry.id);
		}
	}

	addSessionAbortedEntry(): void {
		this.finishCurrentThinkingEntry();
		this.clearCurrentAssistantState();
		this.addEntry({ id: createId("session-aborted"), kind: "session-aborted", text: "Session aborted." });
	}

	private handleMessageStart(message: unknown): void {
		if (isRecord(message) && message.role === "custom") {
			this.addCustomMessageEntry(message);
			return;
		}

		if (isRecord(message) && message.role === "user") {
			const text = renderUserMessageContent(message.content);
			if (!text) return;
			const images = extractImageContents(message.content);

			const entryId = createId("user");
			this.addEntry({
				id: entryId,
				kind: "user",
				text,
				workspaceMutations: [],
				...(images.length === 0 ? {} : { images }),
			});
			this.currentUserEntryId = entryId;
			return;
		}

		if (isRecord(message) && message.role === "assistant") this.clearCurrentAssistantState();
	}

	private handleMessageEnd(message: unknown): void {
		if (isRecord(message) && message.role === "user") {
			this.host.scheduleUserSessionEntryMetadataSync();
		}
		if (isRecord(message) && message.role === "assistant") {
			this.finishCurrentThinkingEntry();
			this.clearCurrentAssistantState();
			this.currentUserEntryId = undefined;
		}
	}

	private prepareToolWorkspaceMutation(toolCallId: string, toolName: string, args: unknown): void {
		const userEntryId = this.currentUserEntryId;
		if (!userEntryId) return;

		const preparation = this.host.prepareWorkspaceMutation(toolName, args);
		this.toolMutationPreparationsByCallId.set(toolCallId, {
			userEntryId,
			args,
			...(preparation === undefined ? {} : { preparation }),
		});
	}

	private recordToolWorkspaceMutation(toolCallId: string, toolName: string, details: unknown, isError: boolean): void {
		const prepared = this.toolMutationPreparationsByCallId.get(toolCallId);
		if (!prepared) return;
		this.toolMutationPreparationsByCallId.delete(toolCallId);

		const mutation = this.host.workspaceMutationFromToolExecution({
			toolName,
			args: prepared.args,
			details,
			isError,
			preparation: prepared.preparation,
		});
		if (!mutation) return;

		this.host.recordWorkspaceMutationForUserEntry(prepared.userEntryId, mutation);
	}

	private handleMessageUpdate(
		assistantEvent: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
	): void {
		switch (assistantEvent.type) {
			case "text_delta":
				this.finishCurrentThinkingEntry();
				this.host.setSessionActivity("running");
				this.appendAssistantText(assistantEvent.delta);
				break;
			case "thinking_delta":
				this.host.setSessionActivity("thinking");
				this.appendThinkingText(assistantEvent.delta);
				break;
			case "done":
				this.finishCurrentThinkingEntry();
				this.clearCurrentAssistantState();
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				break;
			case "error":
				this.finishCurrentThinkingEntry();
				this.host.setSessionActivity(this.host.runtime()?.session.isStreaming ? "running" : "idle");
				this.addEntry({ id: createId("error"), kind: "error", text: assistantEvent.error.errorMessage ?? assistantEvent.reason });
				break;
			default:
				break;
		}
	}

	private appendAssistantText(delta: string): void {
		let entry = this.currentAssistantEntryId ? this.findEntry(this.currentAssistantEntryId) : undefined;
		if (!entry || entry.kind !== "assistant") {
			entry = { id: createId("assistant"), kind: "assistant", text: "" };
			this.addEntry(entry);
			this.currentAssistantEntryId = entry.id;
		}
		entry.text += delta;

		if (isOnlyHiddenMetadata(entry.text)) {
			// Entire text is DCP markers or other hidden metadata — remove the entry to avoid layout flicker.
			const idx = this.host.entries.indexOf(entry);
			if (idx !== -1) this.host.entries.splice(idx, 1);
			this.entryRenderVersions.delete(entry.id);
			this.host.conversationViewport().deleteEntry(entry.id);
			this.currentAssistantEntryId = undefined;
			return;
		}

		this.touchEntry(entry);
	}

	private appendThinkingText(delta: string): void {
		let entry = this.currentThinkingEntryId ? this.findEntry(this.currentThinkingEntryId) : undefined;
		if (!entry || entry.kind !== "thinking") {
			entry = { id: createId("thinking"), kind: "thinking", text: "", expanded: false, status: "running" };
			this.addEntry(entry);
			this.currentThinkingEntryId = entry.id;
		}
		entry.status = "running";
		entry.text += delta;
		this.touchEntry(entry);
	}

	private finishCurrentThinkingEntry(): void {
		const entry = this.currentThinkingEntryId ? this.findEntry(this.currentThinkingEntryId) : undefined;
		if (entry?.kind === "thinking" && entry.status !== "done") {
			entry.status = "done";
			this.touchEntry(entry);
		}
		this.currentThinkingEntryId = undefined;
	}

	private upsertToolEntry(toolCallId: string, update: ToolEntryUpdate): void {
		const existingId = this.toolEntryIdsByCallId.get(toolCallId);
		const existing = existingId ? this.findEntry(existingId) : undefined;
		if (existing?.kind === "tool") {
			existing.toolName = update.toolName ?? existing.toolName;
			existing.argsText = update.argsText ?? existing.argsText;
			existing.output = update.output ?? existing.output;
			if ("images" in update) existing.images = update.images;
			if ("details" in update) existing.details = update.details;
			existing.isError = update.isError ?? existing.isError;
			existing.status = update.status ?? existing.status;
			this.touchEntry(existing);
			return;
		}

		const entry: Entry = {
			id: createId("tool"),
			kind: "tool",
			toolCallId,
			toolName: update.toolName ?? "tool",
			argsText: update.argsText ?? "{}",
			output: update.output ?? "",
			...(update.images === undefined ? {} : { images: update.images }),
			...("details" in update ? { details: update.details } : {}),
			expanded: this.host.toolDefaultExpanded(update.toolName ?? "tool"),
			isError: update.isError ?? false,
			status: update.status ?? "running",
		};
		this.toolEntryIdsByCallId.set(toolCallId, entry.id);
		this.addEntry(entry);
	}

	private clearCurrentAssistantState(): void {
		this.currentAssistantEntryId = undefined;
		this.currentThinkingEntryId = undefined;
	}
}
