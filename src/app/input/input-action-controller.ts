import type { InputEditor } from "../../input-editor.js";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { createId } from "../id.js";
import { stringifyUnknown } from "../rendering/message-content.js";
import type { AppPopupActionController } from "../popup/popup-action-controller.js";
import type { AppPopupMenuController } from "../popup/popup-menu-controller.js";
import type { AppQueuedMessageController } from "../session/queued-message-controller.js";
import type { AppRequestHistory } from "../session/request-history.js";
import {
	bangShellCommandFromInput,
	formatShellCommandEntry,
	type InteractiveShellCommandResult,
} from "../commands/shell-command.js";
import type { Entry, SessionActivity } from "../types.js";

const ABORT_STATUS_RESTORE_MS = 1200;

export type AppInputActionControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
	inputScopeKey?(): string | undefined;
	isRunning(): boolean;
	isSessionSwitching(): boolean;
	inputEditor(): InputEditor;
	requestHistory(): AppRequestHistory;
	clearPersistedInputDraft(): Promise<void>;
	setStatus(status: string): void;
	setSessionStatus(session: AgentSessionRuntime["session"] | undefined): void;
	setSessionActivity(activity: SessionActivity): void;
	addEntry(entry: Entry): void;
	addSessionAbortedEntry(): void;
	emitSessionAborted(): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	dismissActiveDialog?(): boolean;
	stopVoiceInput(): Promise<void>;
	isShellCommandRunning(): boolean;
	runChatShellCommand(command: string): Promise<InteractiveShellCommandResult>;
	sendShellInput(text: string): boolean;
	interruptShellCommand(): boolean;
	runInteractiveShellCommand(command: string): Promise<InteractiveShellCommandResult>;
	stop(): Promise<void>;
	render(): void;
};

export class AppInputActionController {
	private readonly abortsInFlight = new Set<AgentSessionRuntime["session"]>();

	constructor(
		private readonly host: AppInputActionControllerHost,
		private readonly popupMenus: AppPopupMenuController,
		private readonly popupActions: AppPopupActionController,
		private readonly queuedMessages: AppQueuedMessageController,
	) {}

	handleEnter(): void {
		if (this.popupMenus.syncActivePopupMenu()) {
			void this.popupActions.submitActivePopupMenu();
			return;
		}
		void this.submitInput();
	}

	async queueInputFromEditor(): Promise<void> {
		const inputScopeKey = this.host.inputScopeKey?.();
		await this.host.stopVoiceInput();
		if (this.host.inputScopeKey && this.host.inputScopeKey() !== inputScopeKey) return;

		if (this.popupMenus.syncActivePopupMenu()) this.popupMenus.cancelActivePopupMenu();

		const inputEditor = this.host.inputEditor();
		const rawPromptText = inputEditor.promptText;
		const rawDisplayText = inputEditor.expandedText;
		const promptText = rawPromptText.trimEnd();
		const displayText = rawDisplayText.trimEnd();
		const images = [...inputEditor.images];
		if (!promptText && images.length === 0) return;

		const message = this.queuedMessages.createSubmittedUserMessage(promptText, displayText, images);
		this.host.requestHistory().add(message.displayText);
		inputEditor.clear();
		this.queuedMessages.deferUserMessage(message);
		await this.host.clearPersistedInputDraft();
		if (this.host.isRunning()) this.host.render();
	}

	async handleInterrupt(): Promise<void> {
		if (this.host.interruptShellCommand()) {
			this.host.inputEditor().clear();
			await this.host.clearPersistedInputDraft();
			this.host.render();
			return;
		}

		const runtime = this.host.runtime();
		if (runtime?.session.isCompacting) {
			this.host.setStatus("aborting compaction");
			this.host.render();
			runtime.session.abortCompaction();
			return;
		}

		if (runtime?.session.isStreaming) {
			await this.abortStreamingSession(runtime, { stopIfAlreadyAborting: true });
			return;
		}
		await this.host.stop();
	}

	async handleEscape(): Promise<void> {
		if (this.closeActiveGlobalUi()) return;

		const session = this.host.runtime()?.session;
		if (session?.isCompacting) {
			this.host.setStatus("aborting compaction");
			this.host.render();
			session.abortCompaction();
			return;
		}

		if (session?.isStreaming) {
			const runtime = this.host.runtime();
			if (runtime) await this.abortStreamingSession(runtime, { stopIfAlreadyAborting: false });
			return;
		}

	}

	private closeActiveGlobalUi(): boolean {
		if (this.popupMenus.syncActivePopupMenu()) {
			this.popupMenus.cancelActivePopupMenu();
			return true;
		}

		return this.host.dismissActiveDialog?.() ?? false;
	}

	private async abortStreamingSession(
		runtime: AgentSessionRuntime,
		options: { stopIfAlreadyAborting: boolean },
	): Promise<void> {
		const session = runtime.session;
		// Relay the user-initiated abort to extensions (e.g. the terminal-bell
		// extension) so they can suppress the attention bell for this turn.
		this.host.emitSessionAborted();
		if (this.abortsInFlight.has(session)) {
			session.agent.abort();
			if (options.stopIfAlreadyAborting) await this.host.stop();
			else this.host.render();
			return;
		}

		this.abortsInFlight.add(session);
		this.queuedMessages.restoreQueuedMessagesToEditorForAbort();
		this.host.setStatus("aborting");
		this.host.addSessionAbortedEntry();
		this.host.render();

		let restoreTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
			if (!this.abortsInFlight.has(session) || this.host.runtime()?.session !== session || !this.host.isRunning()) return;
			this.restoreSessionState(session);
			this.host.render();
		}, ABORT_STATUS_RESTORE_MS);
		restoreTimer.unref?.();

		try {
			session.agent.abort();
			await session.abort();
		} catch (error) {
			if (this.host.runtime()?.session === session) {
				this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			} else {
				this.host.showToast(`Abort failed in a background tab: ${stringifyUnknown(error)}`, "error");
			}
		} finally {
			if (restoreTimer) clearTimeout(restoreTimer);
			restoreTimer = undefined;
			this.abortsInFlight.delete(session);
			if (this.host.runtime()?.session === session) {
				this.restoreSessionState(session);
				if (this.host.isRunning()) this.host.render();
			}
		}
	}

	private restoreSessionState(session: AgentSessionRuntime["session"] | undefined): void {
		this.host.setSessionStatus(session);
		this.host.setSessionActivity(this.sessionActivity(session));
	}

	private sessionActivity(session: AgentSessionRuntime["session"] | undefined): SessionActivity {
		return session?.isStreaming || session?.isCompacting ? "running" : "idle";
	}

	private async submitInput(): Promise<void> {
		const inputScopeKey = this.host.inputScopeKey?.();
		await this.host.stopVoiceInput();
		if (this.host.inputScopeKey && this.host.inputScopeKey() !== inputScopeKey) return;

		const runtime = this.host.runtime();
		const inputEditor = this.host.inputEditor();
		const rawPromptText = inputEditor.promptText;
		const rawDisplayText = inputEditor.expandedText;
		const promptText = rawPromptText.trimEnd();
		const displayText = rawDisplayText.trimEnd();
		const images = [...inputEditor.images];
		if (this.host.isShellCommandRunning()) {
			await this.submitShellInput(rawDisplayText, images.length, inputScopeKey);
			return;
		}
		if (!promptText && images.length === 0) return;
		const shellCommand = bangShellCommandFromInput(promptText);
		if (shellCommand !== undefined) {
			await this.submitShellCommand(shellCommand.command, displayText, images.length, shellCommand.interactive ? "interactive" : "chat", inputScopeKey);
			return;
		}
		if (this.host.isSessionSwitching()) {
			this.host.showToast("Wait for the tab to finish loading", "info");
			this.host.render();
			return;
		}
		if (promptText.startsWith("/")) {
			await this.popupActions.submitSlashCommand(promptText);
			return;
		}

		const message = this.queuedMessages.createSubmittedUserMessage(promptText, displayText, images);
		this.host.requestHistory().add(message.displayText);
		inputEditor.clear();
		const clearPersistedDraft = this.host.clearPersistedInputDraft();
		this.host.render();

		try {
			await this.queuedMessages.submitUserMessage(message, runtime?.session);
		} catch (error) {
			if (!runtime || this.host.runtime() === runtime) {
				this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
			} else {
				this.host.showToast(`Prompt failed in a background tab: ${stringifyUnknown(error)}`, "error");
			}
		}
		await clearPersistedDraft;

		if (this.host.isRunning()) this.host.render();
	}

	private async submitShellInput(text: string, imageCount: number, inputScopeKey: string | undefined): Promise<void> {
		if (imageCount > 0) {
			this.host.showToast("Shell stdin cannot include pasted images", "warning");
			this.host.render();
			return;
		}

		const inputEditor = this.host.inputEditor();
		inputEditor.clear();
		const clearPersistedDraft = this.host.clearPersistedInputDraft();
		const sent = this.host.sendShellInput(text);
		await clearPersistedDraft;
		if (!this.isInputScopeActive(inputScopeKey)) return;
		if (!sent) this.host.showToast("No shell command is waiting for input", "info");
		if (this.host.isRunning()) this.host.render();
	}

	private async submitShellCommand(
		command: string,
		displayText: string,
		imageCount: number,
		mode: "chat" | "interactive",
		inputScopeKey: string | undefined,
	): Promise<void> {
		if (!command) {
			this.host.showToast(`Enter a shell command after ${mode === "interactive" ? "!!" : "!"}`, "info");
			this.host.render();
			return;
		}
		if (imageCount > 0) {
			this.host.showToast("Shell commands cannot include pasted images", "warning");
			this.host.render();
			return;
		}
		if (this.host.isSessionSwitching()) {
			this.host.showToast("Wait for the tab to finish loading", "info");
			this.host.render();
			return;
		}

		const runtime = this.host.runtime();
		const session = runtime?.session;
		if (session?.isStreaming || session?.isCompacting) {
			this.host.showToast("Wait for the current session turn to finish before running shell commands", "info");
			this.host.render();
			return;
		}

		const inputEditor = this.host.inputEditor();
		this.host.requestHistory().add(displayText);
		inputEditor.clear();
		const clearPersistedDraft = this.host.clearPersistedInputDraft();
		this.host.setStatus(`shell: ${command}`);
		this.host.render();

		try {
			if (mode === "chat") {
				const result = this.host.runChatShellCommand(command);
				await clearPersistedDraft;
				await result;
			} else {
				const runningCommand = this.host.runInteractiveShellCommand(command);
				await clearPersistedDraft;
				const result = await runningCommand;
				if (!this.isSessionScopeActive(runtime, session, inputScopeKey)) return;
				const entryKind = result.error ? "error" : "system";
				this.host.addEntry({ id: createId(entryKind), kind: entryKind, text: formatShellCommandEntry(command, result, "!!") });
			}
		} catch (error) {
			await clearPersistedDraft;
			if (!this.isSessionScopeActive(runtime, session, inputScopeKey)) return;
			this.host.addEntry({ id: createId("error"), kind: "error", text: `Shell command failed: ${stringifyUnknown(error)}` });
		} finally {
			if (this.isSessionScopeActive(runtime, session, inputScopeKey)) this.restoreSessionState(session);
		}

		if (this.host.isRunning() && this.isSessionScopeActive(runtime, session, inputScopeKey)) this.host.render();
	}

	private isInputScopeActive(inputScopeKey: string | undefined): boolean {
		return !this.host.inputScopeKey || this.host.inputScopeKey() === inputScopeKey;
	}

	private isSessionScopeActive(
		runtime: AgentSessionRuntime | undefined,
		session: AgentSessionRuntime["session"] | undefined,
		inputScopeKey: string | undefined,
	): boolean {
		return this.isInputScopeActive(inputScopeKey) && this.host.runtime() === runtime && runtime?.session === session;
	}
}
