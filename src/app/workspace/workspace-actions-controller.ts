import { getAgentDir, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { copyTextToClipboard } from "../screen/clipboard.js";
import { isRecord } from "../guards.js";
import { createId } from "../id.js";
import type { Entry } from "../types.js";
import {
	loadWorkspaceUndoIndex,
	prepareWorkspaceMutation,
	revertWorkspaceMutations,
	saveWorkspaceUndoIndex,
	workspaceMutationFromToolExecution,
	workspaceUndoIndexKey,
	type WorkspaceMutation,
	type WorkspaceMutationFromToolInput,
	type WorkspaceMutationPreparation,
} from "./workspace-undo.js";

export type AppWorkspaceActionsControllerHost = {
	readonly entries: Entry[];
	runtime(): AgentSessionRuntime | undefined;
	awaitCurrentSessionExtensions(runtime?: AgentSessionRuntime): Promise<void>;
	findUserEntry(entryId: string): Extract<Entry, { kind: "user" }> | undefined;
	touchEntry(entry: Entry): void;
	resetSessionView(): void;
	loadSessionHistory(): void;
	addEntry(entry: Entry): void;
	setInput(value: string): void;
	getInput(): string;
	setStatus(status: string): void;
	setSessionStatus(session: AgentSessionRuntime["session"] | undefined): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
	isRunning(): boolean;
	forkSessionEntryInNewTab(sessionEntryId: string): Promise<boolean>;
};

export class AppWorkspaceActionsController {
	private readonly workspaceUndoIndex = loadWorkspaceUndoIndex(getAgentDir());

	constructor(private readonly host: AppWorkspaceActionsControllerHost) {}

	prepareWorkspaceMutation(toolName: string, args: unknown): WorkspaceMutationPreparation | undefined {
		const runtime = this.host.runtime();
		return runtime ? prepareWorkspaceMutation(runtime.cwd, toolName, args) : undefined;
	}

	workspaceMutationFromToolExecution(
		input: Omit<WorkspaceMutationFromToolInput, "cwd">,
	): WorkspaceMutation | undefined {
		const runtime = this.host.runtime();
		return runtime ? workspaceMutationFromToolExecution({ cwd: runtime.cwd, ...input }) : undefined;
	}

	recordWorkspaceMutationForUserEntry(entryId: string, mutation: WorkspaceMutation): void {
		const entry = this.host.findUserEntry(entryId);
		if (!entry) return;

		entry.workspaceMutations = [...(entry.workspaceMutations ?? []), mutation];
		const sessionEntryId = this.resolveUserSessionEntryId(entry);
		if (sessionEntryId) this.persistWorkspaceMutations(sessionEntryId, entry.workspaceMutations);
		this.host.touchEntry(entry);
	}

	scheduleUserSessionEntryMetadataSync(): void {
		const timer = setTimeout(() => {
			this.syncUserSessionEntryMetadata();
			if (this.host.isRunning()) this.host.render();
		}, 0);
		timer.unref?.();
	}

	syncUserSessionEntryMetadata(): void {
		const runtime = this.host.runtime();
		if (!runtime) return;

		const branchUserEntries = runtime.session.sessionManager.getBranch().flatMap((sessionEntry) => {
			if (sessionEntry.type !== "message") return [];
			if (!isRecord(sessionEntry.message) || sessionEntry.message.role !== "user") return [];
			return [{ entryId: sessionEntry.id }];
		});
		if (branchUserEntries.length === 0) return;

		let branchIndex = 0;
		for (const entry of this.host.entries) {
			if (entry.kind !== "user") continue;

			const sessionEntry = branchUserEntries[branchIndex];
			branchIndex += 1;
			if (!sessionEntry) break;

			let changed = false;
			if (entry.sessionEntryId !== sessionEntry.entryId) {
				entry.sessionEntryId = sessionEntry.entryId;
				changed = true;
			}

			const hasPersistedMutations = this.hasWorkspaceMutationsForSessionEntry(sessionEntry.entryId);
			const persistedMutations = this.workspaceMutationsForSessionEntry(sessionEntry.entryId);
			if (!entry.workspaceMutations && hasPersistedMutations) {
				entry.workspaceMutations = persistedMutations;
				changed = true;
			}
			if (entry.workspaceMutations && (!hasPersistedMutations || !sameWorkspaceMutations(persistedMutations, entry.workspaceMutations))) {
				this.persistWorkspaceMutations(sessionEntry.entryId, entry.workspaceMutations);
			}

			if (changed) this.host.touchEntry(entry);
		}
	}

	async copyUserMessage(entryId: string): Promise<void> {
		const entry = this.host.findUserEntry(entryId);
		if (!entry) throw new Error("User message is no longer available");

		await copyTextToClipboard(entry.text);
		this.host.showToast("Message copied", "success");
		this.host.setSessionStatus(this.host.runtime()?.session);
	}

	async forkFromUserMessage(entryId: string): Promise<void> {
		const runtime = this.getIdleRuntimeForAction("fork");
		if (!runtime) return;

		const entry = this.host.findUserEntry(entryId);
		if (!entry) throw new Error("User message is no longer available");
		const sessionEntryId = this.resolveUserSessionEntryId(entry);
		if (!sessionEntryId) throw new Error("Session entry for this message is not available yet");

		this.host.setStatus("forking session");
		this.host.render();
		await this.host.awaitCurrentSessionExtensions(runtime);
		const result = await runtime.fork(sessionEntryId);
		if (result.cancelled) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Fork cancelled." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.resetSessionView();
		this.host.loadSessionHistory();
		if (result.selectedText) this.host.setInput(result.selectedText);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Forked from entry ${sessionEntryId}.` });
		this.host.setSessionStatus(runtime.session);
		this.host.showToast("Session forked", "success");
	}

	async forkFromUserMessageInNewTab(entryId: string): Promise<void> {
		const runtime = this.getIdleRuntimeForAction("fork in new tab");
		if (!runtime) return;

		const entry = this.host.findUserEntry(entryId);
		if (!entry) throw new Error("User message is no longer available");
		const sessionEntryId = this.resolveUserSessionEntryId(entry);
		if (!sessionEntryId) throw new Error("Session entry for this message is not available yet");

		await this.host.forkSessionEntryInNewTab(sessionEntryId);
	}

	async undoChangesFromUserMessage(entryId: string): Promise<void> {
		const runtime = this.getIdleRuntimeForAction("undo changes");
		if (!runtime) return;

		const entry = this.host.findUserEntry(entryId);
		if (!entry) throw new Error("User message is no longer available");
		const sessionEntryId = this.resolveUserSessionEntryId(entry);
		if (!sessionEntryId) throw new Error("Session entry for this message is not available yet");

		const mutationPlan = this.workspaceMutationPlanFromSessionEntry(sessionEntryId);

		this.host.setStatus("truncating session");
		this.host.render();
		const result = await runtime.session.navigateTree(sessionEntryId);
		if (result.aborted) {
			this.host.showToast("Undo cancelled", "info");
			this.host.setSessionStatus(runtime.session);
			return;
		}
		if (result.cancelled) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Undo cancelled." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.resetSessionView();
		this.host.loadSessionHistory();
		this.host.setInput(result.editorText ?? entry.text);

		let revertSummary = "No recorded file mutations were found for the removed branch.";
		let revertToastKind: "success" | "warning" = "success";
		if (mutationPlan.mutations.length > 0) {
			this.host.setStatus("reverting recorded commands");
			this.host.render();
			const reverted = await revertWorkspaceMutations(runtime.cwd, mutationPlan.mutations);
			if (reverted.ok) {
				revertSummary = `Reverted ${reverted.revertedChanges} command${reverted.revertedChanges === 1 ? "" : "s"} across ${reverted.changedFiles} file${reverted.changedFiles === 1 ? "" : "s"}.`;
			} else {
				revertSummary = `Workspace revert failed: ${reverted.error}`;
				revertToastKind = "warning";
			}
		} else if (mutationPlan.messagesWithoutLogs > 0) {
			revertSummary = `No recorded file mutations were available for ${mutationPlan.messagesWithoutLogs} removed message${mutationPlan.messagesWithoutLogs === 1 ? "" : "s"}.`;
			revertToastKind = "warning";
		}

		this.host.addEntry({
			id: createId("system"),
			kind: "system",
			text: `Undid changes from entry ${sessionEntryId}. ${revertSummary}`,
		});
		this.host.setSessionStatus(runtime.session);
		this.host.showToast(revertToastKind === "success" ? "Changes undone" : "Session rewound with revert warnings", revertToastKind);
	}

	private workspaceMutationPlanFromSessionEntry(entryId: string): { mutations: WorkspaceMutation[]; messagesWithoutLogs: number } {
		const runtime = this.host.runtime();
		if (!runtime) return { mutations: [], messagesWithoutLogs: 0 };

		const branch = runtime.session.sessionManager.getBranch();
		const startIndex = branch.findIndex((entry) => entry.id === entryId);
		if (startIndex < 0) {
			return this.workspaceMutationPlanForSingleEntry(entryId);
		}

		const mutations: WorkspaceMutation[] = [];
		let messagesWithoutLogs = 0;
		for (const branchEntry of branch.slice(startIndex)) {
			if (branchEntry.type !== "message") continue;
			if (!isRecord(branchEntry.message) || branchEntry.message.role !== "user") continue;

			const visibleEntry = this.findUserEntryBySessionEntryId(branchEntry.id);
			const hasMutationLog = visibleEntry?.workspaceMutations !== undefined || this.hasWorkspaceMutationsForSessionEntry(branchEntry.id);
			const entryMutations = visibleEntry?.workspaceMutations ?? this.workspaceMutationsForSessionEntry(branchEntry.id);
			if (!hasMutationLog) {
				messagesWithoutLogs += 1;
				continue;
			}

			mutations.push(...entryMutations);
		}

		return { mutations, messagesWithoutLogs };
	}

	private workspaceMutationPlanForSingleEntry(entryId: string): { mutations: WorkspaceMutation[]; messagesWithoutLogs: number } {
		const visibleEntry = this.findUserEntryBySessionEntryId(entryId);
		const hasMutationLog = visibleEntry?.workspaceMutations !== undefined || this.hasWorkspaceMutationsForSessionEntry(entryId);
		if (!hasMutationLog) return { mutations: [], messagesWithoutLogs: 1 };
		return { mutations: visibleEntry?.workspaceMutations ?? this.workspaceMutationsForSessionEntry(entryId), messagesWithoutLogs: 0 };
	}

	private findUserEntryBySessionEntryId(sessionEntryId: string): Extract<Entry, { kind: "user" }> | undefined {
		return this.host.entries.find(
			(entry): entry is Extract<Entry, { kind: "user" }> => entry.kind === "user" && entry.sessionEntryId === sessionEntryId,
		);
	}

	private resolveUserSessionEntryId(entry: Extract<Entry, { kind: "user" }>): string | undefined {
		if (!entry.sessionEntryId) this.syncUserSessionEntryMetadata();
		return entry.sessionEntryId;
	}

	private getIdleRuntimeForAction(actionName: string): AgentSessionRuntime | undefined {
		const runtime = this.host.runtime();
		if (!runtime) {
			this.host.addEntry({ id: createId("error"), kind: "error", text: "Runtime is not initialized" });
			this.host.showToast(`${actionName} unavailable`, "error");
			this.host.render();
			return undefined;
		}

		if (runtime.session.isStreaming) {
			this.host.showToast(`${actionName} is unavailable while the agent is running`, "warning");
			this.host.render();
			return undefined;
		}
		if (runtime.session.isCompacting) {
			this.host.showToast(`${actionName} is unavailable while compacting`, "warning");
			this.host.render();
			return undefined;
		}

		return runtime;
	}

	private workspaceMutationsForSessionEntry(entryId: string): WorkspaceMutation[] {
		const key = this.workspaceUndoIndexKey(entryId);
		return key ? (this.workspaceUndoIndex.entries[key] ?? []) : [];
	}

	private hasWorkspaceMutationsForSessionEntry(entryId: string): boolean {
		const key = this.workspaceUndoIndexKey(entryId);
		return key ? Object.prototype.hasOwnProperty.call(this.workspaceUndoIndex.entries, key) : false;
	}

	private persistWorkspaceMutations(entryId: string, mutations: readonly WorkspaceMutation[]): void {
		const key = this.workspaceUndoIndexKey(entryId);
		if (!key) return;
		if (mutations.length === 0) {
			if (!Object.prototype.hasOwnProperty.call(this.workspaceUndoIndex.entries, key)) return;
			delete this.workspaceUndoIndex.entries[key];
			try {
				saveWorkspaceUndoIndex(getAgentDir(), this.workspaceUndoIndex);
			} catch {
				// Undo persistence is best-effort; in-memory undo still works for this run.
			}
			return;
		}
		const hasExisting = Object.prototype.hasOwnProperty.call(this.workspaceUndoIndex.entries, key);
		if (hasExisting && sameWorkspaceMutations(this.workspaceUndoIndex.entries[key] ?? [], mutations)) return;

		this.workspaceUndoIndex.entries[key] = [...mutations];
		try {
			saveWorkspaceUndoIndex(getAgentDir(), this.workspaceUndoIndex);
		} catch {
			// Undo persistence is best-effort; in-memory undo still works for this run.
		}
	}

	private workspaceUndoIndexKey(entryId: string): string | undefined {
		const session = this.host.runtime()?.session;
		if (!session) return undefined;
		return workspaceUndoIndexKey(session.sessionFile, session.sessionManager.getSessionId(), entryId);
	}
}

function sameWorkspaceMutations(left: readonly WorkspaceMutation[], right: readonly WorkspaceMutation[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
