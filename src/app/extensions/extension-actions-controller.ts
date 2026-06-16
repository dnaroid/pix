import type { AgentSessionRuntime, ExtensionCommandContextActions, ExtensionError } from "@earendil-works/pi-coding-agent";
import { createId } from "../id.js";
import type { Entry } from "../types.js";

export type AppExtensionActionsHost = {
	isRunning(): boolean;
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

export class AppExtensionActionsController {
	constructor(private readonly host: AppExtensionActionsHost) {}

	createCommandContextActions(runtime: AgentSessionRuntime): ExtensionCommandContextActions {
		return {
			waitForIdle: () => this.waitForSessionIdle(runtime),
			newSession: async (options) => {
				await this.host.awaitCurrentSessionExtensions(runtime);
				const result = await runtime.newSession(options);
				if (!result.cancelled) this.host.afterSessionReplacement("Started a new session.");
				return result;
			},
			fork: async (entryId, options) => {
				await this.host.awaitCurrentSessionExtensions(runtime);
				const result = await runtime.fork(entryId, options);
				if (!result.cancelled) this.host.afterSessionReplacement("Forked to a new session.");
				return result;
			},
			navigateTree: async (targetId, options) => {
				const result = await runtime.session.navigateTree(targetId, options);
				if (!result.cancelled && !result.aborted) {
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
				const result = await runtime.switchSession(sessionPath, options);
				if (!result.cancelled) this.host.afterSessionReplacement(`Switched session: ${sessionPath}`);
				return result;
			},
			reload: async () => {
				await this.host.awaitCurrentSessionExtensions(runtime);
				await runtime.session.reload();
				this.host.setSessionStatus(runtime.session);
				this.host.showToast("Reloaded resources", "success");
				this.host.render();
			},
		};
	}

	async waitForSessionIdle(runtime: AgentSessionRuntime): Promise<void> {
		while (runtime.session.isStreaming || runtime.session.isCompacting) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	handleExtensionError(error: ExtensionError): void {
	const pathText = error.extensionPath ? ` (${error.extensionPath})` : "";
	this.host.addEntry({ id: createId("error"), kind: "error", text: `Extension ${error.event} failed${pathText}: ${error.error}` });
	this.host.showToast(`Extension ${error.event} failed`, "error");
	if (this.host.isRunning()) this.host.render();
}
}
