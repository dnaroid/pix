import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppPopupActionController, type AppPopupActionControllerHost } from "../src/app/popup/popup-action-controller.js";
import type { AppPopupMenuController } from "../src/app/popup/popup-menu-controller.js";
import type { AppMenuItemsController } from "../src/app/popup/menu-items-controller.js";
import type { AppCommandController } from "../src/app/commands/command-controller.js";
import type { AppQueuedMessageController } from "../src/app/session/queued-message-controller.js";
import type { AppWorkspaceActionsController } from "../src/app/workspace/workspace-actions-controller.js";

describe("AppPopupActionController model visibility", () => {
	it("materializes the full catalog as a whitelist when hiding the first model", async () => {
		const saved: string[][] = [];
		const toasts: string[] = [];
		const modelA = { provider: "openai", id: "a", name: "A" } as never;
		const modelB = { provider: "zai", id: "b", name: "B" } as never;
		const popupMenus = {
			syncActivePopupMenu: () => "model",
			modelVisibilityModeActive: () => true,
			selectedModel: () => ({
				value: { model: modelA, ref: "openai/a", current: false, visible: true },
				direct: true,
			}),
		} as unknown as AppPopupMenuController;
		const menuItems = {
			getModelMenuItems: () => [
				{ value: { model: modelA, ref: "openai/a", current: false, visible: true }, label: "openai/a" },
				{ value: { model: modelB, ref: "zai/b", current: false, visible: true }, label: "zai/b" },
			],
		} as unknown as AppMenuItemsController;
		const controller = new AppPopupActionController(
			host({
				visibleModels: () => undefined,
				saveVisibleModels: (refs) => {
					saved.push([...refs]);
					return refs;
				},
				showToast: (message) => { toasts.push(message); },
			}),
			popupMenus,
			{} as AppCommandController,
			menuItems,
			{} as AppQueuedMessageController,
			{} as AppWorkspaceActionsController,
		);

		assert.equal(await controller.submitActivePopupMenu(), true);
		assert.deepEqual(saved, [["zai/b"]]);
		assert.match(toasts[0] ?? "", /hidden from model pickers/u);
	});

	it("does not hide the current model", async () => {
		let saves = 0;
		const model = { provider: "openai", id: "current", name: "Current" } as never;
		const popupMenus = {
			syncActivePopupMenu: () => "model",
			modelVisibilityModeActive: () => true,
			selectedModel: () => ({
				value: { model, ref: "openai/current", current: true, visible: true },
				direct: true,
			}),
		} as unknown as AppPopupMenuController;
		const controller = new AppPopupActionController(
			host({ saveVisibleModels: (refs) => { saves += 1; return refs; } }),
			popupMenus,
			{} as AppCommandController,
			{ getModelMenuItems: () => [] } as unknown as AppMenuItemsController,
			{} as AppQueuedMessageController,
			{} as AppWorkspaceActionsController,
		);

		assert.equal(await controller.submitActivePopupMenu(), true);
		assert.equal(saves, 0);
	});

	it("clears the whole visibility whitelist from management mode", () => {
		const saved: string[][] = [];
		const toasts: string[] = [];
		const popupMenus = {
			modelVisibilityModeActive: () => true,
		} as unknown as AppPopupMenuController;
		const controller = new AppPopupActionController(
			host({
				saveVisibleModels: (refs) => {
					saved.push([...refs]);
					return refs;
				},
				showToast: (message) => { toasts.push(message); },
			}),
			popupMenus,
			{} as AppCommandController,
			{} as AppMenuItemsController,
			{} as AppQueuedMessageController,
			{} as AppWorkspaceActionsController,
		);

		assert.equal(controller.clearVisibleModels(), true);
		assert.deepEqual(saved, [[]]);
		assert.match(toasts[0] ?? "", /cleared model picker visibility/iu);
	});

	it("loads a saved session directly into the active draft tab", async () => {
		let openedPath: string | undefined;
		const popupMenus = {
			syncActivePopupMenu: () => "resume",
			selectedResume: () => ({ kind: "session", session: { path: "/tmp/saved.jsonl" } }),
			draftSessionSelectorActive: () => true,
			setDirectMenu: () => {},
			setDirectPreserveStatus: () => {},
			setDirectQuery: () => {},
			closeResumeMenu: () => {},
			setResumeMenuMode: () => {},
		} as unknown as AppPopupMenuController;
		const controller = new AppPopupActionController(
			host({
				openSessionInActiveDraftTab: async (sessionPath) => {
					openedPath = sessionPath;
					return true;
				},
			}),
			popupMenus,
			{} as AppCommandController,
			{} as AppMenuItemsController,
			{} as AppQueuedMessageController,
			{} as AppWorkspaceActionsController,
		);

		assert.equal(await controller.submitActivePopupMenu(), true);
		assert.equal(openedPath, "/tmp/saved.jsonl");
	});

	it("accepts New session from the draft selector without materializing a runtime", async () => {
		let openedPath: string | undefined;
		let slashCommandSubmitted = false;
		const popupMenus = {
			syncActivePopupMenu: () => "resume",
			selectedResume: () => ({ kind: "new" }),
			draftSessionSelectorActive: () => true,
			setDirectMenu: () => {},
			setDirectPreserveStatus: () => {},
			setDirectQuery: () => {},
			closeResumeMenu: () => {},
			setResumeMenuMode: () => {},
		} as unknown as AppPopupMenuController;
		const controller = new AppPopupActionController(
			host({
				openSessionInActiveDraftTab: async (sessionPath) => {
					openedPath = sessionPath;
					return true;
				},
			}),
			popupMenus,
			{ runResumeCommand: async () => {}, } as unknown as AppCommandController,
			{} as AppMenuItemsController,
			{
				submitUserMessage: async () => {
					slashCommandSubmitted = true;
				},
			} as unknown as AppQueuedMessageController,
			{} as AppWorkspaceActionsController,
		);

		assert.equal(await controller.submitActivePopupMenu(), true);
		assert.equal(openedPath, undefined);
		assert.equal(slashCommandSubmitted, false);
	});

	it("applies a model choice to the active draft without materializing a runtime", async () => {
		const selectedModel = { provider: "openai-codex", id: "gpt-5.5", name: "GPT" } as never;
		let applied: { model: unknown; thinking: string } | undefined;
		let materialized = false;
		let commandRan = false;
		const remembered: Array<[string, string]> = [];
		const popupMenus = {
			syncActivePopupMenu: () => "model",
			modelVisibilityModeActive: () => false,
			selectedModelThinking: () => ({
				value: { model: selectedModel, ref: "openai-codex/gpt-5.5", current: false, visible: true },
				thinkingLevel: "high",
				direct: true,
				source: "model",
			}),
			closeModelSelection: () => {},
		} as unknown as AppPopupMenuController;
		const controller = new AppPopupActionController(
			host({
				isDraftTabActive: () => true,
				materializeDraftSession: async () => {
					materialized = true;
					return undefined;
				},
				selectDraftModel: (model, thinking) => { applied = { model, thinking }; },
				saveThinkingLevelForModel: (modelRef, thinkingLevel) => { remembered.push([modelRef, thinkingLevel]); },
			}),
			popupMenus,
			{ runModelThinkingCommand: async () => { commandRan = true; } } as unknown as AppCommandController,
			{} as AppMenuItemsController,
			{} as AppQueuedMessageController,
			{} as AppWorkspaceActionsController,
		);

		assert.equal(await controller.submitActivePopupMenu(), true);
		assert.deepEqual(applied, { model: selectedModel, thinking: "high" });
		assert.equal(materialized, false);
		assert.equal(commandRan, false);
		assert.deepEqual(remembered, [["openai-codex/gpt-5.5", "high"]]);
	});

	it("persists thinking only after a real model selection succeeds", async () => {
		const model = { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" } as never;
		const remembered: Array<[string, string]> = [];
		const popupMenus = {
			syncActivePopupMenu: () => "model",
			modelVisibilityModeActive: () => false,
			selectedModelThinking: () => ({
				value: { model, ref: "openai-codex/gpt-5.6-sol", current: false, visible: true },
				thinkingLevel: "xhigh",
				direct: true,
				source: "model",
			}),
			closeModelSelection: () => {},
		} as unknown as AppPopupMenuController;
		const controller = new AppPopupActionController(
			host({
				runtime: () => ({ session: {} }) as never,
				saveThinkingLevelForModel: (modelRef, thinkingLevel) => { remembered.push([modelRef, thinkingLevel]); },
			}),
			popupMenus,
			{ runModelThinkingCommand: async () => undefined } as unknown as AppCommandController,
			{} as AppMenuItemsController,
			{} as AppQueuedMessageController,
			{} as AppWorkspaceActionsController,
		);

		assert.equal(await controller.submitActivePopupMenu(), true);
		assert.deepEqual(remembered, [["openai-codex/gpt-5.6-sol", "xhigh"]]);
	});

	it("turns a live-session Auto choice into a new Auto draft instead of mutating the session", async () => {
		let openedAutoDraft = 0;
		let commandRan = false;
		const popupMenus = {
			syncActivePopupMenu: () => "model",
			modelVisibilityModeActive: () => false,
			selectedModelThinking: () => ({
				value: { kind: "auto", ref: "pix:auto", current: false, visible: true },
				thinkingLevel: "off",
				direct: true,
				source: "model",
			}),
			closeModelSelection: () => {},
		} as unknown as AppPopupMenuController;
		const controller = new AppPopupActionController(
			host({
				runtime: () => ({ session: {} }) as never,
				openDraftModelAuto: async () => { openedAutoDraft += 1; },
			}),
			popupMenus,
			{ runModelThinkingCommand: async () => { commandRan = true; } } as unknown as AppCommandController,
			{} as AppMenuItemsController,
			{} as AppQueuedMessageController,
			{} as AppWorkspaceActionsController,
		);

		assert.equal(await controller.submitActivePopupMenu(), true);
		assert.equal(openedAutoDraft, 1);
		assert.equal(commandRan, false);
	});
});

function host(overrides: Partial<AppPopupActionControllerHost> = {}): AppPopupActionControllerHost {
	return {
		runtime: () => undefined,
		awaitCurrentSessionExtensions: async () => undefined,
		getBuiltinSlashCommands: () => [],
		isRunning: () => true,
		setInput: () => undefined,
		addEntry: () => undefined,
		setStatus: () => undefined,
		setSessionStatus: () => undefined,
		showToast: () => undefined,
		visibleModels: () => undefined,
		saveVisibleModels: (refs) => refs,
		saveThinkingLevelForModel: () => undefined,
		render: () => undefined,
		afterSessionReplacement: () => undefined,
		scrollToConversationEntry: () => false,
		scrollToUserMessageJumpTarget: async () => false,
		...overrides,
	};
}
