import { basename } from "node:path";
import type { AgentSessionRuntime, ExtensionCommandContextActions, ExtensionError } from "@earendil-works/pi-coding-agent";
import { createId } from "../id.js";
import { logPixEvent, type PixLogDetails, type PixLogLevel } from "../logger.js";
import type { Entry } from "../types.js";

export type AppExtensionActionsHost = {
	isRunning(): boolean;
	runtime(): AgentSessionRuntime | undefined;
	getInput(): string;
	setInput(value: string): void;
	awaitCurrentSessionExtensions(runtime?: AgentSessionRuntime): Promise<void>;
	resetSessionView(): void;
	loadSessionHistory(): void;
	afterSessionReplacement(message?: string): void;
	addEntry(entry: Entry): void;
	setStatus(status: string): void;
	setSessionStatus(runtime: AgentSessionRuntime["session"]): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
};

export type ExtensionErrorLogger = (level: PixLogLevel, event: string, details?: PixLogDetails) => void;

export class AppExtensionActionsController {
	constructor(
		private readonly host: AppExtensionActionsHost,
		private readonly logExtensionError: ExtensionErrorLogger = logPixEvent,
	) {}

	createCommandContextActions(runtime: AgentSessionRuntime): ExtensionCommandContextActions {
		return {
			waitForIdle: () => this.waitForSessionIdle(runtime),
			newSession: async (options) => {
				await this.host.awaitCurrentSessionExtensions(runtime);
				if (!this.isRuntimeActive(runtime)) return { cancelled: true };
				const result = await runtime.newSession(options);
				if (!result.cancelled && this.isRuntimeActive(runtime)) this.host.afterSessionReplacement("Started a new session.");
				return result;
			},
			fork: async (entryId, options) => {
				await this.host.awaitCurrentSessionExtensions(runtime);
				if (!this.isRuntimeActive(runtime)) return { cancelled: true };
				const result = await runtime.fork(entryId, options);
				if (!result.cancelled && this.isRuntimeActive(runtime)) this.host.afterSessionReplacement("Forked to a new session.");
				return result;
			},
			navigateTree: async (targetId, options) => {
				const session = runtime.session;
				const result = await session.navigateTree(targetId, options);
				if (!result.cancelled && !result.aborted && this.isSessionActive(runtime, session)) {
					this.host.resetSessionView();
					this.host.loadSessionHistory();
					if (result.editorText && !this.host.getInput().trim()) this.host.setInput(result.editorText);
					this.host.setSessionStatus(runtime.session);
					this.host.render();
				}
				return result;
			},
			switchSession: async (sessionPath, options) => {
				await this.host.awaitCurrentSessionExtensions(runtime);
				if (!this.isRuntimeActive(runtime)) return { cancelled: true };
				const result = await runtime.switchSession(sessionPath, options);
				if (!result.cancelled && this.isRuntimeActive(runtime)) this.host.afterSessionReplacement(`Switched session: ${sessionPath}`);
				return result;
			},
			reload: async () => {
				const session = runtime.session;
				await this.host.awaitCurrentSessionExtensions(runtime);
				if (!this.isSessionActive(runtime, session)) return;
				await session.reload();
				if (!this.isSessionActive(runtime, session)) return;
				this.host.setSessionStatus(session);
				this.host.showToast("Reloaded resources", "success");
				this.host.render();
			},
		};
	}

	async waitForSessionIdle(runtime: AgentSessionRuntime): Promise<void> {
		await runtime.session.waitForIdle();
	}

	private isRuntimeActive(runtime: AgentSessionRuntime): boolean {
		return this.host.isRunning() && this.host.runtime() === runtime;
	}

	private isSessionActive(runtime: AgentSessionRuntime, session: AgentSessionRuntime["session"]): boolean {
		return this.isRuntimeActive(runtime) && runtime.session === session;
	}

	handleExtensionError(error: ExtensionError): void {
		const sourceText = formatExtensionErrorSource(error.extensionPath);
		const pathText = error.extensionPath ? ` (${error.extensionPath})` : "";
		this.logExtensionError("error", "extension:error", extensionErrorLogDetails(error));
		this.host.addEntry({
			id: createId("error"),
			kind: "error",
			text: `Extension ${error.event} failed${sourceText}${pathText}: ${error.error}`,
		});
		this.host.showToast(`Extension ${error.event} failed`, "error");
		if (this.host.isRunning()) this.host.render();
	}
}

function formatExtensionErrorSource(extensionPath: string | undefined): string {
	if (!extensionPath) return "";
	const extensionName = basename(extensionPath);
	return extensionName && extensionName !== extensionPath ? ` [${extensionName}]` : "";
}

function extensionErrorLogDetails(error: ExtensionError): PixLogDetails {
	const details: PixLogDetails = {
		event: error.event,
		error: error.error,
	};
	if (error.extensionPath) {
		details.extensionPath = error.extensionPath;
		details.extensionName = basename(error.extensionPath);
	}
	if (error.stack) details.stack = error.stack;
	return details;
}
