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
		render: () => undefined,
		afterSessionReplacement: () => undefined,
		scrollToConversationEntry: () => false,
		scrollToUserMessageJumpTarget: async () => false,
		...overrides,
	};
}
