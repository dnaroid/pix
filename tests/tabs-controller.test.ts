import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { AppTabsController } from "../src/app/session/tabs-controller.js";
import type { AppBlinkController } from "../src/app/screen/blink-controller.js";
import type { AppOptions, SessionTab, SubmittedUserMessage } from "../src/app/types.js";
import type { InputEditorDraftState } from "../src/input-editor.js";
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

	it("refreshes the active tab title after delayed session name generation", async () => {
		const runtime = fakeRuntime("one", "/tmp/one.jsonl", { sessionName: undefined }) as FakeAgentSessionRuntime;
		let currentRuntime: AgentSessionRuntime = runtime;
		let renderCount = 0;
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => runtime,
			activateRuntime: async (nextRuntime) => {
				currentRuntime = nextRuntime;
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
				renderCount++;
			},
		});

		controller.syncActiveTabFromRuntime({ save: false });
		const tabs = controller as unknown as { tabItems: SessionTab[] };
		assert.equal(tabs.tabItems[0]?.title, "one");

		runtime.emitSessionEvent({ type: "agent_end", messages: [], willRetry: false });
		setTimeout(() => {
			(runtime.session as { sessionName?: string }).sessionName = "Generated title";
		}, 20);

		await waitFor(() => tabs.tabItems[0]?.title === "Generated title");

		assert.equal(tabs.tabItems[0]?.title, "Generated title");
		assert.ok(renderCount > 0);
	});

	it("reloads history once after switching back to a tab that finished in the background", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl") as FakeAgentSessionRuntime;
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl") as FakeAgentSessionRuntime;
		let currentRuntime: AgentSessionRuntime = activeRuntime;
		let historyLoadCount = 0;
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
			loadSessionHistoryAsync: async () => {
				historyLoadCount += 1;
				return true;
			},
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
			setRuntimeForTab(tabId: string, runtime: AgentSessionRuntime): void;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.setRuntimeForTab("tab-1", activeRuntime);
		tabs.setRuntimeForTab("tab-2", targetRuntime);

		targetRuntime.emitSessionEvent({ type: "agent_end", messages: [], willRetry: false });

		await controller.switchToTab("tab-2");
		assert.equal(historyLoadCount, 1);

		await new Promise((resolve) => setTimeout(resolve, 250));

		assert.equal(historyLoadCount, 1);
	});

	it("reloads stale cached tab view before showing a tab that finished in the background", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl") as FakeAgentSessionRuntime;
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl") as FakeAgentSessionRuntime;
		let currentRuntime: AgentSessionRuntime = activeRuntime;
		let historyLoadCount = 0;
		let restoreCachedViewCount = 0;
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
			loadSessionHistoryAsync: async () => {
				historyLoadCount += 1;
				return true;
			},
			syncUserSessionEntryMetadata: () => {},
			captureSessionView: () => fakeSessionView(),
			restoreSessionView: () => {
				restoreCachedViewCount += 1;
			},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			sessionViewsByTabId: Map<string, ReturnType<typeof fakeSessionView>>;
			setRuntimeForTab(tabId: string, runtime: AgentSessionRuntime): void;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.setRuntimeForTab("tab-1", activeRuntime);
		tabs.setRuntimeForTab("tab-2", targetRuntime);
		tabs.sessionViewsByTabId.set("tab-2", fakeSessionView());

		targetRuntime.emitSessionEvent({ type: "agent_end", messages: [], willRetry: false });

		await controller.switchToTab("tab-2");

		assert.equal(currentRuntime, targetRuntime);
		assert.equal(historyLoadCount, 1);
		assert.equal(restoreCachedViewCount, 0);
	});

	it("reloads a cached running tab when inactive events made its view stale", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl", { isStreaming: true }) as FakeAgentSessionRuntime;
		let currentRuntime: AgentSessionRuntime = activeRuntime;
		let historyLoadCount = 0;
		let resetCount = 0;
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
			resetSessionView: () => {
				resetCount += 1;
			},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => {
				historyLoadCount += 1;
				return true;
			},
			syncUserSessionEntryMetadata: () => {},
			captureSessionView: () => fakeSessionView(),
			restoreSessionView: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			addEntry: () => {},
			showToast: () => {},
			render: () => {},
		});
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			sessionViewsByTabId: Map<string, ReturnType<typeof fakeSessionView>>;
			setRuntimeForTab(tabId: string, runtime: AgentSessionRuntime): void;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.setRuntimeForTab("tab-1", activeRuntime);
		tabs.setRuntimeForTab("tab-2", targetRuntime);
		tabs.sessionViewsByTabId.set("tab-2", fakeSessionView());
		targetRuntime.emitSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "apply_patch",
			args: {},
		} as unknown as AgentSessionEvent);

		await controller.switchToTab("tab-2");
		await new Promise((resolve) => setTimeout(resolve, 250));

		assert.equal(currentRuntime, targetRuntime);
		assert.equal(historyLoadCount, 1);
		assert.equal(resetCount, 1);
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

	it("captures the previous tab view before opening a new tab", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const newRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		const capturedView = fakeSessionView({ scrollState: { scrollFromBottom: 9, detachedScrollStart: 23 } });
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => newRuntime,
			createRuntimeForSession: async () => newRuntime,
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
			captureSessionView: () => capturedView,
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
			sessionViewsByTabId: Map<string, ReturnType<typeof fakeSessionView>>;
			saveTabs: () => Promise<void>;
		};
		tabs.saveTabs = async () => {};
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		await controller.openNewTab();

		assert.deepEqual(tabs.sessionViewsByTabId.get("tab-1"), capturedView);
	});

	it("restores the cached scroll position when switching back to a tab", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl", { isStreaming: true });
		let currentRuntime = activeRuntime;
		const restoredViews: unknown[] = [];
		let capturedView = fakeSessionView({ scrollState: { scrollFromBottom: 11, detachedScrollStart: 37 } });
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
			captureSessionView: () => capturedView,
			restoreSessionView: (view) => {
				restoredViews.push(view);
			},
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
			sessionViewsByTabId: Map<string, ReturnType<typeof fakeSessionView>>;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);
		tabs.sessionViewsByTabId.set("tab-2", fakeSessionView({ scrollState: { scrollFromBottom: 4, detachedScrollStart: 18 } }));

		await controller.switchToTab("tab-2");

		assert.deepEqual(tabs.sessionViewsByTabId.get("tab-1"), capturedView);
		assert.deepEqual(restoredViews, [fakeSessionView({ scrollState: { scrollFromBottom: 4, detachedScrollStart: 18 } })]);
		assert.equal(tabs.activeTabId, "tab-2");
	});

	it("captures the previous tab view before opening a fork in a new tab", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl", { forkSessionFile: "/tmp/fork.jsonl" });
		let currentRuntime = activeRuntime;
		const capturedView = fakeSessionView({ scrollState: { scrollFromBottom: 6, detachedScrollStart: 14 } });
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
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
			captureSessionView: () => capturedView,
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
			sessionViewsByTabId: Map<string, ReturnType<typeof fakeSessionView>>;
		};
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		const opened = await controller.forkSessionEntryInNewTab("entry-1");

		assert.equal(opened, true);
		assert.deepEqual(tabs.sessionViewsByTabId.get("tab-1"), capturedView);
	});

	it("closes menus after restoring the target tab input", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		let currentInput = { text: "/model old", cursor: 10 };
		const menuCloseInputs: string[] = [];
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
			closeMenusForTabSwitch: () => {
				menuCloseInputs.push(currentInput.text);
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
		tabs.inputStatesByTabId.set("tab-2", { text: "/thinking target", cursor: 16 });

		await controller.switchToTab("tab-2");

		assert.deepEqual(menuCloseInputs, ["/thinking target"]);
		assert.equal(tabs.activeTabId, "tab-2");
	});

	it("preserves deferred queued messages per tab", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		let currentDeferred: SubmittedUserMessage[] = [submittedMessage("queued one")];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async (path) => path.endsWith("two.jsonl") ? targetRuntime : activeRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
			},
			disposeRuntime: async () => {},
			isRunning: () => true,
			setStatus: () => {},
			setSessionStatus: () => {},
			setSessionActivity: () => {},
			resetSessionView: () => {
				currentDeferred = [];
			},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			captureDeferredUserMessages: () => currentDeferred,
			restoreDeferredUserMessages: (messages) => {
				currentDeferred = messages.map((message) => ({ ...message, images: [...message.images] }));
			},
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

		await controller.switchToTab("tab-2");

		assert.deepEqual(currentDeferred, []);
		currentDeferred = [submittedMessage("queued two")];

		await controller.switchToTab("tab-1");

		assert.deepEqual(currentDeferred.map((message) => message.displayText), ["queued one"]);

		await controller.switchToTab("tab-2");

		assert.deepEqual(currentDeferred.map((message) => message.displayText), ["queued two"]);
	});

	it("persists and restores draft input text and attachments after startup", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-"));
		const sessionPath = join(dir, "one.jsonl");
		const tabsPath = join(dir, "tabs.json");
		await writeFile(sessionPath, "", "utf8");

		let currentRuntime = fakeRuntime("one", sessionPath);
		let currentInput: InputEditorDraftState = {
			text: "draft one [Image 1] ",
			cursor: 17,
			attachments: [{ kind: "image" as const, tag: "[Image 1]", image: { type: "image" as const, data: "base64-image", mimeType: "image/png" } }],
		};
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
			tabs: Array<{ input?: typeof currentInput }>;
		};
		assert.equal(saved.version, 4);
		assert.deepEqual(saved.tabs[0]?.input, currentInput);

		currentInput = { text: "", cursor: 0, attachments: [] };
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

		assert.deepEqual(currentInput, {
			text: "draft one [Image 1] ",
			cursor: 17,
			attachments: [{ kind: "image", tag: "[Image 1]", image: { type: "image", data: "base64-image", mimeType: "image/png" } }],
		});
	});

	it("persists and restores deferred queued messages after startup", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-"));
		const sessionPath = join(dir, "one.jsonl");
		const tabsPath = join(dir, "tabs.json");
		await writeFile(sessionPath, "", "utf8");

		const queued = submittedMessage("queued one");
		queued.images.push({ type: "image", data: "base64-image", mimeType: "image/png" });
		let currentRuntime = fakeRuntime("one", sessionPath);
		let currentDeferred: SubmittedUserMessage[] = [queued];
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
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			captureDeferredUserMessages: () => currentDeferred,
			restoreDeferredUserMessages: (messages) => {
				currentDeferred = messages.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) }));
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
			tabs: Array<{ deferredUserMessages?: SubmittedUserMessage[] }>;
		};
		assert.equal(saved.version, 4);
		assert.deepEqual(saved.tabs[0]?.deferredUserMessages?.map((message) => message.displayText), ["queued one"]);
		assert.deepEqual(saved.tabs[0]?.deferredUserMessages?.[0]?.images, [{ type: "image", data: "base64-image", mimeType: "image/png" }]);

		currentDeferred = [];
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
			resetSessionView: () => {
				currentDeferred = [];
			},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			captureDeferredUserMessages: () => currentDeferred,
			restoreDeferredUserMessages: (messages) => {
				currentDeferred = messages.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) }));
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

		assert.deepEqual(currentDeferred.map((message) => message.displayText), ["queued one"]);
		assert.deepEqual(currentDeferred[0]?.images, [{ type: "image", data: "base64-image", mimeType: "image/png" }]);
	});

	it("persists and restores auto steering queued messages after startup", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-auto-"));
		const sessionPath = join(dir, "one.jsonl");
		const tabsPath = join(dir, "tabs.json");
		await writeFile(sessionPath, "", "utf8");

		const queued = submittedMessage("queued auto");
		queued.images.push({ type: "image", data: "base64-auto", mimeType: "image/png" });
		let currentRuntime = fakeRuntime("one", sessionPath);
		let currentAuto: SubmittedUserMessage[] = [queued];
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
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			captureAutoUserMessages: () => currentAuto,
			restoreAutoUserMessages: (messages) => {
				currentAuto = messages.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) }));
			},
			captureDeferredUserMessages: () => [],
			restoreDeferredUserMessages: () => {},
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
			tabs: Array<{ autoUserMessages?: SubmittedUserMessage[] }>;
		};
		assert.equal(saved.version, 4);
		assert.deepEqual(saved.tabs[0]?.autoUserMessages?.map((message) => message.displayText), ["queued auto"]);
		assert.deepEqual(saved.tabs[0]?.autoUserMessages?.[0]?.images, [{ type: "image", data: "base64-auto", mimeType: "image/png" }]);

		currentAuto = [];
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
			resetSessionView: () => {
				currentAuto = [];
			},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async () => true,
			syncUserSessionEntryMetadata: () => {},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
			captureAutoUserMessages: () => currentAuto,
			restoreAutoUserMessages: (messages) => {
				currentAuto = messages.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) }));
			},
			captureDeferredUserMessages: () => [],
			restoreDeferredUserMessages: () => {},
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

		assert.deepEqual(currentAuto.map((message) => message.displayText), ["queued auto"]);
		assert.deepEqual(currentAuto[0]?.images, [{ type: "image", data: "base64-auto", mimeType: "image/png" }]);
	});

	it("persists and restores scroll position after startup", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-scroll-"));
		const sessionPath = join(dir, "one.jsonl");
		const tabsPath = join(dir, "tabs.json");
		await writeFile(sessionPath, "", "utf8");

		let currentRuntime = fakeRuntime("one", sessionPath);
		let restoredScrollState: { scrollFromBottom: number; detachedScrollStart?: number } | undefined;
		const capturedView = fakeSessionView({ scrollState: { scrollFromBottom: 12, detachedScrollStart: 41 } });
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
			captureSessionView: () => capturedView,
			restoreScrollState: (state) => {
				restoredScrollState = state;
			},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
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
			tabs: Array<{ scrollState?: { scrollFromBottom: number; detachedScrollStart?: number } }>;
		};
		assert.deepEqual(saved.tabs[0]?.scrollState, { scrollFromBottom: 12, detachedScrollStart: 41 });

		restoredScrollState = undefined;
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
			restoreScrollState: (state) => {
				restoredScrollState = state;
			},
			captureInputState: () => ({ text: "", cursor: 0 }),
			restoreInputState: () => {},
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

		assert.deepEqual(restoredScrollState, { scrollFromBottom: 12, detachedScrollStart: 41 });
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

	it("marks a new tab active while its runtime is still loading", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const newRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		let resolveRuntime: (runtime: AgentSessionRuntime) => void = () => {};
		const runtimePromise = new Promise<AgentSessionRuntime>((resolve) => {
			resolveRuntime = resolve;
		});
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => runtimePromise,
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

		const openPromise = controller.openNewTab();

		assert.equal(controller.isSwitching(), true);
		assert.equal(currentRuntime, activeRuntime);
		assert.equal(tabs.tabItems.length, 2);
		const pendingTab = controller.tabs()[1];
		assert.equal(pendingTab?.status, "active");
		assert.equal(pendingTab?.activity, "thinking");
		assert.equal(pendingTab?.titlePlaceholder, "new");

		resolveRuntime(newRuntime);
		await openPromise;

		assert.equal(controller.isSwitching(), false);
		assert.equal(currentRuntime, newRuntime);
		assert.equal(tabs.activeTabId, tabs.tabItems[1]?.id);
		assert.equal(tabs.runtimesByTabId.get(tabs.activeTabId ?? ""), newRuntime);
	});

	it("forks the active session into a new tab without replacing the old tab runtime", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const forkRuntime = fakeRuntime("one-copy", "/tmp/one.jsonl", {
			forkSessionFile: "/tmp/fork.jsonl",
			forkSessionName: "forked",
			forkSelectedText: "retry prompt",
		});
		let currentRuntime: AgentSessionRuntime = activeRuntime;
		let currentInput = { text: "draft one", cursor: 5 };
		const createdFrom: string[] = [];
		const entries: string[] = [];
		const toasts: string[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async (path) => {
				createdFrom.push(path);
				return forkRuntime;
			},
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
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		const opened = await controller.forkSessionEntryInNewTab("entry-1");

		assert.equal(opened, true);
		assert.deepEqual(createdFrom, [resolve("/tmp/one.jsonl")]);
		assert.equal(currentRuntime, forkRuntime);
		assert.equal(forkRuntime.session.sessionFile, "/tmp/fork.jsonl");
		assert.equal(tabs.tabItems.length, 2);
		assert.equal(tabs.activeTabId, tabs.tabItems[1]?.id);
		assert.equal(tabs.tabItems[1]?.isFork, true);
		assert.equal(tabs.runtimesByTabId.get("tab-1"), activeRuntime);
		assert.equal(tabs.runtimesByTabId.get(tabs.activeTabId ?? ""), forkRuntime);
		assert.deepEqual(currentInput, { text: "retry prompt", cursor: "retry prompt".length });
		assert.deepEqual(entries, ["Forked from entry entry-1 in a new tab."]);
		assert.deepEqual(toasts, ["Fork opened in new tab"]);
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
		assert.equal(newTab?.title, "019e7d3f");
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
		assert.equal(tab?.title, "019e7d3f");
		assert.equal(tab?.titlePlaceholder, "loading");
	});

	it("clears the only startup tab placeholder when there are no tabs to restore", async () => {
		const runtime = fakeRuntime("019e7d3fabc", "/tmp/one.jsonl", { sessionName: undefined });
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
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
			loadTabs: () => Promise<undefined>;
			saveTabs: () => Promise<void>;
		};
		tabs.loadTabs = async () => undefined;
		tabs.saveTabs = async () => {};

		controller.syncActiveTabFromRuntime({ save: false });
		assert.equal(controller.tabs()[0]?.titlePlaceholder, "loading");

		await controller.restoreAfterStartup();

		const tab = controller.tabs()[0];
		assert.equal(tab?.title, "019e7d3f");
		assert.equal(tab?.titlePlaceholder, undefined);
	});

	it("restores a previously empty startup tab as the session id instead of a persisted Loading title", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-loading-"));
		const sessionPath = join(dir, "019e7d3fabc.jsonl");
		const tabsPath = join(dir, "tabs.json");
		await writeFile(sessionPath, "", "utf8");
		await writeFile(tabsPath, JSON.stringify({
			version: 3,
			cwd: dir,
			activePath: sessionPath,
			tabs: [{ path: sessionPath, title: "Loading…" }],
		}), "utf8");

		const runtime = fakeRuntime("019e7d3fabc", sessionPath, { sessionName: undefined });
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => runtime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
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
			filePath: () => string;
			loadSessionTitles: () => Promise<ReadonlyMap<string, string>>;
		};
		tabs.filePath = () => tabsPath;
		tabs.loadSessionTitles = async () => new Map();

		await controller.restoreAfterStartup();

		const tab = controller.tabs()[0];
		assert.equal(tab?.title, "019e7d3f");
		assert.equal(tab?.titlePlaceholder, undefined);
	});

	it("refreshes a saved session title after startup without blocking restore", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-title-"));
		const sessionPath = join(dir, "019e7d3fabc.jsonl");
		const tabsPath = join(dir, "tabs.json");
		await writeFile(sessionPath, [
			JSON.stringify({ type: "session", version: 3, id: "019e7d3fabc", timestamp: "2024-01-01T00:00:00.000Z", cwd: dir }),
			JSON.stringify({ type: "session_info", id: "info-1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", name: "Restored real title" }),
			"",
		].join("\n"), "utf8");
		await writeFile(tabsPath, JSON.stringify({
			version: 3,
			cwd: dir,
			activePath: sessionPath,
			tabs: [{ path: sessionPath, title: "Loading…" }],
		}), "utf8");

		const runtime = fakeRuntime("019e7d3fabc", sessionPath, { sessionName: undefined });
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => runtime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
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
		const tabs = controller as unknown as { filePath: () => string };
		tabs.filePath = () => tabsPath;

		await controller.restoreAfterStartup();

		assert.equal(controller.tabs()[0]?.title, "019e7d3f");

		await waitFor(() => controller.tabs()[0]?.title === "Restored real title");

		const tab = controller.tabs()[0];
		assert.equal(tab?.title, "Restored real title");
		assert.equal(tab?.titlePlaceholder, undefined);
	});

	it("refreshes a saved session title from the session header area when the file is large", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-title-large-"));
		const sessionPath = join(dir, "019e7d3fabc.jsonl");
		const tabsPath = join(dir, "tabs.json");
		const fillerLine = `${JSON.stringify({ type: "custom", id: "filler", parentId: null, timestamp: "2024-01-01T00:00:02.000Z", customType: "filler", data: "x".repeat(1024) })}\n`;
		await writeFile(sessionPath, [
			JSON.stringify({ type: "session", version: 3, id: "019e7d3fabc", timestamp: "2024-01-01T00:00:00.000Z", cwd: dir }),
			JSON.stringify({ type: "session_info", id: "info-1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", name: "Header area title" }),
			fillerLine.repeat(2300),
		].join("\n"), "utf8");
		await writeFile(tabsPath, JSON.stringify({
			version: 3,
			cwd: dir,
			activePath: sessionPath,
			tabs: [{ path: sessionPath, title: "019e7d3f" }],
		}), "utf8");

		const runtime = fakeRuntime("019e7d3fabc", sessionPath, { sessionName: undefined });
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => runtime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
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
		const tabs = controller as unknown as { filePath: () => string };
		tabs.filePath = () => tabsPath;

		await controller.restoreAfterStartup();

		assert.equal(controller.tabs()[0]?.title, "019e7d3f");

		await waitFor(() => controller.tabs()[0]?.title === "Header area title");

		assert.equal(controller.tabs()[0]?.title, "Header area title");
	});

	it("restores a startup tab as the session id when the session list and runtime still report Loading", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-runtime-loading-"));
		const sessionPath = join(dir, "019e7d3fabc.jsonl");
		const tabsPath = join(dir, "tabs.json");
		await writeFile(sessionPath, "", "utf8");
		await writeFile(tabsPath, JSON.stringify({
			version: 3,
			cwd: dir,
			activePath: sessionPath,
			tabs: [{ path: sessionPath, title: "Loading…" }],
		}), "utf8");

		const runtime = fakeRuntime("019e7d3fabc", sessionPath, { sessionName: "Loading..." });
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => runtime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
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
			filePath: () => string;
			loadSessionTitles: () => Promise<ReadonlyMap<string, string>>;
		};
		tabs.filePath = () => tabsPath;
		tabs.loadSessionTitles = async () => new Map([[resolve(sessionPath), "Loading…"]]);

		await controller.restoreAfterStartup();

		const tab = controller.tabs()[0];
		assert.equal(tab?.title, "019e7d3f");
		assert.equal(tab?.titlePlaceholder, undefined);
	});

	it("keeps the previous tab when activation renders during new tab creation", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const newRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		let renderedTabPaths: Array<string | undefined> = [];
		const switchingSnapshots: boolean[] = [];
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
			render: () => {
				switchingSnapshots.push(controller.isSwitching());
			},
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
		assert.equal(switchingSnapshots.includes(true), true);
		assert.equal(tabs.tabItems.length, 2);
		assert.equal(tabs.tabItems[0]?.sessionPath, resolve("/tmp/one.jsonl"));
		assert.equal(tabs.tabItems[1]?.sessionPath, resolve("/tmp/two.jsonl"));
		assert.equal(tabs.activeTabId, tabs.tabItems[1]?.id);
	});

	it("renders while a searched session tab is pending activation", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		const switchingSnapshots: boolean[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
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
				switchingSnapshots.push(controller.isSwitching());
			},
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

		await controller.openSessionInNewTab("/tmp/two.jsonl");

		assert.equal(switchingSnapshots.includes(true), true);
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

	it("restores at most eight persisted tabs and skips duplicate session paths", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-restore-"));
		const tabsPath = join(dir, "tabs.json");
		const sessionPaths = Array.from({ length: 9 }, (_, index) => join(dir, `${index + 1}.jsonl`));
		for (const sessionPath of sessionPaths) await writeFile(sessionPath, "", "utf8");
		await writeFile(tabsPath, JSON.stringify({
			version: 3,
			cwd: dir,
			activePath: sessionPaths[2],
			tabs: [
				{ path: sessionPaths[0], title: "one" },
				{ path: sessionPaths[1], title: "two" },
				{ path: sessionPaths[2], title: "three" },
				{ path: sessionPaths[2], title: "three duplicate" },
				{ path: sessionPaths[3], title: "four" },
				{ path: sessionPaths[4], title: "five" },
				{ path: sessionPaths[5], title: "six" },
				{ path: sessionPaths[6], title: "seven" },
				{ path: sessionPaths[7], title: "eight" },
				{ path: sessionPaths[8], title: "nine" },
			],
		}), "utf8");

		const runtime = fakeRuntime("three", sessionPaths[2], { sessionName: "three" });
		let currentRuntime = runtime;
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
			createRuntimeForSession: async (path) => fakeRuntime("session", path),
			activateRuntime: async (nextRuntime) => {
				currentRuntime = nextRuntime;
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
			filePath: () => string;
			loadSessionTitles: () => Promise<ReadonlyMap<string, string>>;
			tabItems: SessionTab[];
			activeTabId: string | undefined;
		};
		tabs.filePath = () => tabsPath;
		tabs.loadSessionTitles = async () => new Map(sessionPaths.map((sessionPath, index) => [sessionPath, `tab ${index + 1}`]));

		await controller.restoreAfterStartup();

		assert.equal(controller.tabs().length, 8);
		assert.equal(new Set(controller.tabs().map((tab) => tab.sessionPath)).size, 8);
		const activeTab = controller.tabs().find((tab) => tab.sessionPath === sessionPaths[2]);
		assert.equal(controller.activeInputTabId(), activeTab?.id);
		assert.equal(currentRuntime.session.sessionFile, sessionPaths[2]);
	});

	it("falls back to the previous tab when switching fails after loading the target runtime", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime: AgentSessionRuntime = activeRuntime;
		let currentInput = { text: "draft one", cursor: 5 };
		let currentDeferred: SubmittedUserMessage[] = [submittedMessage("queued one")];
		const toasts: string[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => targetRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
				if (runtime === targetRuntime) throw new Error("activation failed");
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
			captureDeferredUserMessages: () => currentDeferred,
			restoreDeferredUserMessages: (messages) => {
				currentDeferred = messages.map((message) => ({ ...message, images: [...message.images] }));
			},
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

		assert.equal(tabs.activeTabId, "tab-1");
		assert.equal(currentRuntime, activeRuntime);
		assert.deepEqual(currentInput, { text: "draft one", cursor: 5 });
		assert.deepEqual(currentDeferred.map((message) => message.displayText), ["queued one"]);
		assert.deepEqual(toasts, ["Could not switch tab"]);
	});

	it("keeps the active tab unchanged when opening a session tab fails", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		let currentRuntime: AgentSessionRuntime = activeRuntime;
		const toasts: string[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => {
				throw new Error("missing session");
			},
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
		tabs.tabItems.push({ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" });
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		const opened = await controller.openSessionInNewTab("missing.jsonl");

		assert.equal(opened, false);
		assert.equal(tabs.tabItems.length, 1);
		assert.equal(tabs.activeTabId, "tab-1");
		assert.equal(currentRuntime, activeRuntime);
		assert.deepEqual(toasts, ["Could not open session tab"]);
	});

	it("serializes concurrent tab lifecycle mutations in invocation order", async () => {
		const firstRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const secondRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		const thirdRuntime = fakeRuntime("three", "/tmp/three.jsonl");
		let currentRuntime = firstRuntime;
		let releaseFirstActivation: () => void = () => {};
		const firstActivationGate = new Promise<void>((resolve) => {
			releaseFirstActivation = resolve;
		});
		const activationOrder: string[] = [];
		let concurrentActivations = 0;
		let maxConcurrentActivations = 0;
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async (path) => path.endsWith("two.jsonl") ? secondRuntime : thirdRuntime,
			activateRuntime: async (runtime) => {
				activationOrder.push(runtime.session.sessionId);
				concurrentActivations += 1;
				maxConcurrentActivations = Math.max(maxConcurrentActivations, concurrentActivations);
				currentRuntime = runtime;
				if (runtime === secondRuntime) await firstActivationGate;
				concurrentActivations -= 1;
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
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" },
			{ id: "tab-3", title: "three", status: "waiting", sessionPath: "/tmp/three.jsonl" },
		);
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", firstRuntime);

		const firstSwitch = controller.switchToTab("tab-2");
		const secondSwitch = controller.switchToTab("tab-3");
		await waitFor(() => activationOrder.length === 1);

		assert.deepEqual(activationOrder, ["two"]);
		releaseFirstActivation();
		await Promise.all([firstSwitch, secondSwitch]);

		assert.deepEqual(activationOrder, ["two", "three"]);
		assert.equal(maxConcurrentActivations, 1);
		assert.equal(currentRuntime, thirdRuntime);
		assert.equal(tabs.activeTabId, "tab-3");

		const nestedSwitch = controller.openSessionInNewTab("/tmp/two.jsonl");
		const deadlockTimeout = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("nested tab switch deadlocked")), 250).unref?.();
		});
		assert.equal(await Promise.race([nestedSwitch, deadlockTimeout]), true);
		assert.equal(currentRuntime, secondRuntime);
	});

	it("does not apply stale history completion to a displaced runtime", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const targetRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		const replacementRuntime = fakeRuntime("replacement", "/tmp/replacement.jsonl");
		let currentRuntime = activeRuntime;
		let finishHistory: (completed: boolean) => void = () => {};
		const historyCompletion = new Promise<boolean>((resolve) => {
			finishHistory = resolve;
		});
		let historyCancellationCheck: (() => boolean) | undefined;
		let metadataSyncCount = 0;
		let statusUpdateCount = 0;
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
			setSessionStatus: () => {
				statusUpdateCount += 1;
			},
			setSessionActivity: () => {},
			resetSessionView: () => {},
			loadSessionHistory: () => {},
			loadSessionHistoryAsync: async (options) => {
				historyCancellationCheck = options.isCancelled;
				return await historyCompletion;
			},
			syncUserSessionEntryMetadata: () => {
				metadataSyncCount += 1;
			},
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

		const switching = controller.switchToTab("tab-2");
		await waitFor(() => historyCancellationCheck !== undefined);
		currentRuntime = replacementRuntime;

		assert.equal(historyCancellationCheck?.(), true);
		finishHistory(true);
		await switching;

		assert.equal(metadataSyncCount, 0);
		assert.equal(statusUpdateCount, 0);
	});

	it("rolls back and disposes a new runtime when activation fails", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const newRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let currentRuntime = activeRuntime;
		const disposed: AgentSessionRuntime[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => currentRuntime,
			createRuntimeForNewSession: async () => newRuntime,
			createRuntimeForSession: async () => activeRuntime,
			activateRuntime: async (runtime) => {
				currentRuntime = runtime;
				if (runtime === newRuntime) throw new Error("bind failed");
			},
			disposeRuntime: async (runtime) => {
				disposed.push(runtime);
			},
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

		await assert.rejects(controller.openNewTab(), /bind failed/u);

		assert.equal(currentRuntime, activeRuntime);
		assert.deepEqual(disposed, [newRuntime]);
		assert.equal(tabs.tabItems.length, 1);
		assert.equal(tabs.activeTabId, "tab-1");
	});

	it("disposes a runtime whose tab closes while it is loading", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const orphanRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let finishRuntimeLoad: (runtime: AgentSessionRuntime) => void = () => {};
		const runtimeLoad = new Promise<AgentSessionRuntime>((resolve) => {
			finishRuntimeLoad = resolve;
		});
		const disposed: AgentSessionRuntime[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: true } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => activeRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", "/tmp/new.jsonl"),
			createRuntimeForSession: async () => runtimeLoad,
			activateRuntime: async () => {},
			disposeRuntime: async (runtime) => {
				disposed.push(runtime);
			},
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
		const targetTab: SessionTab = { id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" };
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
			runtimeForTab(tab: SessionTab): Promise<AgentSessionRuntime | undefined>;
		};
		tabs.tabItems.push(
			{ id: "tab-1", title: "one", status: "active", sessionPath: "/tmp/one.jsonl" },
			targetTab,
		);
		tabs.activeTabId = "tab-1";
		tabs.runtimesByTabId.set("tab-1", activeRuntime);

		const loading = tabs.runtimeForTab(targetTab);
		await controller.closeTab(targetTab.id);
		finishRuntimeLoad(orphanRuntime);
		assert.equal(await loading, undefined);

		assert.deepEqual(disposed, [orphanRuntime]);
	});

	it("disposes a background runtime whose load finishes after shutdown", async () => {
		const activeRuntime = fakeRuntime("one", "/tmp/one.jsonl");
		const orphanRuntime = fakeRuntime("two", "/tmp/two.jsonl");
		let running = true;
		let finishRuntimeLoad: (runtime: AgentSessionRuntime) => void = () => {};
		const runtimeLoad = new Promise<AgentSessionRuntime>((resolve) => { finishRuntimeLoad = resolve; });
		const disposed: AgentSessionRuntime[] = [];
		const controller = new AppTabsController({
			options: { cwd: "/tmp", themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => activeRuntime,
			createRuntimeForNewSession: async () => activeRuntime,
			createRuntimeForSession: async () => await runtimeLoad,
			activateRuntime: async () => {},
			disposeRuntime: async (runtime) => { disposed.push(runtime); },
			isRunning: () => running,
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
		const targetTab: SessionTab = { id: "tab-2", title: "two", status: "waiting", sessionPath: "/tmp/two.jsonl" };
		const tabs = controller as unknown as {
			tabItems: SessionTab[];
			runtimeForTab(tab: SessionTab): Promise<AgentSessionRuntime | undefined>;
			runtimesByTabId: Map<string, AgentSessionRuntime>;
		};
		tabs.tabItems.push(targetTab);

		const loading = tabs.runtimeForTab(targetTab);
		running = false;
		controller.cancelPendingLifecycleWork();
		finishRuntimeLoad(orphanRuntime);

		assert.equal(await loading, undefined);
		assert.deepEqual(disposed, [orphanRuntime]);
		assert.equal(tabs.runtimesByTabId.has(targetTab.id), false);
	});

	it("serializes persisted snapshots and gives each write a unique temp path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-save-order-"));
		const tabsPath = join(dir, "tabs.json");
		const runtime = fakeRuntime("one", join(dir, "one.jsonl"));
		let releaseFirstWrite: () => void = () => {};
		const firstWriteGate = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		const writes: Array<{ tempPath: string; payload: string }> = [];
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			blinkController: fakeBlinkController(),
			runtime: () => runtime,
			createRuntimeForNewSession: async () => runtime,
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
			filePath: () => string;
			tabItems: SessionTab[];
			activeTabId: string | undefined;
			saveTabs(): Promise<void>;
			writeTabsSnapshot(filePath: string, tempPath: string, payload: string): Promise<void>;
		};
		tabs.filePath = () => tabsPath;
		tabs.tabItems.push({ id: "tab-1", title: "first", status: "active", sessionPath: runtime.session.sessionFile });
		tabs.activeTabId = "tab-1";
		tabs.writeTabsSnapshot = async (filePath, tempPath, payload) => {
			writes.push({ tempPath, payload });
			if (writes.length === 1) await firstWriteGate;
			await writeFile(filePath, payload, "utf8");
		};

		const firstSave = tabs.saveTabs();
		tabs.tabItems[0]!.title = "second";
		const secondSave = tabs.saveTabs();
		await waitFor(() => writes.length === 1);
		assert.equal(JSON.parse(writes[0]!.payload).tabs[0].title, "first");

		releaseFirstWrite();
		await Promise.all([firstSave, secondSave]);

		assert.equal(writes.length, 2);
		assert.notEqual(writes[0]?.tempPath, writes[1]?.tempPath);
		const saved = JSON.parse(await readFile(tabsPath, "utf8")) as { tabs: Array<{ title: string }> };
		assert.equal(saved.tabs[0]?.title, "second");
	});

	it("retains only configured project sessions while preserving open tabs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-retention-"));
		const sessionDir = join(dir, "sessions");
		const sessionPaths = Array.from({ length: 25 }, (_, index) => join(sessionDir, `${String(index + 1).padStart(2, "0")}.jsonl`));
		await mkdir(sessionDir, { recursive: true });
		for (const [index, sessionPath] of sessionPaths.entries()) {
			await writeFile(sessionPath, "", "utf8");
			const time = new Date(1_700_000_000_000 + index * 1_000);
			await utimes(sessionPath, time, time);
		}

		const preservedOldSession = sessionPaths[0] ?? "";
		const activeRuntime = fakeRuntime("one", preservedOldSession);
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			maxProjectSessions: 20,
			blinkController: fakeBlinkController(),
			runtime: () => activeRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
			createRuntimeForSession: async (path) => fakeRuntime("session", path),
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
			sessionDir: () => string;
			cleanupOldProjectSessions: () => Promise<void>;
			tabItems: SessionTab[];
			activeTabId: string | undefined;
		};
		tabs.sessionDir = () => sessionDir;
		tabs.tabItems.push({ id: "tab-1", title: "old", status: "active", sessionPath: preservedOldSession });
		tabs.activeTabId = "tab-1";

		await tabs.cleanupOldProjectSessions();

		const remaining = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
		assert.equal(remaining.length, 20);
		assert.equal(remaining.includes("01.jsonl"), true);
		assert.equal(remaining.includes("02.jsonl"), false);
		assert.equal(remaining.includes("25.jsonl"), true);
		assert.equal((await stat(preservedOldSession)).isFile(), true);
	});

	it("removes DCP sidecar state when deleting old project sessions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-retention-sidecar-"));
		const sessionDir = join(dir, "sessions");
		const dcpStateDir = join(sessionDir, "dcp-state");
		await mkdir(dcpStateDir, { recursive: true });
		// 25 sessions, each with a first-line session marker and a matching DCP sidecar.
		const sessionPaths = Array.from({ length: 25 }, (_, index) => {
			const id = `session-${String(index + 1).padStart(2, "0")}`;
			return { path: join(sessionDir, `${id}.jsonl`), id };
		});
		for (const [index, session] of sessionPaths.entries()) {
			await writeFile(session.path, JSON.stringify({ type: "session", id: session.id }) + "\n", "utf8");
			await writeFile(join(dcpStateDir, `${session.id}.json`), "{}", "utf8");
			const time = new Date(1_700_000_000_000 + index * 1_000);
			await utimes(session.path, time, time);
		}

		const preservedOldSession = sessionPaths[0]?.path ?? "";
		const preservedOldId = sessionPaths[0]?.id ?? "";
		const activeRuntime = fakeRuntime("one", preservedOldSession);
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			maxProjectSessions: 20,
			blinkController: fakeBlinkController(),
			runtime: () => activeRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
			createRuntimeForSession: async (path) => fakeRuntime("session", path),
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
			sessionDir: () => string;
			cleanupOldProjectSessions: () => Promise<void>;
			tabItems: SessionTab[];
			activeTabId: string | undefined;
		};
		tabs.sessionDir = () => sessionDir;
		tabs.tabItems.push({ id: "tab-1", title: "old", status: "active", sessionPath: preservedOldSession });
		tabs.activeTabId = "tab-1";

		await tabs.cleanupOldProjectSessions();

		const remainingSidecars = (await readdir(dcpStateDir)).sort();
		assert.equal(remainingSidecars.length, 20);
		// Preserved (oldest, open tab) session's sidecar survives.
		assert.equal(remainingSidecars.includes(`${preservedOldId}.json`), true);
		// The 5 oldest non-preserved sessions were deleted along with their sidecars.
		assert.equal(remainingSidecars.includes("session-02.json"), false);
		assert.equal(remainingSidecars.includes("session-06.json"), false);
		// The newest 19 sessions are kept.
		assert.equal(remainingSidecars.includes("session-07.json"), true);
		assert.equal(remainingSidecars.includes("session-25.json"), true);
	});

	it("does not delete project sessions when retention is disabled", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pix-tabs-retention-disabled-"));
		const sessionDir = join(dir, "sessions");
		const sessionPaths = Array.from({ length: 25 }, (_, index) => join(sessionDir, `${String(index + 1).padStart(2, "0")}.jsonl`));
		await mkdir(sessionDir, { recursive: true });
		for (const sessionPath of sessionPaths) await writeFile(sessionPath, "", "utf8");

		const activeRuntime = fakeRuntime("one", sessionPaths[0] ?? "");
		const controller = new AppTabsController({
			options: { cwd: dir, themeName: "dark", noSession: false } satisfies AppOptions,
			maxProjectSessions: 0,
			blinkController: fakeBlinkController(),
			runtime: () => activeRuntime,
			createRuntimeForNewSession: async () => fakeRuntime("new", join(dir, "new.jsonl")),
			createRuntimeForSession: async (path) => fakeRuntime("session", path),
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
			sessionDir: () => string;
			cleanupOldProjectSessions: () => Promise<void>;
		};
		tabs.sessionDir = () => sessionDir;

		await tabs.cleanupOldProjectSessions();

		const remaining = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
		assert.equal(remaining.length, 25);
	});

});

function fakeRuntime(
	sessionId: string,
	sessionFile: string,
	options: {
		isStreaming?: boolean;
		sessionName?: string;
		newSessionFile?: string;
		newSessionName?: string;
		forkSessionFile?: string;
		forkSessionName?: string;
		forkSelectedText?: string;
		forkCancelled?: boolean;
	} = {},
): AgentSessionRuntime {
	const createSession = (id: string, file: string, name: string | undefined, parentSession?: string) => {
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		return {
			sessionId: id,
			sessionName: name,
			sessionFile: file,
			sessionManager: {
				getHeader: () => ({
					type: "session" as const,
					id,
					timestamp: "2024-01-01T00:00:00.000Z",
					cwd: "/tmp",
					...(parentSession === undefined ? {} : { parentSession }),
				}),
			},
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
		fork(entryId: string): Promise<{ cancelled: boolean; selectedText?: string }>;
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
		fork: async (_entryId: string) => {
			if (options.forkCancelled) return { cancelled: true };
			const parentSession = runtime.session.sessionFile;
			runtime.session = createSession(
				"fork",
				options.forkSessionFile ?? "/tmp/fork.jsonl",
				Object.prototype.hasOwnProperty.call(options, "forkSessionName") ? options.forkSessionName : "fork",
				parentSession,
			);
			return {
				cancelled: false,
				...(options.forkSelectedText === undefined ? {} : { selectedText: options.forkSelectedText }),
			};
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


function fakeSessionView(overrides: Partial<{ scrollState: { scrollFromBottom: number; detachedScrollStart?: number } }> = {}) {
	return {
		entries: [],
		eventState: {
			toolEntryIdsByCallId: new Map(),
			pendingToolCallIdsByContentIndex: new Map(),
			toolMutationPreparationsByCallId: new Map(),
			olderHistoryLoader: undefined,
			currentUserEntryId: undefined,
			currentAssistantEntryId: undefined,
			currentAssistantTextBlockEntryId: undefined,
			currentAssistantTextBlockStartLength: undefined,
			currentAssistantTextBlockContentIndex: undefined,
			assistantTextBlocksByContentIndex: new Map(),
			currentThinkingEntryId: undefined,
			currentThinkingEntryStartedAt: undefined,
			assistantMessageClosed: false,
			assistantTextBuffer: "",
			entryRenderVersions: new Map(),
			historyEntries: [],
			historyWindowStart: 0,
		},
		scrollState: overrides.scrollState ?? { scrollFromBottom: 0 },
	};
}

function submittedMessage(text: string): SubmittedUserMessage {
	return {
		id: `queued-${text}`,
		promptText: text,
		displayText: text,
		images: [],
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for predicate");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
