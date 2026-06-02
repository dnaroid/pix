import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { AppTabsController } from "../src/app/session/tabs-controller.js";
import type { AppBlinkController } from "../src/app/screen/blink-controller.js";
import type { AppOptions, SessionTab } from "../src/app/types.js";
import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

type FakeAgentSessionRuntime = AgentSessionRuntime & {
	emitSessionEvent(event: AgentSessionEvent): void;
};

describe("AppTabsController", () => {
	it("switches tabs even when the active runtime is streaming", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl", { isStreaming: true });
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		const toasts: string[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => targetRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: (message) => {
				toasts.push(message);
			},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		await controller.switchToTab("tab-2");

		assert.equal(currentRuntime, targetRuntime);
		assert.equal(tabs.activeTabId, "tab-2");
		assert.deepEqual(toasts, []);
	});

	it("marks the target tab active while its runtime is still loading", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		let resolveRuntime: (runtime: AgentSessionRuntime) => void = () => {};
		const runtimePromise = new Promise<AgentSessionRuntime>((resolve) => {
			resolveRuntime = resolve;
		});
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => runtimePromise,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		const switchPromise = controller.switchToTab("tab-2");

		assert.equal(controller.isSwitching(), true);
		assert.equal(currentRuntime, activeRuntime);
		assert.equal(controller.tabs().find((tab) => tab.id === "tab-2")?.status, "active");
		assert.equal(controller.tabs().find((tab) => tab.id === "tab-2")?.activity, "thinking");

		resolveRuntime(targetRuntime);
		await switchPromise;

		assert.equal(controller.isSwitching(), false);
		assert.equal(currentRuntime, targetRuntime);
		assert.equal(tabs.activeTabId, "tab-2");
	});

	it("preserves draft input text and cursor per tab", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		let currentInput = { text: "draft one", cursor: 5 };
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => targetRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => currentInput,
			restoreInputState: (state) => {
				currentInput = state;
			},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
			inputStatesByTabId: Map<string, { text: string; cursor: number }>;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);
		tabs.inputStatesByTabId.set("tab-2", { text: "draft two", cursor: 9 });

		await controller.switchToTab("tab-2");

		assert.deepEqual(tabs.inputStatesByTabId.get("tab-1"), { text: "draft one", cursor: 5 });
		assert.deepEqual(currentInput, { text: "draft two", cursor: 9 });
		assert.equal(tabs.activeTabId, "tab-2");
	});

	it("persists and restores draft input text after startup", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-"));
		const sessionPath = join(dir, "one.jsonl");
		const tabsPath = join(dir, "tabs.json");
		await writeFile(sessionPath, "", "utf8");

		let currentRuntime = fakeRuntime("one", sessionPath);
		let currentInput = { text: "draft one", cursor: 7 };
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
			createRuntimeForSession: async (path) => fakeRuntime("one", path),
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => currentInput,
			restoreInputState: (state) => {
				currentInput = state;
			},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			filePath: () => string;
			loadSessionTitles: () => Promise<ReadonlyMap<string, string>>;
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
		};
		tabs.filePath = () => tabsPath;
		tabs.loadSessionTitles = async () => new Map([[sessionPath, "one"]]);
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", currentRuntime);

		await controller.disposeInactiveRuntimes();

		const saved = JSON.parse(await readFile(tabsPath, "utf8")) as {
			version: number;
			tabs: Array<{ input?: { text: string; cursor: number } }>;
		};
		assert.equal(saved.version, 2);
		assert.deepEqual(saved.tabs[0]?.input, { text: "draft one", cursor: 7 });

		currentInput = { text: "", cursor: 0 };
		const restoredController = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
			createRuntimeForSession: async (path) => fakeRuntime("one", path),
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => currentInput,
			restoreInputState: (state) => {
				currentInput = state;
			},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const restoredTabs = restoredController as unknown as {
			filePath: () => string;
			loadSessionTitles: () => Promise<ReadonlyMap<string, string>>;
		};
		restoredTabs.filePath = () => tabsPath;
		restoredTabs.loadSessionTitles = async () => new Map([[sessionPath, "one"]]);

		await restoredController.restoreAfterStartup();

		assert.deepEqual(currentInput, { text: "draft one", cursor: 7 });
	});

	it("restores a draft-only tab even when its session file has not been flushed yet", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-"));
		const existingSessionPath = join(dir, "one.jsonl");
		const draftSessionPath = join(dir, "draft-only.jsonl");
		const tabsPath = join(dir, "tabs.json");
		await writeFile(existingSessionPath, "", "utf8");
		await writeFile(tabsPath, JSON.stringify({
			version: 2,
			cwd: dir,
			activePath: draftSessionPath,
			tabs: [
				{ path: existingSessionPath, title: "one" },
				{ path: draftSessionPath, title: "draft tab", input: { text: "unsent draft", cursor: 6 } },
			],
		}), "utf8");

		let currentRuntime = fakeRuntime("one", existingSessionPath);
		let currentInput = { text: "", cursor: 0 };
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
			createRuntimeForSession: async (path) => fakeRuntime("one", path),
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => currentInput,
			restoreInputState: (state) => {
				currentInput = state;
			},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			filePath: () => string;
			loadSessionTitles: () => Promise<ReadonlyMap<string, string>>;
		};
		tabs.filePath = () => tabsPath;
		tabs.loadSessionTitles = async () => new Map([[existingSessionPath, "one"]]);

		await controller.restoreAfterStartup();

		assert.equal(currentRuntime.session.sessionFile, draftSessionPath);
		assert.equal(controller.tabs().length, 2);
		assert.equal(controller.tabs().some((tab) => tab.sessionPath === existingSessionPath), true);
		assert.deepEqual(currentInput, { text: "unsent draft", cursor: 6 });
	});

	it("saves active draft input explicitly during quit", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-"));
		const sessionPath = join(dir, "one.jsonl");
		const tabsPath = join(dir, "tabs.json");
		const currentRuntime = fakeRuntime("one", sessionPath);
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
			createRuntimeForSession: async (path) => fakeRuntime("one", path),
			activateRuntime: async () => {},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "quit draft", cursor: 4 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			filePath: () => string;
		};
		tabs.filePath = () => tabsPath;

		await controller.saveInputStateForQuit();

		const saved = JSON.parse(await readFile(tabsPath, "utf8")) as {
			tabs: Array<{ path: string; input?: { text: string; cursor: number } }>;
		};
		assert.equal(saved.tabs[0]?.path, sessionPath);
		assert.deepEqual(saved.tabs[0]?.input, { text: "quit draft", cursor: 4 });
	});

	it("clears a persisted active draft when the active input state is emptied", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-"));
		const sessionPath = join(dir, "one.jsonl");
		const tabsPath = join(dir, "tabs.json");
		const currentRuntime = fakeRuntime("one", sessionPath);
		let currentInput = { text: "sent draft", cursor: 10 };
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
			createRuntimeForSession: async (path) => fakeRuntime("one", path),
			activateRuntime: async () => {},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => currentInput,
			restoreInputState: (state) => {
				currentInput = state;
			},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			filePath: () => string;
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
			inputStatesByTabId: Map<string, { text: string; cursor: number }>;
		};
		tabs.filePath = () => tabsPath;
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", currentRuntime);
		tabs.inputStatesByTabId.set("tab-1", { text: "sent draft", cursor: 10 });

		await controller.setInputStateForTab("tab-1", { text: "", cursor: 0 });

		const saved = JSON.parse(await readFile(tabsPath, "utf8")) as {
			tabs: Array<{ input?: { text: string; cursor: number } }>;
		};
		assert.equal(saved.tabs[0]?.input, undefined);
		assert.deepEqual(currentInput, { text: "", cursor: 0 });
	});

	it("opens a new tab even when the active runtime is streaming", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl", { isStreaming: true });
		const newRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		const toasts: string[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => newRuntime,
			createRuntimeForSession: async () => activeRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: (message) => {
				toasts.push(message);
			},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
			saveTabs: () => Promise<void>;
		};
		tabs.saveTabs = async () => {};
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		await controller.openNewTab();

		assert.equal(currentRuntime, newRuntime);
		assert.equal(tabs.tabItems.length, 2);
		assert.equal(tabs.activeTabId, tabs.tabItems[1]?.id);
		assert.equal(tabs.runtimesByTabId.get("tab-1"), activeRuntime);
		assert.equal(tabs.runtimesByTabId.get(tabs.activeTabId ?? ""), newRuntime);
		assert.deepEqual(toasts, []);
	});

	it("marks explicit new tabs with the New title placeholder", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const newRuntime = fakeRuntime("019e7d3fabc", "/tmp/two.jsonl", { sessionName: undefined });
		let currentRuntime = activeRuntime;
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => newRuntime,
			createRuntimeForSession: async () => activeRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
			saveTabs: () => Promise<void>;
		};
		tabs.saveTabs = async () => {};
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		await controller.openNewTab();

		const newTab = tabs.tabItems.find((tab) => tab.sessionPath === resolve("/tmp/two.jsonl"));
		assert.equal(newTab?.title, "session 019e7d3f");
		assert.equal(newTab?.titlePlaceholder, "new");
	});

	it("marks the initial startup tab with the Loading title placeholder", () => {
		const runtime = fakeRuntime("019e7d3fabc", "/tmp/one.jsonl", { sessionName: undefined });
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => runtime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => runtime,
			activateRuntime: async () => {},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});

		controller.syncActiveTabFromRuntime({ save: false });

		const tab = controller.tabs()[0];
		assert.equal(tab?.title, "session 019e7d3f");
		assert.equal(tab?.titlePlaceholder, "loading");
	});

	it("keeps the previous tab when activation renders during new tab creation", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const newRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		let renderedTabPaths: Array<string | undefined> = [];
		let controller!: AppTabsController;
		controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => newRuntime,
			createRuntimeForSession: async () => activeRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
				renderedTabPaths = controller.tabs().map((tab) => tab.sessionPath);
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
			saveTabs: () => Promise<void>;
		};
		tabs.saveTabs = async () => {};
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		await controller.openNewTab();

		assert.deepEqual(renderedTabPaths, [resolve("/tmp/one.jsonl"), resolve("/tmp/two.jsonl")]);
		assert.equal(tabs.tabItems.length, 2);
		assert.equal(tabs.tabItems[0]?.sessionPath, resolve("/tmp/one.jsonl"));
		assert.equal(tabs.tabItems[1]?.sessionPath, resolve("/tmp/two.jsonl"));
		assert.equal(tabs.activeTabId, tabs.tabItems[1]?.id);
	});

	it("reuses an existing tab when the active runtime switches to an already-open session", () => {
		const switchedRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => switchedRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => switchedRuntime,
			activateRuntime: async () => {},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", switchedRuntime);

		controller.syncActiveTabFromRuntime({ save: false });

		assert.equal(tabs.tabItems.length, 2);
		assert.equal(tabs.tabItems[0]?.sessionPath, "/tmp/one.jsonl");
		assert.equal(tabs.activeTabId, "tab-2");
		assert.equal(tabs.runtimesByTabId.has("tab-1"), false);
		assert.equal(tabs.runtimesByTabId.get("tab-2"), switchedRuntime);
	});

	it("updates the active tab title when the session name changes", () => {
		const runtime = fakeRuntime("one", "/tmp/one.jsonl");
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => runtime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => runtime,
			activateRuntime: async () => {},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
		};
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", runtime);

		(runtime.session as unknown as { sessionName: string }).sessionName = "Renamed session";
		controller.syncActiveTabFromRuntime({ save: false });

		assert.equal(tabs.tabItems[0]?.title, "Renamed session");
	});

	it("starts a new session when closing the last tab", async () => {
		const runtime = fakeRuntime("one", "/tmp/one.jsonl", { newSessionFile: "/tmp/new.jsonl", newSessionName: "new session" }) as FakeAgentSessionRuntime;
		let resetCount = 0;
		const restoredInputs: Array<{ text: string; cursor: number }> = [];
		const entries: string[] = [];
		const toasts: string[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => runtime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => runtime,
			activateRuntime: async () => {},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {
				resetCount += 1;
			},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "draft", cursor: 5 }),
			restoreInputState: (state) => {
				restoredInputs.push(state);
			},
			addEntry: (entry) => {
				if ("text" in entry) entries.push(entry.text);
			},
			showToast: (message) => {
				toasts.push(message);
			},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
			saveTabs: () => Promise<void>;
		};
		tabs.saveTabs = async () => {};
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", runtime);

		controller.syncActiveTabFromRuntime({ save: false });
		await controller.closeTab("tab-1");

		assert.equal(tabs.tabItems.length, 1);
		assert.equal(tabs.activeTabId, "tab-1");
		assert.equal(tabs.tabItems[0]?.sessionPath, resolve("/tmp/new.jsonl"));
		assert.equal(tabs.tabItems[0]?.title, "new session");
		assert.equal(resetCount, 1);
		assert.deepEqual(restoredInputs[restoredInputs.length - 1], { text: "", cursor: 0 });
		assert.deepEqual(toasts, []);
		assert.deepEqual(entries, ["Started a new session. cwd=/tmp"]);

		(runtime.session as unknown as { sessionName: string }).sessionName = "renamed new";
		runtime.emitSessionEvent({ type: "session_info_changed" } as AgentSessionEvent);

		assert.equal(tabs.tabItems[0]?.title, "renamed new");
	});

	it("updates an inactive tab title when its runtime session name changes", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl") as FakeAgentSessionRuntime;
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime: AgentSessionRuntime = activeRuntime;
		let renderCount = 0;
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => targetRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {
				renderCount += 1;
			},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";

		controller.syncActiveTabFromRuntime({ save: false });
		await controller.switchToTab("tab-2");

		(activeRuntime.session as unknown as { sessionName: string }).sessionName = "Generated background title";
		activeRuntime.emitSessionEvent({ type: "session_info_changed", name: "Generated background title" });

		assert.equal(tabs.activeTabId, "tab-2");
		assert.equal(tabs.tabItems.find((tab) => tab.id === "tab-1")?.title, "Generated background title");
		assert.equal(renderCount > 0, true);
	});

	it("marks an inactive tab for terminal-bell attention until it is activated", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		let renderCount = 0;
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => targetRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {
				renderCount += 1;
			},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		controller.markTerminalBellAttention("/tmp/two.jsonl");

		assert.equal(controller.tabs().find((tab) => tab.id === "tab-2")?.attention, "terminal-bell");
		assert.equal(renderCount, 1);

		await controller.switchToTab("tab-2");

		assert.equal(controller.tabs().find((tab) => tab.id === "tab-2")?.attention, undefined);
	});
});

function fakeRuntime(
	sessionId: string,
	sessionFile: string,
	options: { isStreaming?: boolean; sessionName?: string; newSessionFile?: string; newSessionName?: string } = {},
): AgentSessionRuntime {
	const createSession = (id: string, file: string, name: string | undefined) => {
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		return {
			sessionId: id,
			sessionName: name,
			sessionFile: file,
			isStreaming: options.isStreaming === true,
			isCompacting: false,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {
					const index = listeners.indexOf(listener);
					if (index >= 0) listeners.splice(index, 1);
				};
			},
			emit: (event: AgentSessionEvent) => {
				for (const listener of [...listeners]) listener(event);
			},
		};
	};
	const runtime: {
		cwd: string;
		modelFallbackMessage: undefined;
		session: ReturnType<typeof createSession>;
		switchSession(path: string): Promise<{ cancelled: false }>;
		newSession(): Promise<{ cancelled: false }>;
		emitSessionEvent(event: AgentSessionEvent): void;
	} = {
		cwd: "/tmp",
		modelFallbackMessage: undefined,
		session: createSession(sessionId, sessionFile, Object.prototype.hasOwnProperty.call(options, "sessionName") ? options.sessionName : sessionId),
		switchSession: async (path: string) => {
			(runtime.session as { sessionFile: string }).sessionFile = path;
			return { cancelled: false };
		},
		newSession: async () => {
			runtime.session = createSession(
				"new",
				options.newSessionFile ?? "/tmp/new.jsonl",
				Object.prototype.hasOwnProperty.call(options, "newSessionName") ? options.newSessionName : "new",
			);
			return { cancelled: false };
		},
		emitSessionEvent: (event: AgentSessionEvent) => {
			runtime.session.emit(event);
		},
	};
	return runtime as unknown as AgentSessionRuntime;
}

function fakeBlinkController(): AppBlinkController {
	let visible = true;
	return {
		setActive: (_key: string, _active: boolean, options: { initialVisible?: boolean }) => {
			visible = options.initialVisible ?? true;
		},
		visible: () => visible,
		dispose: () => {},
	} as unknown as AppBlinkController;
}
