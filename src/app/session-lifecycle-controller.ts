import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	ExtensionCommandContextActions,
	ExtensionError,
} from "@earendil-works/pi-coding-agent";
import type { InputEditor } from "../input-editor.js";
import { createId } from "./id.js";
import { stringifyUnknown } from "./message-content.js";
import { collectStartupAvailabilityIssues } from "./startup-checks.js";
import { createStartupInfoMessage, isEmptyStartupSession } from "./startup-info.js";
import type { AppOptions, Entry, PixExtensionUIContext, SessionActivity } from "./types.js";

export type AppSessionLifecycleHost = {
	options: AppOptions;
	createRuntime(): Promise<AgentSessionRuntime>;
	entries: Entry[];
	runtime(): AgentSessionRuntime | undefined;
	setRuntime(runtime: AgentSessionRuntime | undefined): void;
	isRunning(): boolean;
	setRunning(running: boolean): void;
	inputText(): string;
	setInput(value: string): void;
	inputEditor(): InputEditor;
	enableTerminal(): void;
	disposeRuntimeForQuit(runtime: AgentSessionRuntime): Promise<void>;
	loadRequestHistory(): Promise<void>;
	startSubagentsPolling(): void;
	closeSdkMenuForBind(): void;
	clearExtensionWidgets(): void;
	createExtensionUIContext(): PixExtensionUIContext;
	extensionShutdownHandler(): () => void;
	createExtensionCommandContextActions(runtime: AgentSessionRuntime): ExtensionCommandContextActions;
	handleExtensionError(error: ExtensionError): void;
	handleSessionEvent(event: AgentSessionEvent): void;
	addEntry(entry: Entry): void;
	setStatus(status: string): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	setSessionStatus(session: AgentSession | undefined): void;
	setSessionActivity(activity: SessionActivity): void;
	sessionEventsReset(): void;
	resetSubagentsWidget(): void;
	resetTodoWidget(): void;
	conversationViewportClear(): void;
	queuedMessagesReset(): void;
	resetConversationMenuState(): void;
	clearMouseRenderState(): void;
	scrollReset(): void;
	loadSessionHistoryEntries(): void;
	syncUserSessionEntryMetadata(): void;
	restoreTabsAfterStartup(): Promise<void>;
	render(): void;
};

export class AppSessionLifecycleController {
	private unsubscribe: (() => void) | undefined;

	constructor(private readonly host: AppSessionLifecycleHost) {}

	async start(): Promise<void> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("pi-ui-extend needs an interactive TTY");
		}

		this.host.enableTerminal();
		await this.host.loadRequestHistory();
		this.host.setRunning(true);
		this.host.startSubagentsPolling();
		this.host.render();

		try {
			const runtime = await this.host.createRuntime();
			if (!this.host.isRunning()) {
				await this.host.disposeRuntimeForQuit(runtime);
				return;
			}

			this.host.setRuntime(runtime);
			runtime.setRebindSession(async () => {
				await this.bindCurrentSession();
			});
			await this.bindCurrentSession();
			if (isEmptyStartupSession(runtime)) {
				this.host.addEntry({ id: createId("system"), kind: "system", text: createStartupInfoMessage(runtime) });
			}
			await this.host.restoreTabsAfterStartup();

			const availabilityIssues = await collectStartupAvailabilityIssues(runtime);
			for (const issue of availabilityIssues) {
				this.host.addEntry({
					id: createId(issue.kind),
					kind: issue.kind === "error" ? "error" : "system",
					text: issue.message,
				});
			}
			if (availabilityIssues.some((issue) => issue.kind === "error")) {
				this.host.showToast("Startup dependency unavailable", "error");
			} else if (availabilityIssues.length > 0) {
				this.host.showToast("Startup dependency warning", "warning");
			}

			if (runtime.modelFallbackMessage) {
				this.host.addEntry({ id: createId("system"), kind: "system", text: runtime.modelFallbackMessage });
			}
			for (const diag of runtime.diagnostics ?? []) {
				const kind = diag.type === "error" ? "error" as const : "system" as const;
				this.host.addEntry({ id: createId("system"), kind, text: `[${diag.type}] ${diag.message}` });
			}
			this.host.setSessionStatus(runtime.session);
			this.host.setSessionActivity(runtime.session.isStreaming ? "running" : "idle");
			this.host.render();
	} catch (error) {
		this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
		this.host.showToast("Session startup failed", "error");
		this.host.setSessionStatus(undefined);
		this.host.render();
	}
}

	async bindCurrentSession(): Promise<void> {
		const runtime = this.requireRuntime();
		this.unsubscribe?.();
		this.host.closeSdkMenuForBind();
		this.host.clearExtensionWidgets();
		await runtime.session.bindExtensions({
			uiContext: this.host.createExtensionUIContext(),
			commandContextActions: this.host.createExtensionCommandContextActions(runtime),
			shutdownHandler: this.host.extensionShutdownHandler(),
			onError: (error) => this.host.handleExtensionError(error),
		});
		this.unsubscribe = runtime.session.subscribe((event) => {
			this.host.handleSessionEvent(event);
		});
	}

	unsubscribeSession(): void {
		this.unsubscribe?.();
	}

	afterSessionReplacement(message?: string): void {
		this.resetSessionView();
		this.loadSessionHistory();
		if (message) this.host.addEntry({ id: createId("system"), kind: "system", text: message });
		const session = this.host.runtime()?.session;
		this.host.setSessionStatus(session);
		this.host.setSessionActivity(session?.isStreaming ? "running" : "idle");
		this.host.render();
	}

	resetSessionView(): void {
		this.host.entries.length = 0;
		this.host.sessionEventsReset();
		this.host.resetSubagentsWidget();
		this.host.resetTodoWidget();
		this.host.conversationViewportClear();
		this.host.queuedMessagesReset();
		this.host.resetConversationMenuState();
		this.host.clearMouseRenderState();
		this.host.scrollReset();
	}

	loadSessionHistory(): void {
		this.host.loadSessionHistoryEntries();
		this.host.syncUserSessionEntryMetadata();
	}

	requireRuntime(): AgentSessionRuntime {
		const runtime = this.host.runtime();
		if (!runtime) throw new Error("Runtime is not initialized");
		return runtime;
	}
}
