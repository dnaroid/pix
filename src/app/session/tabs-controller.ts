import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
	getAgentDir,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../guards.js";
import { createId } from "../id.js";
import { createStartupInfoMessage, isEmptyStartupSession } from "../cli/startup-info.js";
import type { AppBlinkController } from "../screen/blink-controller.js";
import { tabPanelRows } from "../rendering/tab-line-renderer.js";
import type { AppOptions, Entry, SessionActivity, SessionTab, SubmittedUserMessage } from "../types.js";

const TAB_STATE_VERSION = 3;
const MAX_RESTORED_TABS = 8;
const MAX_PROJECT_SESSIONS = 20;
const TAB_ATTENTION_BLINK_KEY = "tab-attention";
const LOADING_TAB_TITLE_PATTERN = /^loading(?:…|\.\.\.)?$/iu;

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

export type TabInputState = {
	text: string;
	cursor: number;
};

export type AppTabsControllerHost = {
	readonly options: AppOptions;
	readonly blinkController: AppBlinkController;
	runtime(): AgentSessionRuntime | undefined;
	createRuntimeForNewSession(): Promise<AgentSessionRuntime>;
	createRuntimeForSession(sessionPath: string): Promise<AgentSessionRuntime>;
	activateRuntime(runtime: AgentSessionRuntime): Promise<void>;
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
	private readonly runtimeSubscriptionsByTabId = new Map<string, { runtime: AgentSessionRuntime; session: AgentSession; unsubscribe: () => void }>();
	private readonly inputStatesByTabId = new Map<string, TabInputState>();
	private readonly deferredUserMessagesByTabId = new Map<string, SubmittedUserMessage[]>();
	private activeTabId: string | undefined;
	private pendingActiveTabId: string | undefined;
	private historyLoadGeneration = 0;
	private restored = false;
	private retentionCleanupRunning = false;
	private retentionCleanupScheduled = false;

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
		const nextState = {
			text: state.text,
			cursor: Math.max(0, Math.min(state.text.length, Math.trunc(state.cursor))),
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
			const tab = this.tabFromSession(session, { titlePlaceholder: this.restored ? "new" : "loading" });
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
			this.settleStartupTabPlaceholders();
			return;
		}

		const saved = await this.loadTabs();
		if (!saved || saved.tabs.length === 0) {
			this.settleStartupTabPlaceholders();
			await this.saveTabs();
			return;
		}

		const restoredTabs = this.restoredTabs(saved);
		if (restoredTabs.length === 0) {
			this.settleStartupTabPlaceholders();
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
		if (explicitSessionPath && currentPath) this.ensureCurrentSessionTab(runtime.session);

		if (!desiredPath) {
			this.settleStartupTabPlaceholders();
			await this.saveTabs();
			this.scheduleProjectSessionRetention();
			return;
		}

		let restoredRuntime = runtime;
		if (currentPath !== desiredPath) {
			this.host.setStatus("restoring tabs");
			this.host.render();
			try {
				restoredRuntime = await this.host.createRuntimeForSession(desiredPath);
				await this.host.activateRuntime(restoredRuntime);
			} catch {
				this.host.showToast("Could not restore the previous active tab", "warning");
				this.replaceTabs([this.tabFromSession(runtime.session), ...restoredTabs], currentPath);
				this.storeActiveRuntime(runtime);
				this.settleStartupTabPlaceholders();
				await this.saveTabs();
				this.scheduleProjectSessionRetention();
				return;
			}
		}

		this.syncActiveTabFromRuntime({ save: false });
		this.settleStartupTabPlaceholders();
		this.host.resetSessionView();
		if (this.activeTabId) this.restoreDeferredUserMessages(this.activeTabId);
		this.host.loadSessionHistory();
		this.host.setSessionStatus(restoredRuntime.session);
		this.host.setSessionActivity(this.sessionActivity(restoredRuntime.session));
		if (this.activeTabId) this.restoreInputState(this.activeTabId);
		await this.saveTabs();
		this.scheduleProjectSessionRetention();
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
		this.host.setStatus("starting new tab");
		this.host.render();

		const newRuntime = await this.host.createRuntimeForNewSession();
		const existingTab = this.findTabForSession(newRuntime.session);
		const tab = existingTab ?? this.tabFromSession(newRuntime.session, { titlePlaceholder: "new" });
		if (!existingTab) this.tabItems.push(tab);
		this.activeTabId = tab.id;
		this.pendingActiveTabId = tab.id;
		this.clearTabAttention(tab);
		this.updateTabFromSession(tab, newRuntime.session);
		this.setRuntimeForTab(tab.id, newRuntime);
		this.restoreInputState(tab.id);
		this.host.closeMenusForTabSwitch?.();
		try {
			await this.host.activateRuntime(newRuntime);
		} finally {
			if (this.pendingActiveTabId === tab.id) this.pendingActiveTabId = undefined;
		}
		void this.saveTabs();
		this.scheduleProjectSessionRetention();
		this.host.resetSessionView();
		this.restoreDeferredUserMessages(tab.id);
		if (isEmptyStartupSession(newRuntime)) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: createStartupInfoMessage(newRuntime) });
		} else {
			this.host.addEntry({ id: createId("system"), kind: "system", text: `Opened a new tab. cwd=${newRuntime.cwd}` });
		}
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

		let newRuntime: AgentSessionRuntime;
		try {
			newRuntime = await this.host.createRuntimeForSession(resolvedSessionPath);
		} catch {
			this.host.showToast("Could not open session tab", "warning");
			this.host.setSessionStatus(previousRuntime.session);
			this.host.render();
			return false;
		}

		const tab = this.tabFromSession(newRuntime.session, { titlePlaceholder: "loading" });
		this.tabItems.push(tab);
		this.activeTabId = tab.id;
		this.pendingActiveTabId = tab.id;
		this.clearTabAttention(tab);
		this.updateTabFromSession(tab, newRuntime.session);
		this.setRuntimeForTab(tab.id, newRuntime);
		this.restoreInputState(tab.id);
		this.host.closeMenusForTabSwitch?.();

		try {
			await this.host.activateRuntime(newRuntime);
		} catch {
			this.pendingActiveTabId = undefined;
			this.removeTab(tab.id);
			this.activeTabId = previousTabId;
			if (previousTabId) this.restoreInputState(previousTabId);
			this.host.closeMenusForTabSwitch?.();
			if (this.host.runtime() !== previousRuntime) {
				try {
					await this.host.activateRuntime(previousRuntime);
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

		try {
			await this.host.activateRuntime(forkRuntime);
		} catch {
			this.pendingActiveTabId = undefined;
			this.removeTab(tab.id);
			this.activeTabId = previousTabId;
			if (previousTabId) this.restoreInputState(previousTabId);
			this.host.closeMenusForTabSwitch?.();
			if (this.host.runtime() !== previousRuntime) {
				try {
					await this.host.activateRuntime(previousRuntime);
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
			await this.host.activateRuntime(targetRuntime);
		} catch {
			this.pendingActiveTabId = undefined;
			if (previousTargetActivity === undefined) delete target.activity;
			else target.activity = previousTargetActivity;
			this.activeTabId = previousTabId;
			if (previousTabId) this.restoreInputState(previousTabId);
			this.host.closeMenusForTabSwitch?.();
			if (this.host.runtime() !== previousRuntime) {
				try {
					await this.host.activateRuntime(previousRuntime);
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
		await this.host.activateRuntime(nextRuntime);

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

	private settleStartupTabPlaceholders(): void {
		for (const tab of this.tabItems) {
			if (tab.titlePlaceholder === "loading") tab.titlePlaceholder = "new";
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
		const subscription = this.runtimeSubscriptionsByTabId.get(tabId);
		subscription?.unsubscribe();
		this.runtimeSubscriptionsByTabId.delete(tabId);
	}

	private clearRuntimeSubscriptions(): void {
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
		this.inputStatesByTabId.set(this.activeTabId, {
			text: state.text,
			cursor: state.cursor,
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
		if (!tab.sessionPath) {
			this.host.showToast("Tab has no persisted session path", "warning");
			return undefined;
		}

		const runtime = await this.host.createRuntimeForSession(tab.sessionPath);
		this.setRuntimeForTab(tab.id, runtime);
		return runtime;
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
		tab.title = this.sessionTitle(session);
		tab.activity = this.sessionActivity(session);
		const sessionPath = this.sessionPath(session);
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

	private restoredTabs(saved: PersistedTabState): SessionTab[] {
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
			const title = restoredLoadingTitle ? this.defaultSessionTitleFromPath(sessionPath) : savedTitle;
			tabs.push({
				id: createId("tab"),
				title: title || "session",
				...(restoredLoadingTitle ? { titlePlaceholder: "new" as const } : {}),
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
		return { text: value.text, cursor };
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
				if (input?.text.length) {
					persistedTab.input = {
						text: input.text,
						cursor: Math.max(0, Math.min(input.text.length, Math.trunc(input.cursor))),
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
		if (this.host.options.noSession || this.retentionCleanupScheduled || this.retentionCleanupRunning) return;
		this.retentionCleanupScheduled = true;
		setTimeout(() => {
			this.retentionCleanupScheduled = false;
			void this.cleanupOldProjectSessions();
		}, 0);
	}

	private async cleanupOldProjectSessions(): Promise<void> {
		if (this.retentionCleanupRunning) return;
		this.retentionCleanupRunning = true;
		try {
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

			if (sessions.length <= MAX_PROJECT_SESSIONS) return;
			sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
			const keep = new Set(preserved);
			for (const session of sessions) {
				if (keep.size >= MAX_PROJECT_SESSIONS) break;
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
}
