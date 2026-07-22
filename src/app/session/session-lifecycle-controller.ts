import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	ExtensionCommandContextActions,
	ExtensionError,
} from "@earendil-works/pi-coding-agent";
import type { InputEditor } from "../../input-editor.js";
import { createId } from "../id.js";
import { stringifyUnknown } from "../rendering/message-content.js";
import { collectStartupAvailabilityIssues } from "../cli/startup-checks.js";
import type { AppOptions, Entry, PixExtensionUIContext, SessionActivity } from "../types.js";

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
	loadStartupConfig(): Promise<void>;
	loadRequestHistory(): Promise<void>;
	startSubagentsPolling(): void;
	closeSdkMenuForBind(): void;
	clearExtensionWidgets(scopeKey?: string, options?: { cancelCustomUi?: boolean }): void;
	createExtensionUIContext(scopeKey?: string): PixExtensionUIContext;
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
	loadSessionHistoryEntriesAsync(options: { isCancelled: () => boolean; render: () => void; lazyOlderHistory?: boolean }): Promise<boolean>;
	syncUserSessionEntryMetadata(): void;
	restoreTabsAfterStartup(): Promise<void>;
	render(): void;
};

export type BindCurrentSessionOptions = {
	awaitExtensions?: boolean;
};

export class AppSessionLifecycleController {
	private unsubscribe: (() => void) | undefined;
	private ownershipRuntime: AgentSessionRuntime | undefined;
	private ownershipSession: AgentSession | undefined;
	private ownershipGeneration = 0;
	private subscriptionGeneration = 0;
	private replacementHistoryGeneration = 0;
	private extensionBindPromise: Promise<void> | undefined;
	private extensionBindRuntime: AgentSessionRuntime | undefined;
	private extensionBindSession: AgentSession | undefined;
	private extensionBindOwnershipGeneration: number | undefined;

	constructor(private readonly host: AppSessionLifecycleHost) {}

	async start(): Promise<void> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("pi-ui-extend needs an interactive TTY");
		}

		this.host.enableTerminal();
		this.host.setRunning(true);
		this.host.startSubagentsPolling();
		this.host.render();
		void this.host.loadRequestHistory().catch((error) => {
			if (!this.host.isRunning()) return;
			this.host.addEntry({ id: createId("warning"), kind: "system", text: `Request history failed to load: ${stringifyUnknown(error)}` });
			this.host.render();
		});

		try {
			await this.host.loadStartupConfig();
			const runtime = await this.host.createRuntime();
			if (!this.host.isRunning()) {
				await this.host.disposeRuntimeForQuit(runtime);
				return;
			}

			this.host.setRuntime(runtime);
			runtime.setRebindSession(async () => {
				if (!this.host.isRunning() || this.host.runtime() !== runtime) return;
				await this.bindCurrentSession({ awaitExtensions: false });
			});
			await this.bindCurrentSession({ awaitExtensions: false });
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
			void this.collectAvailabilityIssues(runtime);
			void this.host.restoreTabsAfterStartup().catch((error) => {
				if (!this.host.isRunning()) return;
				this.host.addEntry({ id: createId("warning"), kind: "system", text: `Tab restore failed: ${stringifyUnknown(error)}` });
				this.host.showToast("Could not restore tabs", "warning");
				this.host.render();
			});
	} catch (error) {
		this.host.addEntry({ id: createId("error"), kind: "error", text: stringifyUnknown(error) });
		this.host.showToast("Session startup failed", "error");
		this.host.setSessionStatus(undefined);
		this.host.render();
	}
}

	async bindCurrentSession(options: BindCurrentSessionOptions = {}): Promise<void> {
		const runtime = this.requireRuntime();
		const session = runtime.session;
		const ownershipGeneration = this.advanceOwnership(runtime, session);
		const subscriptionGeneration = ++this.subscriptionGeneration;
		this.replacementHistoryGeneration += 1;
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event) => {
			if (!this.isCurrentRuntimeSession(runtime, session, ownershipGeneration)
				|| subscriptionGeneration !== this.subscriptionGeneration) return;
			this.host.handleSessionEvent(event);
		});
		this.host.closeSdkMenuForBind();
		const extensionUiScope = this.extensionUiScope(session);
		this.host.clearExtensionWidgets(extensionUiScope, { cancelCustomUi: false });

		const bindPromise = this.bindSessionExtensions(runtime, session, extensionUiScope, {
			deferStart: options.awaitExtensions === false,
			ownershipGeneration,
		});
		if (options.awaitExtensions === false) {
			void bindPromise.catch((error) => {
				if (!this.isCurrentRuntimeSession(runtime, session, ownershipGeneration)
					|| subscriptionGeneration !== this.subscriptionGeneration) return;
				this.host.addEntry({ id: createId("error"), kind: "error", text: `Extension bind failed: ${stringifyUnknown(error)}` });
				this.host.showToast("Extension initialization failed", "error");
				this.host.render();
			});
			return;
		}

		await bindPromise;
	}

	async awaitCurrentSessionExtensions(runtime: AgentSessionRuntime | undefined = this.host.runtime()): Promise<void> {
		if (!runtime) return;
		if (this.extensionBindRuntime !== runtime || this.extensionBindSession !== runtime.session) return;
		if (this.extensionBindOwnershipGeneration !== this.ownershipGeneration) return;
		await this.extensionBindPromise;
	}

	unsubscribeSession(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.ownershipRuntime = undefined;
		this.ownershipSession = undefined;
		this.ownershipGeneration += 1;
		this.subscriptionGeneration += 1;
		this.replacementHistoryGeneration += 1;
	}

	afterSessionReplacement(message?: string): void {
		const runtime = this.host.runtime();
		if (!runtime) {
			this.resetSessionView();
			this.host.render();
			return;
		}
		const session = runtime.session;
		const ownershipGeneration = this.advanceOwnership(runtime, session);
		const historyGeneration = ++this.replacementHistoryGeneration;
		this.resetSessionView();
		void this.loadReplacementHistory(runtime, session, ownershipGeneration, historyGeneration, message);
		this.host.render();
	}

	private async loadReplacementHistory(
		runtime: AgentSessionRuntime,
		session: AgentSession,
		ownershipGeneration: number,
		historyGeneration: number,
		message?: string,
	): Promise<void> {
		const isCancelled = (): boolean => historyGeneration !== this.replacementHistoryGeneration
			|| !this.isCurrentRuntimeSession(runtime, session, ownershipGeneration);
		const completed = await this.host.loadSessionHistoryEntriesAsync({
			isCancelled,
			render: () => {
				if (!isCancelled()) this.host.render();
			},
			lazyOlderHistory: true,
		});
		if (!completed || isCancelled()) return;
		this.host.syncUserSessionEntryMetadata();
		if (isCancelled()) return;
		if (message) this.host.addEntry({ id: createId("system"), kind: "system", text: message });
		this.host.setSessionStatus(session);
		this.host.setSessionActivity(session.isStreaming ? "running" : "idle");
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

	private bindSessionExtensions(
		runtime: AgentSessionRuntime,
		session: AgentSession,
		scopeKey: string,
		options: { deferStart: boolean; ownershipGeneration: number },
	): Promise<void> {
		if (this.extensionBindPromise
			&& this.extensionBindRuntime === runtime
			&& this.extensionBindSession === session
			&& this.extensionBindOwnershipGeneration === options.ownershipGeneration) {
			return this.extensionBindPromise;
		}

		const startBind = (): Promise<void> => {
			if (!this.isCurrentRuntimeSession(runtime, session, options.ownershipGeneration)) return Promise.resolve();
			return session.bindExtensions({
				uiContext: this.host.createExtensionUIContext(scopeKey),
				commandContextActions: this.host.createExtensionCommandContextActions(runtime),
				shutdownHandler: this.host.extensionShutdownHandler(),
				onError: (error) => {
					if (this.isCurrentRuntimeSession(runtime, session, options.ownershipGeneration)) this.host.handleExtensionError(error);
				},
			});
		};
		const bindPromise = options.deferStart
			? new Promise<void>((resolve) => setTimeout(resolve, 0)).then(startBind)
			: startBind();
		const promise = bindPromise.finally(() => {
			if (this.extensionBindPromise !== promise) return;
			this.extensionBindPromise = undefined;
			this.extensionBindRuntime = undefined;
			this.extensionBindSession = undefined;
			this.extensionBindOwnershipGeneration = undefined;
		});

		this.extensionBindPromise = promise;
		this.extensionBindRuntime = runtime;
		this.extensionBindSession = session;
		this.extensionBindOwnershipGeneration = options.ownershipGeneration;
		return promise;
	}

	private async collectAvailabilityIssues(runtime: AgentSessionRuntime): Promise<void> {
		try {
			const availabilityIssues = await collectStartupAvailabilityIssues(runtime);
			if (!this.host.isRunning() || this.host.runtime() !== runtime) return;
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
			if (availabilityIssues.length > 0) this.host.render();
		} catch (error) {
			if (!this.host.isRunning() || this.host.runtime() !== runtime) return;
			this.host.addEntry({ id: createId("warning"), kind: "system", text: `Startup dependency check failed: ${stringifyUnknown(error)}` });
			this.host.render();
		}
	}

	private advanceOwnership(runtime: AgentSessionRuntime, session: AgentSession): number {
		if (this.ownershipRuntime !== runtime || this.ownershipSession !== session) {
			this.ownershipRuntime = runtime;
			this.ownershipSession = session;
			this.ownershipGeneration += 1;
		}
		return this.ownershipGeneration;
	}

	private isCurrentRuntimeSession(
		runtime: AgentSessionRuntime,
		session: AgentSession,
		ownershipGeneration: number,
	): boolean {
		return this.host.isRunning()
			&& this.host.runtime() === runtime
			&& runtime.session === session
			&& this.ownershipRuntime === runtime
			&& this.ownershipSession === session
			&& this.ownershipGeneration === ownershipGeneration;
	}

	private extensionUiScope(session: AgentSession): string {
		return session.sessionFile ?? session.sessionId;
	}
}
