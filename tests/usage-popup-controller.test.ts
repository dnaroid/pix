import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AppPopupMenuController } from "../src/app/popup/popup-menu-controller.js";
import { AppToastController } from "../src/app/rendering/toast-controller.js";
import type { AppMouseControllerHost } from "../src/app/screen/mouse-controller.js";
import { UsagePopupController } from "../src/app/screen/usage-popup-controller.js";
import { THEMES } from "../src/theme.js";

function telemetry(runDir: string, id = "review") {
	return [
		{ type: "custom", customType: "pi-tools-suite:subagent-statistics", data: { version: 1, event: "task", runDir, id, subagentType: "verify", task: "Review the UX", scope: "src" } },
		{ type: "custom", customType: "pi-tools-suite:subagent-statistics", data: { version: 1, event: "tool", runDir, id, toolName: "read" } },
		{ type: "usage", kind: "async-subagent", provider: "openai-codex", model: "gpt-6",
			note: JSON.stringify({ version: 1, runDir, agentId: id }),
			usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.25 } } },
	];
}

type Harness = {
	controller: UsagePopupController;
	toasts: AppToastController;
	host: AppMouseControllerHost;
	menus: { title: string; count: number }[];
	opened: string[];
	setSession(session: AgentSession | undefined): void;
	setTabGeneration(generation: number): void;
	activate(label: string): void;
};

async function waitFor(check: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
		await delay(10);
	}
}

function setup(entries: readonly unknown[], workspace: string, selectIndex = 0): Harness {
	const toasts = new AppToastController({ render: () => {} });
	const session = {
		model: { provider: "openai-codex", id: "gpt-6" },
		sessionManager: { getSessionId: () => "one", getEntries: () => entries },
	} as unknown as AgentSession;
	let activeSession: AgentSession | undefined = session;
	let tabGeneration = 0;
	const opened: string[] = [];
	const menus: { title: string; count: number }[] = [];
	const host = {
		runtimeSession: () => activeSession,
		tabsLifecycleGeneration: () => tabGeneration,
		toastEntry: (id: number) => toasts.entry(id),
		showToast: (message: string, kind: "info" | "warning", options: Parameters<AppToastController["showToast"]>[2]) => toasts.showToast(message, kind, options),
		dismissToast: (id: number) => toasts.dismissToast(id),
		cwd: () => workspace,
		theme: () => THEMES.dark,
		modelColors: () => ({ rules: {} }),
		modelUsageStatus: () => undefined,
		openFileLink: (link: { url: string }) => { opened.push(link.url); return true; },
	} as unknown as AppMouseControllerHost;
	const popup = {
		showSdkMenu: async (items: readonly { value: string }[], options: { title: string }) => {
			menus.push({ title: options.title, count: items.length });
			return items[selectIndex]?.value;
		},
	} as unknown as AppPopupMenuController;
	return {
		controller: new UsagePopupController(host, popup), toasts, host, menus, opened,
		setSession: (value) => { activeSession = value; },
		setTabGeneration: (value) => { tabGeneration = value; },
		activate: (label) => {
			const entry = toasts.visibleStates().at(-1);
			assert.ok(entry, "expected a visible dialog");
			const index = entry.actions?.findIndex((action) => action.label === label) ?? -1;
			assert.notEqual(index, -1, "action " + label + " should exist");
			assert.equal(toasts.activateAction(entry.id, index), true);
		},
	};
}

describe("TUI usage popup", () => {
	it("presents subagents and opens a run only after validation inside the workspace", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pix-usage-tui-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const runDir = join(root, ".pi", "subagents", "run");
		mkdirSync(runDir, { recursive: true });
		const ui = setup(telemetry(runDir), root);
		ui.controller.toggle();
		await delay(0);
		assert.match(ui.toasts.visibleStates()[0]?.message ?? "", /120 tokens\s+\$0\.25/);
		assert.ok(ui.toasts.visibleStates()[0]?.actions?.some((action) => action.label === "Subagents (1)"));

		ui.activate("Subagents (1)");
		await delay(0);
		assert.deepEqual(ui.menus, [{ title: "Subagent statistics", count: 1 }]);
		const details = ui.toasts.visibleStates()[0]?.message ?? "";
		assert.match(details, /Subagent: review/);
		assert.match(details, /Role: .+ verify/);
		assert.match(details, /Tool calls: read ×1/);
		assert.match(details, /Input: 100  Output: 20/);

		ui.activate("Open run");
		await waitFor(() => ui.opened.length === 1, "validated run directory to open");
		// Match the async realpath used by the controller. On Windows the sync
		// API can return an 8.3 short path while the async API returns its long name.
		assert.deepEqual(ui.opened, [pathToFileURL(await realpath(runDir)).href]);
		assert.match(ui.toasts.visibleStates()[0]?.message ?? "", /^Session usage/);
	});

	it("does not follow a symlink outside the workspace and removes the failed Open run action", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pix-usage-root-"));
		const outside = mkdtempSync(join(tmpdir(), "pix-usage-outside-"));
		t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
		const link = join(root, "escape");
		symlinkSync(outside, link);
		const ui = setup(telemetry(link), root);
		ui.controller.toggle();
		await delay(0);
		ui.activate("Subagents (1)");
		await delay(0);
		ui.activate("Open run");
		await waitFor(() => (ui.toasts.visibleStates()[0]?.message ?? "").includes("outside the workspace"),
			"rejected path warning");
		assert.deepEqual(ui.opened, []);
		assert.match(ui.toasts.visibleStates()[0]?.message ?? "", /outside the workspace/);
		assert.ok(!ui.toasts.visibleStates()[0]?.actions?.some((action) => action.label === "Open run"));
	});

	it("opens only allowlisted provider pages and restores the session dialog", async () => {
		const ui = setup([
			{ type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-6", usage: { totalTokens: 10, cost: { total: 0.01 } } } },
		], "/nonexistent");
		ui.controller.toggle();
		await delay(0);
		ui.activate("Provider pages");
		await delay(0);
		assert.deepEqual(ui.menus, [{ title: "Provider usage pages", count: 1 }]);
		assert.deepEqual(ui.opened, ["https://chatgpt.com/settings/usage?tab=overview"]);
		assert.match(ui.toasts.visibleStates()[0]?.message ?? "", /Session usage/);
	});

	it("only dismisses its own dialog on outside pointer activation", async () => {
		const ui = setup([], "/nonexistent");
		ui.controller.toggle();
		await delay(0);
		const toast = ui.toasts.visibleStates()[0]!;
		assert.equal(ui.controller.dismissOnOutsideClick(true, undefined), false, "usage trigger toggles separately");
		assert.equal(ui.controller.dismissOnOutsideClick(false, toast.id), false, "dialog body does not dismiss it");
		assert.equal(ui.controller.dismissOnOutsideClick(false, undefined), true);
		assert.deepEqual(ui.toasts.visibleStates(), []);
	});

	it("never dismisses a different tab's toast when dialog IDs collide", async () => {
		let scope = "tab-a";
		const toasts = new AppToastController({ activeScope: () => scope, render: () => {} });
		const session = {
			sessionManager: { getSessionId: () => "a", getEntries: () => [] },
		} as unknown as AgentSession;
		let currentSession = session;
		let generation = 1;
		const host = {
			runtimeSession: () => currentSession,
			tabsLifecycleGeneration: () => generation,
			toastEntry: (id: number) => toasts.entry(id),
			showToast: (message: string, kind: "info", options: Parameters<AppToastController["showToast"]>[2]) => toasts.showToast(message, kind, options),
			dismissToast: (id: number) => toasts.dismissToast(id),
			theme: () => THEMES.dark, modelColors: () => ({ rules: {} }),
		} as unknown as AppMouseControllerHost;
		const ui = new UsagePopupController(host, {} as AppPopupMenuController);
		ui.toggle();
		await delay(0);
		assert.equal(toasts.visibleStates()[0]?.id, 1);
		scope = "tab-b";
		currentSession = { sessionManager: { getSessionId: () => "b", getEntries: () => [] } } as unknown as AgentSession;
		generation++;
		toasts.showToast("Unrelated warning", "warning", { variant: "dialog" });
		assert.equal(toasts.visibleStates()[0]?.id, 1, "toast IDs are local to each tab");
		ui.toggle();
		await delay(0);
		assert.ok(toasts.visibleStates().some((toast) => toast.message === "Unrelated warning"));
		assert.ok(toasts.visibleStates().some((toast) => toast.message.startsWith("Session usage")));
	});
});
