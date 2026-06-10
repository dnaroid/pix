import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open as openFile, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
	getAgentDir,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import type { BindCurrentSessionOptions } from "./session-lifecycle-controller.js";
import { isRecord } from "../guards.js";
import { createId } from "../id.js";
import type { Attachment, InputEditorDraftState } from "../../input-editor.js";
import type { AppBlinkController } from "../screen/blink-controller.js";
import { tabPanelRows } from "../rendering/tab-line-renderer.js";
import type { AppOptions, Entry, SessionActivity, SessionTab, SubmittedUserMessage } from "../types.js";

const TAB_STATE_VERSION = 3;
const MAX_RESTORED_TABS = 8;
const BACKGROUND_PREWARM_TAB_LIMIT = 2;
const TAB_ATTENTION_BLINK_KEY = "tab-attention";
const LOADING_TAB_TITLE_PATTERN = /^loading(?:…|\.\.\.)?$/iu;
const DEFAULT_SESSION_TITLE_PATTERN = /^session [0-9a-f]{8}$/iu;
const SESSION_TITLE_SCAN_MAX_BYTES = 2 * 1024 * 1024;

type PersistedTab = {
	path: string;
	title?: string;
	input?: TabInputState;
	deferredUserMessages?: PersistedSubmittedUserMessage[];
};

type PersistedTabState = {
	version: 1 | 2 | 3;
	cwd: string;
	tabs: PersistedTab[];
	activePath?: string;
};

type PersistedSubmittedUserMessage = {
	id: string;
	promptText: string;
	displayText: string;
	images: Array<{ type: "image"; data: string; mimeType: string }>;
};

export type TabInputState = InputEditorDraftState;

export type AppTabsControllerHost = {
	readonly options: AppOptions;
	readonly maxProjectSessions?: number | (() => number | undefined);
	readonly blinkController: AppBlinkController;
	runtime(): AgentSessionRuntime | undefined;
	createRuntimeForNewSession(): Promise<AgentSessionRuntime>;
	createRuntimeForSession(sessionPath: string): Promise<AgentSessionRuntime>;
	activateRuntime(runtime: AgentSessionRuntime, options?: BindCurrentSessionOptions): Promise<void>;
	disposeRuntime(runtime: AgentSessionRuntime): Promise<void>;
	isRunning(): boolean;
	setStatus(status: string): void;
	setSessionStatus(session: AgentSession | undefined): void;
	setSessionActivity(activity: SessionActivity): void;
	resetSessionView(): void;
	loadSessionHistory(): void;
	loadSessionHistoryAsync(options: { isCancelled: () => boolean; render: () => void; lazyOlderHistory?: boolean }): Promise<boolean>;
	syncUserSessionEntryMetadata(): void;
	captureInputState(): TabInputState;
	restoreInputState(state: TabInputState): void;
	closeMenusForTabSwitch?(): void;
	captureDeferredUserMessages?(): readonly SubmittedUserMessage[];
	restoreDeferredUserMessages?(messages: readonly SubmittedUserMessage[]): void;
	addEntry(entry: Entry): void;
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
};

export class AppTabsController {
	private readonly tabItems: SessionTab[] = [];
	private readonly runtimesByTabId = new Map<string, AgentSessionRuntime>();
	private readonly runtimeLoadsByTabId = new Map<string, Promise<AgentSessionRuntime | undefined>>();
	private readonly runtimeSubscriptionsByTabId = new Map<string, { runtime: AgentSessionRuntime; session: AgentSession; unsubscribe: () => void }>();
	private readonly runtimeRefreshTimersByTabId = new Map<string, Set<ReturnType<typeof setTimeout>>>();
	private readonly inputStatesByTabId = new Map<string, TabInputState>();
	private readonly deferredUserMessagesByTabId = new Map<string, SubmittedUserMessage[]>();
	private activeTabId: string | undefined;
	private pendingActiveTabId: string | undefined;
	private historyLoadGeneration = 0;
	private restored = false;
	private retentionCleanupRunning = false;
	private retentionCleanupScheduled = false;
	private prewarmScheduled = false;
	private prewarmRunning = false;

	constructor(private readonly host: AppTabsControllerHost) {}

	tabs(): readonly SessionTab[] {
		if (!this.pendingActiveTabId) this.syncActiveTabFromRuntime({ save: false });
		const activeTabId = this.pendingActiveTabId ?? this.activeTabId;
		return this.tabItems.map((tab) => ({
			...tab,
			status: tab.id === activeTabId ? "active" : "waiting",
			activity: this.tabActivity(tab),
			...(tab.attention === undefined ? {} : { attention: tab.attention }),
			...(tab.attention === undefined ? {} : { attentionVisible: this.host.blinkController.visible(TAB_ATTENTION_BLINK_KEY, true) }),
		}));
	}

	isSwitching(): boolean {
		return this.pendingActiveTabId !== undefined;
	}

	markTerminalBellAttention(sessionPath: string | undefined): void {
		if (!sessionPath) return;
		const tab = this.findTabBySessionPath(sessionPath);
		if (!tab || tab.id === this.activeTabId) return;

		tab.attention = "terminal-bell";
		this.startAttentionBlink();
		this.host.render();
	}

	tabPanelRows(terminalRows: number): number {
		if (!this.pendingActiveTabId) this.syncActiveTabFromRuntime({ save: false });
		return tabPanelRows(true, terminalRows, this.tabItems.length);
	}

	activeInputTabId(): string | undefined {
		if (!this.pendingActiveTabId) this.syncActiveTabFromRuntime({ save: false });
		return this.activeTabId;
	}

	inputStateForTab(tabId: string | undefined): TabInputState | undefined {
		if (!tabId) return this.host.captureInputState();
		if (tabId === this.activeTabId && this.pendingActiveTabId === undefined) return this.host.captureInputState();
		return this.inputStatesByTabId.get(tabId);
	}

	async setInputStateForTab(tabId: string | undefined, state: TabInputState): Promise<void> {
		const attachments = state.attachments?.map(clonePersistedAttachment) ?? [];
		const nextState: TabInputState = {
			text: state.text,
			cursor: Math.max(0, Math.min(state.text.length, Math.trunc(state.cursor))),
			...(attachments.length > 0 ? { attachments } : {}),
		};
		const targetTabId = tabId ?? this.activeTabId;
		if (targetTabId) {
			if (nextState.text.length > 0) this.inputStatesByTabId.set(targetTabId, nextState);
			else this.inputStatesByTabId.delete(targetTabId);
		}

		if (!tabId || (tabId === this.activeTabId && this.pendingActiveTabId === undefined)) {
			this.host.restoreInputState(nextState);
		}
		await this.saveTabs();
	}

	async disposeInactiveRuntimes(
		disposeRuntime: (runtime: AgentSessionRuntime) => Promise<void> = this.host.disposeRuntime,
	): Promise<void> {
		await this.saveInputStateForQuit();

		const activeRuntime = this.host.runtime();
		const disposed = new Set<AgentSessionRuntime>();
		for (const runtime of this.runtimesByTabId.values()) {
			if (runtime === activeRuntime || disposed.has(runtime)) continue;
			disposed.add(runtime);
			await disposeRuntime(runtime);
		}
	}

	async saveInputStateForQuit(): Promise<void> {
		this.syncActiveTabFromRuntime({ save: false });
		this.storeActiveInputState();
		this.storeActiveDeferredUserMessages();
		await this.saveTabs();
	}

	persistActiveDeferredUserMessages(): void {
		this.storeActiveDeferredUserMessages();
		void this.saveTabs();
	}

	syncActiveTabFromRuntime(options: { save?: boolean; force?: boolean } = {}): void {
		if (this.pendingActiveTabId && options.force !== true) return;

		const session = this.host.runtime()?.session;
		if (!session) return;
		const sessionPath = this.sessionPath(session);

		const active = this.activeTab();
		const existing = sessionPath ? this.findTabBySessionPath(sessionPath, active ? { excludeTabId: active.id } : {}) : undefined;
		if (existing) {
			if (active) {
				this.storeActiveInputState();
				this.storeActiveDeferredUserMessages();
			}
			this.activeTabId = existing.id;
			this.clearTabAttention(existing);
			this.updateTabFromSession(existing, session);
			if (active) this.deleteRuntimeForTab(active.id);
			this.storeActiveRuntime();
			this.restoreDeferredUserMessages(existing.id);
			if (options.save !== false) void this.saveTabs();
			return;
		}

		if (!active) {
			const tab = this.tabFromSession(session, { titlePlaceholder: "loading" });
			this.tabItems.push(tab);
			this.activeTabId = tab.id;
			this.clearTabAttention(tab);
			this.storeActiveRuntime();
			if (options.save !== false) void this.saveTabs();
			return;
		}

		this.updateTabFromSession(active, session);
		this.clearTabAttention(active);
		this.storeActiveRuntime();
		if (options.save !== false) void this.saveTabs();
	}

	async restoreAfterStartup(): Promise<void> {
		if (this.restored) return;
		this.restored = true;

		const runtime = this.host.runtime();
		if (!runtime) return;

		this.syncActiveTabFromRuntime({ save: false });
		if (this.host.options.noSession) {
			this.clearStartupTabPlaceholders();
			return;
		}

		const saved = await this.loadTabs();
		if (!saved || saved.tabs.length === 0) {
			this.clearStartupTabPlaceholders();
			await this.saveTabs();
			return;
		}

		const restoredTabs = this.restoredTabs(saved);
		if (restoredTabs.length === 0) {
			this.clearStartupTabPlaceholders();
			await this.saveTabs();
			this.scheduleProjectSessionRetention();
			return;
		}

		const currentPath = runtime.session.sessionFile ? resolve(runtime.session.sessionFile) : undefined;
		const explicitSessionPath = this.host.options.sessionPath ? resolve(this.host.options.sessionPath) : undefined;
		const savedActivePath = saved.activePath ? resolve(saved.activePath) : undefined;
		const desiredPath = explicitSessionPath && currentPath
			? currentPath
			: savedActivePath && restoredTabs.some((tab) => tab.sessionPath === savedActivePath)
				? savedActivePath
				: restoredTabs[0]?.sessionPath;

		this.replaceTabs(restoredTabs, desiredPath);
		this.restorePersistedInputStates(saved);
		this.restorePersistedDeferredUserMessages(saved);
		const restoredSessionPaths = saved.tabs.map((tab) => tab.path);
		if (explicitSessionPath && currentPath) this.ensureCurrentSessionTab(runtime.session);

		if (!desiredPath) {
			this.clearStartupTabPlaceholders();
			await this.saveTabs();
			this.scheduleRestoredTabTitleRefresh(restoredSessionPaths);
			this.scheduleProjectSessionRetention();
			this.scheduleTabPrewarm();
			return;
		}

		let restoredRuntime = runtime;
		if (currentPath !== desiredPath) {
			this.host.setStatus("restoring tabs");
			this.host.render();
			try {
				restoredRuntime = await this.host.createRuntimeForSession(desiredPath);
				await this.host.activateRuntime(restoredRuntime, { awaitExtensions: false });
			} catch {
				this.host.showToast("Could not restore the previous active tab", "warning");
				this.replaceTabs([this.tabFromSession(runtime.session), ...restoredTabs], currentPath);
				this.storeActiveRuntime(runtime);
				this.clearStartupTabPlaceholders();
				await this.saveTabs();
				this.scheduleRestoredTabTitleRefresh(restoredSessionPaths);
				this.scheduleProjectSessionRetention();
				return;
			}
		}

		this.syncActiveTabFromRuntime({ save: false });
		this.clearStartupTabPlaceholders();
		if (this.activeTabId) this.restoreInputState(this.activeTabId);
		await this.saveTabs();
		this.scheduleProjectSessionRetention();
		this.scheduleTabPrewarm();
		await this.loadActiveSessionHistory(restoredRuntime);
		this.scheduleRestoredTabTitleRefresh(restoredSessionPaths);
	}

	async openNewTab(): Promise<void> {
		if (this.pendingActiveTabId) {
			this.host.showToast("Wait for the tab to finish loading", "info");
			return;
		}

		const runtime = this.runtimeForCommand("new_tab");
		if (!runtime) return;
		if (!this.tabsAvailable(runtime)) return;

		this.cancelHistoryLoad();
		this.syncActiveTabFromRuntime();
		this.storeActiveInputState();
		this.storeActiveDeferredUserMessages();
		const previousTabId = this.activeTabId;
		const previousRuntime = runtime;
		const tab: SessionTab = {
			id: createId("tab"),
			title: "new",
			titlePlaceholder: "new",
			status: "active",
			activity: "thinking",
		};
		this.tabItems.push(tab);
		this.activeTabId = tab.id;
		this.pendingActiveTabId = tab.id;
		this.clearTabAttention(tab);
		this.restoreInputState(tab.id);
		this.host.closeMenusForTabSwitch?.();
		this.host.resetSessionView();
		this.restoreDeferredUserMessages(tab.id);
		this.host.setSessionActivity("thinking");
		this.host.setStatus("starting new tab");
		this.host.render();

		let newRuntime: AgentSessionRuntime;
		try {
			newRuntime = await this.host.createRuntimeForNewSession();
		} catch (error) {
			if (this.pendingActiveTabId === tab.id) this.pendingActiveTabId = undefined;
			this.removeTab(tab.id);
			this.activeTabId = previousTabId;
			if (previousTabId) this.restoreInputState(previousTabId);
			this.host.closeMenusForTabSwitch?.();
			this.host.resetSessionView();
			if (previousTabId) this.restoreDeferredUserMessages(previousTabId);
			this.host.loadSessionHistory();
			this.host.setSessionStatus(previousRuntime.session);
			this.host.setSessionActivity(this.sessionActivity(previousRuntime.session));
			this.host.render();
			throw error;
		}

		const existingTab = this.findTabForSession(newRuntime.session);
		const targetTab = existingTab && existingTab.id !== tab.id ? existingTab : tab;
		if (targetTab !== tab) this.removeTab(tab.id);
		this.activeTabId = targetTab.id;
		this.pendingActiveTabId = targetTab.id;
		this.clearTabAttention(targetTab);
		this.updateTabFromSession(targetTab, newRuntime.session);
		this.setRuntimeForTab(targetTab.id, newRuntime);
		this.restoreInputState(targetTab.id);
		this.host.resetSessionView();
		this.restoreDeferredUserMessages(targetTab.id);
		this.host.setSessionActivity("thinking");
		this.host.render();
		try {
			await this.host.activateRuntime(newRuntime, { awaitExtensions: false });
		} finally {
			if (this.pendingActiveTabId === targetTab.id) this.pendingActiveTabId = undefined;
		}
		void this.saveTabs();
		this.scheduleProjectSessionRetention();
		this.host.resetSessionView();
		this.restoreDeferredUserMessages(targetTab.id);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Opened a new tab. cwd=${newRuntime.cwd}` });
		if (newRuntime.modelFallbackMessage) this.host.addEntry({ id: createId("system"), kind: "system", text: newRuntime.modelFallbackMessage });
		for (const diag of newRuntime.diagnostics ?? []) {
			const kind = diag.type === "error" ? "error" as const : "system" as const;
			this.host.addEntry({ id: createId("system"), kind, text: `[${diag.type}] ${diag.message}` });
		}
		this.host.setSessionStatus(newRuntime.session);
		this.host.setSessionActivity(this.sessionActivity(newRuntime.session));
		this.host.render();
	}

	async openSessionInNewTab(sessionPath: string): Promise<boolean> {
		if (this.pendingActiveTabId) {
			this.host.showToast("Wait for the tab to finish loading", "info");
			return false;
		}

		const runtime = this.runtimeForCommand("search");
		if (!runtime) return false;
		if (this.host.options.noSession) {
			this.host.showToast("/search is unavailable with --no-session", "warning");
			return false;
		}

		this.syncActiveTabFromRuntime({ save: false });
		const resolvedSessionPath = resolve(runtime.cwd, sessionPath);
		const existingTab = this.findTabBySessionPath(resolvedSessionPath);
		if (existingTab) {
			await this.switchToTab(existingTab.id);
			return true;
		}

		this.cancelHistoryLoad();
		this.storeActiveInputState();
		this.storeActiveDeferredUserMessages();
		const previousTabId = this.activeTabId;
		const previousRuntime = runtime;
		this.host.setStatus("opening session tab");
		this.host.render();

		const tab: SessionTab = {
			id: createId("tab"),
			title: basename(resolvedSessionPath, extname(resolvedSessionPath)) || "loading",
			titlePlaceholder: "loading",
			status: "active",
			activity: "thinking",
			sessionPath: resolvedSessionPath,
		};
		this.tabItems.push(tab);
		this.activeTabId = tab.id;
		this.pendingActiveTabId = tab.id;
		this.clearTabAttention(tab);
		this.restoreInputState(tab.id);
		this.host.closeMenusForTabSwitch?.();
		this.host.resetSessionView();
		this.restoreDeferredUserMessages(tab.id);
		this.host.setSessionActivity("thinking");
		this.host.render();

		let newRuntime: AgentSessionRuntime;
		try {
			newRuntime = await this.host.createRuntimeForSession(resolvedSessionPath);
		} catch {
			this.pendingActiveTabId = undefined;
			this.removeTab(tab.id);
			this.activeTabId = previousTabId;
			if (previousTabId) this.restoreInputState(previousTabId);
			this.host.closeMenusForTabSwitch?.();
			this.host.resetSessionView();
			if (previousTabId) this.restoreDeferredUserMessages(previousTabId);
			this.host.loadSessionHistory();
			this.host.showToast("Could not open session tab", "warning");
			this.host.setSessionStatus(previousRuntime.session);
			this.host.setSessionActivity(this.sessionActivity(previousRuntime.session));
			this.host.render();
			return false;
		}

		this.updateTabFromSession(tab, newRuntime.session);
		this.setRuntimeForTab(tab.id, newRuntime);
		this.host.render();

		try {
			await this.host.activateRuntime(newRuntime, { awaitExtensions: false });
		} catch {
			this.pendingActiveTabId = undefined;
			this.removeTab(tab.id);
			this.activeTabId = previousTabId;
			if (previousTabId) this.restoreInputState(previousTabId);
			this.host.closeMenusForTabSwitch?.();
			if (this.host.runtime() !== previousRuntime) {
				try {
					await this.host.activateRuntime(previousRuntime, { awaitExtensions: false });
				} catch {
					// Keep the best available runtime below and surface the switch failure.
				}
			}
			void this.host.disposeRuntime(newRuntime);
			this.host.showToast("Could not open session tab", "warning");
			this.host.resetSessionView();
			if (previousTabId) this.restoreDeferredUserMessages(previousTabId);
			this.host.loadSessionHistory();
			this.host.setSessionStatus(this.host.runtime()?.session);
			this.host.setSessionActivity(this.sessionActivity(this.host.runtime()?.session));
			this.host.render();
			return false;
		}

		if (this.pendingActiveTabId === tab.id) this.pendingActiveTabId = undefined;
		this.activeTabId = tab.id;
		this.clearTabAttention(tab);
		this.updateTabFromSession(tab, newRuntime.session);
		this.setRuntimeForTab(tab.id, newRuntime);
		this.restoreInputState(tab.id);
		void this.saveTabs();
		this.scheduleTabPrewarm();
		await this.loadActiveSessionHistory(newRuntime);
		return true;
	}

	async forkSessionEntryInNewTab(entryId: string): Promise<boolean> {
		if (this.pendingActiveTabId) {
			this.host.showToast("Wait for the tab to finish loading", "info");
			return false;
		}

		const runtime = this.idleRuntime("fork");
		if (!runtime) return false;
		if (this.host.options.noSession) {
			this.host.showToast("Fork in new tab is unavailable with --no-session", "warning");
			return false;
		}

		const currentSessionPath = runtime.session.sessionFile ? resolve(runtime.session.sessionFile) : undefined;
		if (!currentSessionPath) {
			this.host.showToast("Fork in new tab requires a persisted session", "warning");
			return false;
		}

		this.cancelHistoryLoad();
		this.syncActiveTabFromRuntime({ save: false });
		this.storeActiveInputState();
		this.storeActiveDeferredUserMessages();
		const previousTabId = this.activeTabId;
		const previousRuntime = runtime;
		this.host.setStatus("forking session tab");
		this.host.render();

		let forkRuntime: AgentSessionRuntime;
		try {
			forkRuntime = await this.host.createRuntimeForSession(currentSessionPath);
		} catch {
			this.host.showToast("Could not fork in new tab", "warning");
			this.host.setSessionStatus(previousRuntime.session);
			this.host.render();
			return false;
		}

		let result: Awaited<ReturnType<AgentSessionRuntime["fork"]>>;
		try {
			result = await forkRuntime.fork(entryId);
		} catch (error) {
			void this.host.disposeRuntime(forkRuntime);
			throw error;
		}
		if (result.cancelled) {
			void this.host.disposeRuntime(forkRuntime);
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Fork cancelled." });
			this.host.setSessionStatus(previousRuntime.session);
			this.host.render();
			return false;
		}

		const existingTab = this.findTabForSession(forkRuntime.session);
		if (existingTab) {
			if (result.selectedText) this.inputStatesByTabId.set(existingTab.id, this.inputStateFromText(result.selectedText));
			void this.host.disposeRuntime(forkRuntime);
			await this.switchToTab(existingTab.id);
			this.host.showToast("Fork opened in existing tab", "success");
			return true;
		}

		const tab = this.tabFromSession(forkRuntime.session, { titlePlaceholder: "new" });
		this.tabItems.push(tab);
		this.activeTabId = tab.id;
		this.pendingActiveTabId = tab.id;
		this.clearTabAttention(tab);
		this.updateTabFromSession(tab, forkRuntime.session);
		this.setRuntimeForTab(tab.id, forkRuntime);
		if (result.selectedText) this.inputStatesByTabId.set(tab.id, this.inputStateFromText(result.selectedText));
		this.restoreInputState(tab.id);
		this.host.closeMenusForTabSwitch?.();
		this.host.resetSessionView();
		this.restoreDeferredUserMessages(tab.id);
		this.host.setSessionActivity("thinking");
		this.host.render();

		try {
			await this.host.activateRuntime(forkRuntime, { awaitExtensions: false });
		} catch {
			this.pendingActiveTabId = undefined;
			this.removeTab(tab.id);
			this.activeTabId = previousTabId;
			if (previousTabId) this.restoreInputState(previousTabId);
			this.host.closeMenusForTabSwitch?.();
			if (this.host.runtime() !== previousRuntime) {
				try {
					await this.host.activateRuntime(previousRuntime, { awaitExtensions: false });
				} catch {
					// Keep the best available runtime below and surface the switch failure.
				}
			}
			void this.host.disposeRuntime(forkRuntime);
			this.host.showToast("Could not open fork tab", "warning");
			this.host.resetSessionView();
			if (previousTabId) this.restoreDeferredUserMessages(previousTabId);
			this.host.loadSessionHistory();
			this.host.setSessionStatus(this.host.runtime()?.session);
			this.host.setSessionActivity(this.sessionActivity(this.host.runtime()?.session));
			this.host.render();
			return false;
		}

		this.pendingActiveTabId = undefined;
		this.activeTabId = tab.id;
		this.clearTabAttention(tab);
		this.updateTabFromSession(tab, forkRuntime.session);
		this.setRuntimeForTab(tab.id, forkRuntime);
		this.restoreInputState(tab.id);
		void this.saveTabs();
		this.scheduleProjectSessionRetention();
		this.scheduleTabPrewarm();
		await this.loadActiveSessionHistory(forkRuntime);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Forked from entry ${entryId} in a new tab.` });
		this.host.setSessionStatus(forkRuntime.session);
		this.host.showToast("Fork opened in new tab", "success");
		this.host.render();
		return true;
	}

	async switchToTab(tabId: string): Promise<void> {
		if (this.pendingActiveTabId) {
			this.host.showToast("Wait for the tab to finish loading", "info");
			return;
		}

		if (tabId === this.activeTabId) return;

		const runtime = this.runtimeForCommand("tab switch");
		if (!runtime) return;

		this.syncActiveTabFromRuntime({ save: false });
		const target = this.tabItems.find((tab) => tab.id === tabId);
		if (!target) return;
		if (!target.sessionPath) {
			this.host.showToast("Tab has no persisted session path", "warning");
			return;
		}

		this.cancelHistoryLoad();
		const previousTabId = this.activeTabId;
		const previousRuntime = runtime;
		const previousTargetActivity = target.activity;

		this.storeActiveRuntime(runtime);
		this.storeActiveInputState();
		this.storeActiveDeferredUserMessages();
		this.activeTabId = target.id;
		this.pendingActiveTabId = target.id;
		target.activity = "thinking";
		this.clearTabAttention(target);
		this.restoreInputState(target.id);
		this.host.closeMenusForTabSwitch?.();
		this.host.resetSessionView();
		this.restoreDeferredUserMessages(target.id);
		this.host.setStatus("switching tab");
		this.host.setSessionActivity("thinking");
		this.host.render();

		let targetRuntime: AgentSessionRuntime | undefined;
		try {
			targetRuntime = await this.runtimeForTab(target);
			if (!targetRuntime) throw new Error("Could not load tab runtime");
			await this.host.activateRuntime(targetRuntime, { awaitExtensions: false });
		} catch {
			this.pendingActiveTabId = undefined;
			if (previousTargetActivity === undefined) delete target.activity;
			else target.activity = previousTargetActivity;
			this.activeTabId = previousTabId;
			if (previousTabId) this.restoreInputState(previousTabId);
			this.host.closeMenusForTabSwitch?.();
			if (this.host.runtime() !== previousRuntime) {
				try {
					await this.host.activateRuntime(previousRuntime, { awaitExtensions: false });
				} catch {
					// Keep the best available runtime below and surface the switch failure.
				}
			}
			this.host.showToast("Could not switch tab", "warning");
			this.host.resetSessionView();
			if (previousTabId) this.restoreDeferredUserMessages(previousTabId);
			this.host.loadSessionHistory();
			const activeSession = this.host.runtime()?.session;
			this.host.setSessionStatus(activeSession);
			this.host.setSessionActivity(this.sessionActivity(activeSession));
			this.host.render();
			return;
		}

		this.pendingActiveTabId = undefined;
		this.activeTabId = target.id;
		this.clearTabAttention(target);
		this.updateTabFromSession(target, targetRuntime.session);
		this.setRuntimeForTab(target.id, targetRuntime);
		this.restoreInputState(target.id);
		void this.saveTabs();
		this.scheduleTabPrewarm();
		await this.loadActiveSessionHistory(targetRuntime);
	}

	async closeTab(tabId: string): Promise<void> {
		if (this.pendingActiveTabId) {
			this.host.showToast("Wait for the tab to finish loading", "info");
			return;
		}

		const index = this.tabItems.findIndex((tab) => tab.id === tabId);
		if (index < 0) return;
		this.cancelHistoryLoad();

		if (this.tabItems.length <= 1) {
			await this.replaceLastTabWithNewSession(tabId);
			return;
		}

		if (tabId !== this.activeTabId) {
			const tabRuntime = this.runtimesByTabId.get(tabId);
			if (tabRuntime?.session.isStreaming || tabRuntime?.session.isCompacting) {
				this.host.showToast("Cannot close a running tab", "warning");
				return;
			}

			this.tabItems.splice(index, 1);
			this.deleteRuntimeForTab(tabId);
			this.inputStatesByTabId.delete(tabId);
			this.deferredUserMessagesByTabId.delete(tabId);
			this.storeActiveInputState();
			this.storeActiveDeferredUserMessages();
			this.stopAttentionBlinkIfIdle();
			if (tabRuntime) void this.host.disposeRuntime(tabRuntime);
			void this.saveTabs();
			this.host.render();
			return;
		}

		const runtime = this.idleRuntime("tab close");
		if (!runtime) return;

		const nextTab = this.tabItems[index + 1] ?? this.tabItems[index - 1];
		if (!nextTab?.sessionPath) {
			this.host.showToast("No persisted session path for the next tab", "warning");
			return;
		}

		this.host.setStatus("closing tab");
		this.host.render();
		const nextRuntime = await this.runtimeForTab(nextTab);
		if (!nextRuntime) return;
		await this.host.activateRuntime(nextRuntime, { awaitExtensions: false });

		this.tabItems.splice(index, 1);
		this.deleteRuntimeForTab(tabId);
		this.inputStatesByTabId.delete(tabId);
		this.deferredUserMessagesByTabId.delete(tabId);
		this.stopAttentionBlinkIfIdle();
		this.activeTabId = nextTab.id;
		this.clearTabAttention(nextTab);
		this.updateTabFromSession(nextTab, nextRuntime.session);
		this.setRuntimeForTab(nextTab.id, nextRuntime);
		this.restoreInputState(nextTab.id);
		this.host.closeMenusForTabSwitch?.();
		void this.host.disposeRuntime(runtime);
		void this.saveTabs();
		this.scheduleTabPrewarm();
		await this.loadActiveSessionHistory(nextRuntime);
	}

	private async replaceLastTabWithNewSession(tabId: string): Promise<void> {
		const tab = this.tabItems.find((item) => item.id === tabId);
		if (!tab) return;

		const runtime = this.idleRuntime("new");
		if (!runtime) return;

		this.activeTabId = tab.id;
		this.host.setStatus("starting new session");
		this.host.render();

		const result = await runtime.newSession();
		if (result.cancelled) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "New session cancelled." });
			this.host.setSessionStatus(runtime.session);
			this.host.setSessionActivity(this.sessionActivity(runtime.session));
			this.host.render();
			return;
		}

		this.clearTabAttention(tab);
		this.updateTabFromSession(tab, runtime.session);
		this.setRuntimeForTab(tab.id, runtime);
		this.inputStatesByTabId.delete(tab.id);
		this.deferredUserMessagesByTabId.delete(tab.id);
		this.restoreInputState(tab.id);
		this.host.closeMenusForTabSwitch?.();
		this.stopAttentionBlinkIfIdle();

		this.host.resetSessionView();
		this.restoreDeferredUserMessages(tab.id);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Started a new session. cwd=${runtime.cwd}` });
		if (runtime.modelFallbackMessage) this.host.addEntry({ id: createId("system"), kind: "system", text: runtime.modelFallbackMessage });
		for (const diag of runtime.diagnostics ?? []) {
			const kind = diag.type === "error" ? "error" as const : "system" as const;
			this.host.addEntry({ id: createId("system"), kind, text: `[${diag.type}] ${diag.message}` });
		}
		this.host.setSessionStatus(runtime.session);
		this.host.setSessionActivity(this.sessionActivity(runtime.session));
		void this.saveTabs();
		this.scheduleProjectSessionRetention();
		this.host.render();
	}

	private async loadActiveSessionHistory(runtime: AgentSessionRuntime): Promise<void> {
		const generation = ++this.historyLoadGeneration;
		const isCancelled = (): boolean => generation !== this.historyLoadGeneration || this.host.runtime() !== runtime;
		this.host.resetSessionView();
		if (this.activeTabId) this.restoreDeferredUserMessages(this.activeTabId);
		this.host.setStatus("loading session history");
		this.host.setSessionActivity("thinking");
		this.host.render();

		const completed = await this.host.loadSessionHistoryAsync({
			isCancelled,
			render: () => {
				if (!isCancelled()) this.host.render();
			},
			lazyOlderHistory: true,
		});
		if (!completed || isCancelled()) return;

		this.host.setSessionStatus(runtime.session);
		this.host.syncUserSessionEntryMetadata();
		this.host.setSessionActivity(this.sessionActivity(runtime.session));
		this.host.render();
	}

	private cancelHistoryLoad(): void {
		this.historyLoadGeneration += 1;
	}

	private tabsAvailable(runtime: AgentSessionRuntime): boolean {
		if (this.host.options.noSession) {
			this.host.showToast("/new_tab is unavailable with --no-session", "warning");
			return false;
		}

		if (!runtime.session.sessionFile) {
			this.host.showToast("/new_tab requires a persisted session", "warning");
			return false;
		}

		return true;
	}

	private runtimeForCommand(commandName: string): AgentSessionRuntime | undefined {
		const runtime = this.host.runtime();
		if (!runtime) {
			this.host.showToast(`/${commandName} unavailable`, "error");
			this.host.addEntry({ id: createId("error"), kind: "error", text: "Runtime is not initialized" });
			return undefined;
		}

		return runtime;
	}

	private idleRuntime(commandName: string): AgentSessionRuntime | undefined {
		const runtime = this.runtimeForCommand(commandName);
		if (!runtime) return undefined;

		if (runtime.session.isStreaming || runtime.session.isCompacting) {
			this.host.showToast(`/${commandName} is unavailable while the agent is running`, "warning");
			return undefined;
		}

		return runtime;
	}

	private activeTab(): SessionTab | undefined {
		return this.activeTabId ? this.tabItems.find((tab) => tab.id === this.activeTabId) : undefined;
	}

	private clearStartupTabPlaceholders(): void {
		for (const tab of this.tabItems) {
			delete tab.titlePlaceholder;
		}
	}

	private storeActiveRuntime(runtime = this.host.runtime()): void {
		if (!this.activeTabId || !runtime) return;
		this.setRuntimeForTab(this.activeTabId, runtime);
	}

	private setRuntimeForTab(tabId: string, runtime: AgentSessionRuntime): void {
		this.runtimesByTabId.set(tabId, runtime);
		this.observeRuntimeForTab(tabId, runtime);
	}

	private deleteRuntimeForTab(tabId: string): void {
		this.runtimesByTabId.delete(tabId);
		this.runtimeLoadsByTabId.delete(tabId);
		this.clearRuntimeRefreshTimers(tabId);
		const subscription = this.runtimeSubscriptionsByTabId.get(tabId);
		subscription?.unsubscribe();
		this.runtimeSubscriptionsByTabId.delete(tabId);
	}

	private clearRuntimeSubscriptions(): void {
		for (const tabId of this.runtimeRefreshTimersByTabId.keys()) {
			this.clearRuntimeRefreshTimers(tabId);
		}
		for (const subscription of this.runtimeSubscriptionsByTabId.values()) {
			subscription.unsubscribe();
		}
		this.runtimeSubscriptionsByTabId.clear();
	}

	private observeRuntimeForTab(tabId: string, runtime: AgentSessionRuntime): void {
		const existing = this.runtimeSubscriptionsByTabId.get(tabId);
		if (existing?.runtime === runtime && existing.session === runtime.session) return;
		existing?.unsubscribe();

		const unsubscribe = runtime.session.subscribe((event) => {
			if (this.shouldScheduleDelayedSyncForRuntimeEvent(event)) {
				this.scheduleDelayedRuntimeSync(tabId, runtime);
			}
			if (!this.shouldSyncTabFromRuntimeEvent(event)) return;
			this.syncTabFromObservedRuntime(tabId, runtime);
		});
		this.runtimeSubscriptionsByTabId.set(tabId, { runtime, session: runtime.session, unsubscribe });
	}

	private shouldSyncTabFromRuntimeEvent(event: AgentSessionEvent): boolean {
		return event.type === "session_info_changed"
			|| event.type === "agent_start"
			|| event.type === "agent_end"
			|| event.type === "compaction_start"
			|| event.type === "compaction_end";
	}

	private shouldScheduleDelayedSyncForRuntimeEvent(event: AgentSessionEvent): boolean {
		return event.type === "agent_end"
			|| event.type === "turn_end"
			|| event.type === "compaction_end";
	}

	private scheduleDelayedRuntimeSync(tabId: string, runtime: AgentSessionRuntime): void {
		this.clearRuntimeRefreshTimers(tabId);
		for (const delayMs of [0, 100, 500, 1500, 3000]) {
			const timer = setTimeout(() => {
				this.runtimeRefreshTimersByTabId.get(tabId)?.delete(timer);
				this.syncTabFromObservedRuntime(tabId, runtime);
			}, delayMs);
			timer.unref?.();
			let timers = this.runtimeRefreshTimersByTabId.get(tabId);
			if (!timers) {
				timers = new Set();
				this.runtimeRefreshTimersByTabId.set(tabId, timers);
			}
			timers.add(timer);
		}
	}

	private clearRuntimeRefreshTimers(tabId: string): void {
		const timers = this.runtimeRefreshTimersByTabId.get(tabId);
		if (!timers) return;
		for (const timer of timers) clearTimeout(timer);
		this.runtimeRefreshTimersByTabId.delete(tabId);
	}

	private syncTabFromObservedRuntime(tabId: string, runtime: AgentSessionRuntime): void {
		const tab = this.tabItems.find((item) => item.id === tabId);
		if (!tab) {
			this.deleteRuntimeForTab(tabId);
			return;
		}

		const previousTitle = tab.title;
		const previousActivity = tab.activity;
		const previousSessionPath = tab.sessionPath;
		this.updateTabFromSession(tab, runtime.session);

		if (tab.title === previousTitle && tab.activity === previousActivity && tab.sessionPath === previousSessionPath) return;
		if (tab.title !== previousTitle || tab.sessionPath !== previousSessionPath) void this.saveTabs();
		this.host.render();
	}

	private storeActiveInputState(): void {
		if (!this.activeTabId) return;
		const state = this.host.captureInputState();
		const attachments = state.attachments?.map(clonePersistedAttachment) ?? [];
		this.inputStatesByTabId.set(this.activeTabId, {
			text: state.text,
			cursor: state.cursor,
			...(attachments.length > 0 ? { attachments } : {}),
		});
	}

	private storeActiveDeferredUserMessages(): void {
		if (!this.activeTabId || !this.host.captureDeferredUserMessages) return;
		const messages = this.host.captureDeferredUserMessages();
		if (messages.length > 0) {
			this.deferredUserMessagesByTabId.set(this.activeTabId, messages.map((message) => this.cloneSubmittedUserMessage(message)));
		} else {
			this.deferredUserMessagesByTabId.delete(this.activeTabId);
		}
	}

	private restoreInputState(tabId: string): void {
		this.host.restoreInputState(this.inputStatesByTabId.get(tabId) ?? { text: "", cursor: 0 });
	}

	private inputStateFromText(text: string): TabInputState {
		return { text, cursor: text.length };
	}

	private restoreDeferredUserMessages(tabId: string): void {
		this.host.restoreDeferredUserMessages?.(this.deferredUserMessagesByTabId.get(tabId) ?? []);
	}

	private cloneSubmittedUserMessage(message: SubmittedUserMessage): SubmittedUserMessage {
		return {
			id: message.id,
			promptText: message.promptText,
			displayText: message.displayText,
			images: message.images.map((image) => ({ ...image })),
		};
	}

	private async runtimeForTab(tab: SessionTab): Promise<AgentSessionRuntime | undefined> {
		const existing = this.runtimesByTabId.get(tab.id);
		if (existing) return existing;
		const loading = this.runtimeLoadsByTabId.get(tab.id);
		if (loading) return await loading;
		if (!tab.sessionPath) {
			this.host.showToast("Tab has no persisted session path", "warning");
			return undefined;
		}

		const expectedPath = resolve(tab.sessionPath);
		const pending = (async (): Promise<AgentSessionRuntime | undefined> => {
			const runtime = await this.host.createRuntimeForSession(expectedPath);
			const liveTab = this.tabItems.find((item) => item.id === tab.id);
			if (!liveTab || !liveTab.sessionPath || resolve(liveTab.sessionPath) !== expectedPath) {
				void this.host.disposeRuntime(runtime);
				return undefined;
			}

			this.setRuntimeForTab(tab.id, runtime);
			return runtime;
		})();
		this.runtimeLoadsByTabId.set(tab.id, pending);
		try {
			return await pending;
		} finally {
			if (this.runtimeLoadsByTabId.get(tab.id) === pending) this.runtimeLoadsByTabId.delete(tab.id);
		}
	}

	private findTabForSession(session: AgentSession, options: { excludeTabId?: string } = {}): SessionTab | undefined {
		const sessionPath = this.sessionPath(session);
		return sessionPath ? this.findTabBySessionPath(sessionPath, options) : undefined;
	}

	private findTabBySessionPath(sessionPath: string, options: { excludeTabId?: string } = {}): SessionTab | undefined {
		const normalizedPath = resolve(sessionPath);
		return this.tabItems.find((tab) => (
			tab.id !== options.excludeTabId
			&& tab.sessionPath !== undefined
			&& resolve(tab.sessionPath) === normalizedPath
		));
	}

	private replaceTabs(tabs: readonly SessionTab[], activeSessionPath: string | undefined): void {
		this.tabItems.length = 0;
		this.runtimesByTabId.clear();
		this.clearRuntimeSubscriptions();
		this.inputStatesByTabId.clear();
		this.deferredUserMessagesByTabId.clear();
		const seen = new Set<string>();
		for (const tab of tabs) {
			const sessionPath = tab.sessionPath ? resolve(tab.sessionPath) : undefined;
			if (sessionPath) {
				if (seen.has(sessionPath)) continue;
				seen.add(sessionPath);
			}

			this.tabItems.push({
				id: tab.id,
				title: tab.title,
				...(tab.titlePlaceholder ? { titlePlaceholder: tab.titlePlaceholder } : {}),
				status: "waiting",
				activity: tab.activity ?? "idle",
				...(sessionPath ? { sessionPath } : {}),
			});
		}

		const activePath = activeSessionPath ? resolve(activeSessionPath) : undefined;
		this.activeTabId = activePath
			? this.tabItems.find((tab) => tab.sessionPath === activePath)?.id
			: this.tabItems[0]?.id;
		this.activeTabId ??= this.tabItems[0]?.id;
	}

	private removeTab(tabId: string): void {
		const index = this.tabItems.findIndex((tab) => tab.id === tabId);
		if (index >= 0) this.tabItems.splice(index, 1);
		this.deleteRuntimeForTab(tabId);
		this.inputStatesByTabId.delete(tabId);
		this.deferredUserMessagesByTabId.delete(tabId);
	}

	private restorePersistedInputStates(saved: PersistedTabState): void {
		const inputsByPath = new Map<string, TabInputState>();
		for (const tab of saved.tabs) {
			if (!tab.input) continue;
			inputsByPath.set(resolve(tab.path), tab.input);
		}

		for (const tab of this.tabItems) {
			if (!tab.sessionPath) continue;
			const input = inputsByPath.get(resolve(tab.sessionPath));
			if (!input) continue;
			this.inputStatesByTabId.set(tab.id, input);
		}
	}

	private restorePersistedDeferredUserMessages(saved: PersistedTabState): void {
		const messagesByPath = new Map<string, SubmittedUserMessage[]>();
		for (const tab of saved.tabs) {
			if (!tab.deferredUserMessages || tab.deferredUserMessages.length === 0) continue;
			messagesByPath.set(resolve(tab.path), tab.deferredUserMessages.map((message) => this.cloneSubmittedUserMessage(message)));
		}

		for (const tab of this.tabItems) {
			if (!tab.sessionPath) continue;
			const messages = messagesByPath.get(resolve(tab.sessionPath));
			if (!messages || messages.length === 0) continue;
			this.deferredUserMessagesByTabId.set(tab.id, messages);
		}
	}

	private ensureCurrentSessionTab(session: AgentSession): void {
		const currentPath = session.sessionFile ? resolve(session.sessionFile) : undefined;
		if (!currentPath) return;

		const existing = this.tabItems.find((tab) => tab.sessionPath === currentPath);
		if (existing) {
			this.activeTabId = existing.id;
			this.clearTabAttention(existing);
			this.updateTabFromSession(existing, session);
			return;
		}

		const tab = this.tabFromSession(session);
		this.tabItems.unshift(tab);
		this.activeTabId = tab.id;
	}

	private tabFromSession(session: AgentSession, options: { titlePlaceholder?: SessionTab["titlePlaceholder"] } = {}): SessionTab {
		const sessionPath = this.sessionPath(session);
		return {
			id: createId("tab"),
			title: this.sessionTitle(session),
			...(options.titlePlaceholder ? { titlePlaceholder: options.titlePlaceholder } : {}),
			status: "active",
			activity: this.sessionActivity(session),
			...(sessionPath ? { sessionPath } : {}),
		};
	}

	private updateTabFromSession(tab: SessionTab, session: AgentSession): void {
		const previousSessionPath = tab.sessionPath ? resolve(tab.sessionPath) : undefined;
		const sessionPath = this.sessionPath(session);
		tab.title = this.updatedSessionTitle(tab.title, this.sessionTitle(session), previousSessionPath, sessionPath, tab.titlePlaceholder !== undefined);
		tab.activity = this.sessionActivity(session);
		if (sessionPath) tab.sessionPath = sessionPath;
	}

	private sessionPath(session: AgentSession): string | undefined {
		return session.sessionFile ? resolve(session.sessionFile) : undefined;
	}

	private sessionTitle(session: AgentSession): string {
		return this.sessionTitleFromParts(session.sessionId, session.sessionName);
	}

	private sessionTitleFromParts(sessionId: string, sessionName: string | undefined): string {
		const name = sessionName?.trim();
		return name && !LOADING_TAB_TITLE_PATTERN.test(name) ? name : `session ${sessionId.slice(0, 8)}`;
	}

	private updatedSessionTitle(
		currentTitle: string,
		nextTitle: string,
		currentSessionPath: string | undefined,
		nextSessionPath: string | undefined,
		hasTitlePlaceholder: boolean,
	): string {
		if (!isDefaultSessionTitle(nextTitle)) return nextTitle;
		if (hasTitlePlaceholder) return nextTitle;
		if (currentSessionPath !== undefined && nextSessionPath !== undefined && currentSessionPath !== nextSessionPath) return nextTitle;
		return validSessionTitle(currentTitle) && !isDefaultSessionTitle(currentTitle) ? currentTitle : nextTitle;
	}

	private sessionActivity(session: AgentSession | undefined): SessionActivity {
		return session?.isStreaming || session?.isCompacting ? "running" : "idle";
	}

	private tabActivity(tab: SessionTab): SessionActivity {
		if (tab.id === this.pendingActiveTabId) return "thinking";
		const runtime = this.runtimesByTabId.get(tab.id);
		return runtime ? this.sessionActivity(runtime.session) : tab.activity ?? "idle";
	}

	private clearTabAttention(tab: SessionTab): void {
		if (tab.attention === undefined && tab.attentionVisible === undefined) return;
		delete tab.attention;
		delete tab.attentionVisible;
		this.stopAttentionBlinkIfIdle();
	}

	private startAttentionBlink(): void {
		this.host.blinkController.setActive(TAB_ATTENTION_BLINK_KEY, true, {
			scope: "full",
			initialVisible: true,
		});
	}

	private stopAttentionBlinkIfIdle(): void {
		if (this.tabItems.some((tab) => tab.attention !== undefined)) return;
		this.host.blinkController.setActive(TAB_ATTENTION_BLINK_KEY, false, {
			scope: "full",
			initialVisible: true,
		});
	}

	private restoredTabs(saved: PersistedTabState, sessionTitles: ReadonlyMap<string, string> = new Map()): SessionTab[] {
		const tabs: SessionTab[] = [];
		const seen = new Set<string>();
		for (const tab of saved.tabs) {
			const sessionPath = resolve(tab.path);
			const hasDraftInput = (tab.input?.text.length ?? 0) > 0;
			const hasDeferredQueue = (tab.deferredUserMessages?.length ?? 0) > 0;
			if (seen.has(sessionPath) || (!existsSync(sessionPath) && !hasDraftInput && !hasDeferredQueue)) continue;
			seen.add(sessionPath);
			const savedTitle = tab.title?.trim();
			const restoredLoadingTitle = savedTitle !== undefined && LOADING_TAB_TITLE_PATTERN.test(savedTitle);
			const sessionTitle = validSessionTitle(sessionTitles.get(sessionPath));
			const title = sessionTitle || (restoredLoadingTitle ? this.defaultSessionTitleFromPath(sessionPath) : savedTitle);
			tabs.push({
				id: createId("tab"),
				title: title || "session",
				status: "waiting",
				sessionPath,
			});
			if (tabs.length >= MAX_RESTORED_TABS) break;
		}
		return tabs;
	}

	private defaultSessionTitleFromPath(sessionPath: string): string {
		const fileName = basename(sessionPath, extname(sessionPath));
		const sessionId = /^[0-9a-f]{8}/iu.exec(fileName)?.[0]?.toLowerCase()
			?? createHash("sha256").update(sessionPath).digest("hex").slice(0, 8);
		return `session ${sessionId}`;
	}

	private async loadSessionTitles(sessionPaths: readonly string[]): Promise<ReadonlyMap<string, string>> {
		const uniquePaths = [...new Set(sessionPaths.map((sessionPath) => resolve(sessionPath)))].slice(0, MAX_RESTORED_TABS);
		const entries = await Promise.all(uniquePaths.map(async (sessionPath) => {
			const title = await readLatestSessionTitle(sessionPath);
			return title ? [sessionPath, title] as const : undefined;
		}));
		return new Map(entries.filter((entry): entry is readonly [string, string] => entry !== undefined));
	}

	private scheduleRestoredTabTitleRefresh(sessionPaths: readonly string[]): void {
		if (sessionPaths.length === 0) return;
		setTimeout(() => {
			void this.refreshRestoredTabTitles(sessionPaths);
		}, 0).unref?.();
	}

	private async refreshRestoredTabTitles(sessionPaths: readonly string[]): Promise<void> {
		const titles = await this.loadSessionTitles(sessionPaths);
		if (titles.size === 0) return;

		let changed = false;
		for (const tab of this.tabItems) {
			const sessionPath = tab.sessionPath ? resolve(tab.sessionPath) : undefined;
			const title = sessionPath ? titles.get(sessionPath) : undefined;
			if (!title || tab.title === title) continue;

			tab.title = title;
			delete tab.titlePlaceholder;
			changed = true;
		}

		if (!changed) return;
		void this.saveTabs();
		this.host.render();
	}

	private async loadTabs(): Promise<PersistedTabState | undefined> {
		try {
			const raw = await readFile(this.filePath(), "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== TAB_STATE_VERSION) || !Array.isArray(parsed.tabs)) return undefined;

			const tabs: PersistedTab[] = [];
			for (const value of parsed.tabs) {
				if (!isRecord(value) || typeof value.path !== "string") continue;
				const input = this.parsePersistedInputState(value.input);
				const deferredUserMessages = this.parsePersistedSubmittedUserMessages(value.deferredUserMessages);
				tabs.push({
					path: value.path,
					...(typeof value.title === "string" ? { title: value.title } : {}),
					...(input ? { input } : {}),
					...(deferredUserMessages.length > 0 ? { deferredUserMessages } : {}),
				});
			}

			return {
				version: parsed.version === 1 ? 1 : parsed.version === 2 ? 2 : TAB_STATE_VERSION,
				cwd: typeof parsed.cwd === "string" ? parsed.cwd : this.host.options.cwd,
				tabs,
				...(typeof parsed.activePath === "string" ? { activePath: parsed.activePath } : {}),
			};
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			return undefined;
		}
	}

	private parsePersistedInputState(value: unknown): TabInputState | undefined {
		if (!isRecord(value) || typeof value.text !== "string") return undefined;
		const cursor = typeof value.cursor === "number" && Number.isFinite(value.cursor)
			? Math.max(0, Math.min(value.text.length, Math.trunc(value.cursor)))
			: value.text.length;
		const attachments = Array.isArray(value.attachments)
			? value.attachments.flatMap(parsePersistedAttachment)
			: [];
		return { text: value.text, cursor, ...(attachments.length > 0 ? { attachments } : {}) };
	}

	private parsePersistedSubmittedUserMessages(value: unknown): PersistedSubmittedUserMessage[] {
		if (!Array.isArray(value)) return [];
		const messages: PersistedSubmittedUserMessage[] = [];
		for (const item of value) {
			if (!isRecord(item) || typeof item.promptText !== "string" || typeof item.displayText !== "string") continue;
			const images = Array.isArray(item.images)
				? item.images.flatMap((image): Array<{ type: "image"; data: string; mimeType: string }> => (
					isRecord(image) && typeof image.data === "string" && typeof image.mimeType === "string"
						? [{ type: "image", data: image.data, mimeType: image.mimeType }]
						: []
				))
				: [];
			messages.push({
				id: typeof item.id === "string" ? item.id : createId("queued-user"),
				promptText: item.promptText,
				displayText: item.displayText,
				images,
			});
		}
		return messages;
	}

	private async saveTabs(): Promise<void> {
		if (this.host.options.noSession) return;

		try {
			const tabs: PersistedTab[] = [];
			const seen = new Set<string>();
			for (const tab of this.tabItems) {
				if (!tab.sessionPath) continue;
				const sessionPath = resolve(tab.sessionPath);
				if (seen.has(sessionPath)) continue;
				seen.add(sessionPath);
				const persistedTab: PersistedTab = { path: sessionPath, title: tab.title };
				const input = this.inputStatesByTabId.get(tab.id);
				if (input && (input.text.length > 0 || (input.attachments?.length ?? 0) > 0)) {
					persistedTab.input = {
						text: input.text,
						cursor: Math.max(0, Math.min(input.text.length, Math.trunc(input.cursor))),
						...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments.map(clonePersistedAttachment) } : {}),
					};
				}
				const deferredUserMessages = this.deferredUserMessagesByTabId.get(tab.id);
				if (deferredUserMessages && deferredUserMessages.length > 0) {
					persistedTab.deferredUserMessages = deferredUserMessages.map((message) => this.cloneSubmittedUserMessage(message));
				}
				tabs.push(persistedTab);
			}
			if (tabs.length === 0) return;

			const activePath = this.activeTab()?.sessionPath;
			const payload = JSON.stringify({
				version: TAB_STATE_VERSION,
				cwd: this.host.options.cwd,
				tabs,
				...(activePath ? { activePath: resolve(activePath) } : {}),
			}, null, 2);
			const filePath = this.filePath();
			await mkdir(dirname(filePath), { recursive: true });
			const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
			await writeFile(tempPath, payload, "utf8");
			await rename(tempPath, filePath);
		} catch {
			// Tab state should never interrupt the terminal UI.
		}
	}

	private filePath(): string {
		const key = createHash("sha256").update(resolve(this.host.options.cwd)).digest("hex").slice(0, 24);
		return join(getAgentDir(), "pix", "tabs", `${key}.json`);
	}

	private sessionDir(): string {
		const safePath = `--${resolve(this.host.options.cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		return join(getAgentDir(), "sessions", safePath);
	}

	private scheduleProjectSessionRetention(): void {
		if (this.host.options.noSession || this.maxProjectSessions() <= 0 || this.retentionCleanupScheduled || this.retentionCleanupRunning) return;
		this.retentionCleanupScheduled = true;
		setTimeout(() => {
			this.retentionCleanupScheduled = false;
			void this.cleanupOldProjectSessions();
		}, 0);
	}

	private scheduleTabPrewarm(): void {
		if (this.host.options.noSession || this.prewarmScheduled || this.prewarmRunning) return;
		this.prewarmScheduled = true;
		setTimeout(() => {
			this.prewarmScheduled = false;
			void this.prewarmTabs();
		}, 0);
	}

	private async prewarmTabs(): Promise<void> {
		if (this.prewarmRunning || this.pendingActiveTabId || !this.host.isRunning()) return;
		this.prewarmRunning = true;
		try {
			let warmed = 0;
			for (const tab of this.tabItems) {
				if (warmed >= BACKGROUND_PREWARM_TAB_LIMIT) break;
				if (tab.id === this.activeTabId || !tab.sessionPath) continue;
				if (this.runtimesByTabId.has(tab.id) || this.runtimeLoadsByTabId.has(tab.id)) continue;
				const runtime = await this.runtimeForTab(tab).catch(() => undefined);
				if (!runtime) continue;
				warmed += 1;
			}
		} finally {
			this.prewarmRunning = false;
		}
	}

	private async cleanupOldProjectSessions(): Promise<void> {
		if (this.retentionCleanupRunning) return;
		this.retentionCleanupRunning = true;
		try {
			const maxProjectSessions = this.maxProjectSessions();
			if (maxProjectSessions <= 0) return;

			const sessionDir = this.sessionDir();
			const preserved = this.preservedSessionPaths();
			const entries = await readdir(sessionDir, { withFileTypes: true });
			const sessions: Array<{ path: string; modifiedMs: number }> = [];
			for (const entry of entries) {
				if (!entry.isFile() || extname(entry.name) !== ".jsonl") continue;
				const path = resolve(sessionDir, entry.name);
				try {
					const info = await stat(path);
					sessions.push({ path, modifiedMs: info.mtimeMs });
				} catch {
					// Ignore files that disappear while cleanup is scanning.
				}
			}

			if (sessions.length <= maxProjectSessions) return;
			sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
			const keep = new Set(preserved);
			for (const session of sessions) {
				if (keep.size >= maxProjectSessions) break;
				keep.add(session.path);
			}

			for (const session of sessions) {
				if (keep.has(session.path)) continue;
				try {
					await unlink(session.path);
				} catch {
					// Session retention must never interrupt the terminal UI.
				}
			}
		} catch {
			// Session retention must never interrupt the terminal UI.
		} finally {
			this.retentionCleanupRunning = false;
		}
	}

	private preservedSessionPaths(): Set<string> {
		const preserved = new Set<string>();
		const add = (sessionPath: string | undefined): void => {
			if (sessionPath) preserved.add(resolve(sessionPath));
		};

		add(this.host.options.sessionPath);
		add(this.host.runtime()?.session.sessionFile);
		for (const tab of this.tabItems) add(tab.sessionPath);
		return preserved;
	}

	private maxProjectSessions(): number {
		const configured = this.host.maxProjectSessions;
		const value = typeof configured === "function" ? configured() : configured;
		return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
	}
}

function parsePersistedAttachment(value: unknown): Attachment[] {
	if (!isRecord(value) || typeof value.kind !== "string" || typeof value.tag !== "string") return [];
	if (value.kind === "image") {
		const image = parsePersistedImage(value.image);
		return image ? [{ kind: "image", tag: value.tag, image }] : [];
	}
	if (value.kind === "pasted-text") {
		if (typeof value.text !== "string" || typeof value.lineCount !== "number" || !Number.isFinite(value.lineCount)) return [];
		return [{ kind: "pasted-text", tag: value.tag, text: value.text, lineCount: Math.max(1, Math.trunc(value.lineCount)) }];
	}
	if (value.kind === "file") {
		if (typeof value.path !== "string") return [];
		const image = parsePersistedImage(value.image);
		return [{
			kind: "file",
			tag: value.tag,
			path: value.path,
			...(typeof value.content === "string" ? { content: value.content } : {}),
			...(image ? { image } : {}),
		}];
	}
	return [];
}

function parsePersistedImage(value: unknown): { type: "image"; data: string; mimeType: string } | undefined {
	return isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
		? { type: "image", data: value.data, mimeType: value.mimeType }
		: undefined;
}

async function readLatestSessionTitle(sessionPath: string): Promise<string | undefined> {
	let file: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		file = await openFile(sessionPath, "r");
		const { size } = await file.stat();
		if (size <= 0) return undefined;

		const byteCount = Math.min(size, SESSION_TITLE_SCAN_MAX_BYTES);
		const buffer = Buffer.alloc(byteCount);
		await file.read(buffer, 0, byteCount, size - byteCount);

		const text = buffer.toString("utf8");
		const lines = text.split("\n");
		if (size > byteCount) lines.shift();

		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index]?.trim();
			if (!line) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}

			if (!isRecord(parsed) || parsed.type !== "session_info" || typeof parsed.name !== "string") continue;
			return validSessionTitle(parsed.name);
		}
	} catch {
		return undefined;
	} finally {
		await file?.close();
	}

	return undefined;
}

function validSessionTitle(value: string | undefined): string | undefined {
	const title = value?.trim();
	return title && !LOADING_TAB_TITLE_PATTERN.test(title) ? title : undefined;
}

function isDefaultSessionTitle(value: string): boolean {
	return DEFAULT_SESSION_TITLE_PATTERN.test(value.trim());
}

function clonePersistedAttachment(attachment: Attachment): Attachment {
	if (attachment.kind === "image") return { kind: "image", tag: attachment.tag, image: { ...attachment.image } };
	if (attachment.kind === "pasted-text") return { kind: "pasted-text", tag: attachment.tag, text: attachment.text, lineCount: attachment.lineCount };
	return {
		kind: "file",
		tag: attachment.tag,
		path: attachment.path,
		...(attachment.content === undefined ? {} : { content: attachment.content }),
		...(attachment.image === undefined ? {} : { image: { ...attachment.image } }),
	};
}
