import type { InputEditor } from "../input-editor.js";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { createId } from "./id.js";
import { stringifyUnknown } from "./message-content.js";
import type { AppPopupActionController } from "./popup-action-controller.js";
import type { AppPopupMenuController } from "./popup-menu-controller.js";
import type { AppQueuedMessageController } from "./queued-message-controller.js";
import type { AppRequestHistory } from "./request-history.js";
import {
	bangShellCommandFromInput,
	formatShellCommandEntry,
	type InteractiveShellCommandResult,
} from "./shell-command.js";
import type { Entry, SessionActivity } from "./types.js";

const ABORT_STATUS_RESTORE_MS = 1200;

export type AppInputActionControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
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
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
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
	private abortInFlight = false;

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

		if (this.popupMenus.syncActivePopupMenu()) this.popupMenus.cancelActivePopupMenu();
	}

	private async abortStreamingSession(
		runtime: AgentSessionRuntime,
		options: { stopIfAlreadyAborting: boolean },
	): Promise<void> {
		const session = runtime.session;
		if (this.abortInFlight) {
			session.agent.abort();
			if (options.stopIfAlreadyAborting) await this.host.stop();
			else this.host.render();
			return;
		}

		this.abortInFlight = true;
		this.queuedMessages.restoreQueuedMessagesToEditorForAbort();
		this.host.setStatus("aborting");
		this.host.addSessionAbortedEntry();
		this.host.render();

		let restoreTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
			if (!this.abortInFlight || this.host.runtime()?.session !== session || !this.host.isRunning()) return;
			this.restoreSessionState(session);
			this.host.render();
		}, ABORT_STATUS_RESTORE_MS);
		restoreTimer.unref?.();

		try {
			session.agent.abort();
			await session.abort();
		} catch (error) {
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
		} finally {
			if (restoreTimer) clearTimeout(restoreTimer);
			restoreTimer = undefined;
			this.abortInFlight = false;
			this.restoreSessionState(this.host.runtime()?.session);
			if (this.host.isRunning()) this.host.render();
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
		await this.host.stopVoiceInput();

		const inputEditor = this.host.inputEditor();
		const rawPromptText = inputEditor.promptText;
		const rawDisplayText = inputEditor.expandedText;
		const promptText = rawPromptText.trimEnd();
		const displayText = rawDisplayText.trimEnd();
		const images = [...inputEditor.images];
		if (this.host.isShellCommandRunning()) {
			await this.submitShellInput(rawDisplayText, images.length);
			return;
		}
		if (!promptText && images.length === 0) return;
		const shellCommand = bangShellCommandFromInput(promptText);
		if (shellCommand !== undefined) {
			await this.submitShellCommand(shellCommand.command, displayText, images.length, shellCommand.interactive ? "interactive" : "chat");
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
		await this.host.clearPersistedInputDraft();
		this.host.render();

		try {
			await this.queuedMessages.submitUserMessage(message);
		} catch (error) {
			this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
		}

		if (this.host.isRunning()) this.host.render();
	}

	private async submitShellInput(text: string, imageCount: number): Promise<void> {
		if (imageCount > 0) {
			this.host.showToast("Shell stdin cannot include pasted images", "warning");
			this.host.render();
			return;
		}

		const inputEditor = this.host.inputEditor();
		inputEditor.clear();
		await this.host.clearPersistedInputDraft();
		if (!this.host.sendShellInput(text)) this.host.showToast("No shell command is waiting for input", "info");
		this.host.render();
	}

	private async submitShellCommand(command: string, displayText: string, imageCount: number, mode: "chat" | "interactive"): Promise<void> {
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

		const session = this.host.runtime()?.session;
		if (session?.isStreaming || session?.isCompacting) {
			this.host.showToast("Wait for the current session turn to finish before running shell commands", "info");
			this.host.render();
			return;
		}

		const inputEditor = this.host.inputEditor();
		this.host.requestHistory().add(displayText);
		inputEditor.clear();
		await this.host.clearPersistedInputDraft();
		this.host.setStatus(`shell: ${command}`);
		this.host.render();

		try {
			if (mode === "chat") {
				await this.host.runChatShellCommand(command);
			} else {
				const result = await this.host.runInteractiveShellCommand(command);
				const entryKind = result.error ? "error" : "system";
				this.host.addEntry({ id: createId(entryKind), kind: entryKind, text: formatShellCommandEntry(command, result, "!!") });
			}
		} catch (error) {
			this.host.addEntry({ id: createId("error"), kind: "error", text: `Shell command failed: ${stringifyUnknown(error)}` });
		} finally {
			this.restoreSessionState(this.host.runtime()?.session);
		}

		if (this.host.isRunning()) this.host.render();
	}
}
