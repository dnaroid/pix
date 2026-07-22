import type { AgentSession, AgentSessionRuntime, SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SessionSearchResult } from "../session/session-search.js";
import type { AppRequestHistory } from "../session/request-history.js";
import type { ActivePopupMenu, AppOptions, Entry, ModelMenuValue, PixMenuItem, PixMenuOptions, PopupMenuPlacement, ScopedSessionModel, SessionModel, ThinkingMenuValue } from "../types.js";
import type { ToastNotifier } from "../../ui.js";

export type DirectPopupMenu = Exclude<ActivePopupMenu, "slash">;

export type CommandControllerHost = {
	readonly options: AppOptions;
	runtime(): AgentSessionRuntime | undefined;
	awaitCurrentSessionExtensions(runtime?: AgentSessionRuntime): Promise<void>;
	requestHistory(): AppRequestHistory;
	getInput(): string;
	setInput(value: string): void;
	promptEnhancerModelRef(): string;
	autocompleteModelRef(): string;
	setAutocompleteModelRef(modelRef: string): void;
	ignoreContextFiles(): boolean;
	setIgnoreContextFiles(ignoreContextFiles: boolean): void;
	enhancePrompt(): Promise<void>;
	isRunning(): boolean;
	stop(): void | Promise<void>;
	addEntry(entry: Entry): void;
	setStatus(status: string): void;
	toast: ToastNotifier;
	render(): void;
	showMenu<T>(items: readonly PixMenuItem<T>[], options: PixMenuOptions): Promise<T | undefined>;
	getModelMenuItems(query: string): readonly PixMenuItem<ModelMenuValue>[];
	getThinkingMenuItems(query: string): readonly PixMenuItem<ThinkingMenuValue>[];
	modelRef(model: SessionModel): string;
	getFavoriteScopedModels(): ScopedSessionModel[];
	setSessionStatus(session: AgentSession | undefined): void;
	queueUserMessage(text: string): void;
	resetSessionView(): void;
	loadSessionHistory(): void;
	afterSessionReplacement(message?: string): void;
	openDirectPopupMenu(menu: DirectPopupMenu, options?: { preserveStatus?: boolean; placement?: PopupMenuPlacement }): void;
	getDirectPopupMenu(): DirectPopupMenu | undefined;
	setDirectPopupMenu(menu: DirectPopupMenu | undefined): void;
	setDirectPopupMenuPreserveStatus(preserveStatus: boolean): void;
	getDirectPopupMenuQuery(): string;
	setDirectPopupMenuQuery(query: string): void;
	refreshUserMessageJumpMenuItems(): Promise<void>;
	getResumeLoading(): boolean;
	getResumeSessions(): readonly SessionInfo[];
	setResumeLoading(loading: boolean): void;
	setResumeSessions(sessions: SessionInfo[]): void;
	openResumeMenuWithQuery(query: string): void;
	closeResumeMenu(): void;
	openNewTab(): Promise<void>;
	openSearchResultInNewTab(result: SessionSearchResult): Promise<void>;
};

export type CommandScope = {
	readonly runtime: AgentSessionRuntime | undefined;
	readonly session: AgentSession | undefined;
};

export function captureCommandScope(host: CommandControllerHost): CommandScope {
	const runtime = host.runtime();
	return { runtime, session: runtime?.session };
}

export function isCommandRuntimeActive(host: CommandControllerHost, runtime: AgentSessionRuntime): boolean {
	return host.isRunning() && host.runtime() === runtime;
}

export function isCommandScopeActive(host: CommandControllerHost, scope: CommandScope): boolean {
	return host.isRunning() && host.runtime() === scope.runtime && scope.runtime?.session === scope.session;
}
