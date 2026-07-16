import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppMenuItemsController } from "../src/app/popup/menu-items-controller.js";
import { APP_ICONS } from "../src/app/icons.js";
import type { AgentSessionRuntime, SessionInfo } from "@earendil-works/pi-coding-agent";

describe("AppMenuItemsController queue menu", () => {
	it("wraps slash commands, user messages, and resume sessions as popup items", () => {
		const sessions = [sessionInfo("s1", "/tmp/s1.jsonl", "First")];
		const controller = new AppMenuItemsController({
			runtime: () => ({
				session: {
					sessionFile: "/tmp/current.jsonl",
					extensionRunner: { getRegisteredCommands: () => [] },
					promptTemplates: [],
					resourceLoader: { getSkills: () => ({ skills: [] }) },
				},
				services: { settingsManager: { getEnableSkillCommands: () => false } },
			}) as unknown as AgentSessionRuntime,
			getBuiltinSlashCommands: () => [{ name: "search", description: "Search sessions", kind: "builtin", allowArguments: true }],
			getEntries: () => [{ id: "u1", kind: "user", text: "Find me" }],
			getResumeSessions: () => sessions,
		});

		assert.deepEqual(controller.parseSlashInput("/search term"), { commandName: "search", hasArguments: true, arguments: "term" });
		assert.deepEqual(controller.getSlashCommandMenuItems("sea").map((item) => item.label), ["/search"]);
		assert.deepEqual(controller.getSlashCommandMenuItems("sea")[0]?.labelHighlightRanges, [{ start: 1, end: 4 }]);
		assert.deepEqual(controller.getUserMessageMenuItems().map((item) => item.value), ["copy", "fork", "fork-new-tab", "undo"]);
		assert.equal(controller.getUserMessageJumpMenuItems("find")[0]?.value.entryId, "u1");
		assert.deepEqual(controller.getUserMessageJumpMenuItems("find")[0]?.labelHighlightRanges, [{ start: 3, end: 7 }]);
		assert.deepEqual(controller.getResumeMenuItems("", 5).map((item) => item.label), ["new", "First"]);
		assert.deepEqual(controller.getResumeMenuItems("fir", 5)[1]?.labelHighlightRanges, [{ start: 0, end: 3 }]);
	});

	it("builds model and thinking menus from runtime state and settings", () => {
		const models = [model("zai", "glm-5-turbo", "GLM"), model("openai-codex", "gpt-5.5", "GPT")];
		const runtime = {
			session: {
				model: models[0],
				thinkingLevel: "low",
				scopedModels: [{ model: models[1], thinkingLevel: "high" }],
				getAvailableThinkingLevels: () => ["low", "high"],
			},
			services: {
				settingsManager: { getEnabledModels: () => ["zai/glm-5-turbo:low", "bad-ref", "missing/model"] },
				modelRuntime: {
					getModel: (provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
				},
			},
		} as unknown as AgentSessionRuntime;
		const controller = new AppMenuItemsController(host(runtime));

		assert.deepEqual(controller.getModelMenuItems("").map((item) => item.label), ["openai-codex/gpt-5.5"]);
		assert.deepEqual(controller.getModelMenuItems("gpt")[0]?.labelHighlightRanges, [{ start: 13, end: 16 }]);
		assert.deepEqual(controller.getThinkingMenuItems("").map((item) => item.label), [`low ${APP_ICONS.check}`, "high"]);
		assert.equal(controller.getFavoriteScopedModels()[0]?.thinkingLevel, "low");
	});

	it("uses available thinking levels without forcing unavailable current levels", () => {
		const runtime = {
			session: {
				model: model("zai", "glm-5-turbo", "GLM"),
				thinkingLevel: "low",
				scopedModels: [],
				getAvailableThinkingLevels: () => ["high", "xhigh", "max"],
			},
			services: { settingsManager: { getEnabledModels: () => undefined } },
		} as unknown as AgentSessionRuntime;
		const controller = new AppMenuItemsController(host(runtime));

		assert.deepEqual(controller.getThinkingMenuItems("").map((item) => item.label), ["high", "xhigh", "max"]);
	});

	it("uses one universal cancellation item for queued messages", () => {
		const controller = new AppMenuItemsController(host(undefined));
		const items = controller.getQueueMessageMenuItems();

		assert.deepEqual(items.map((item) => item.value), ["cancel", "edit", "send-now"]);
		assert.equal(items[0]?.label, "Cancel send");
		assert.equal(items[0]?.description, "Remove this message from the queue");
	});

	it("refreshes jump items from the full session branch", async () => {
		const runtime = {
			session: {
				sessionFile: "/tmp/current.jsonl",
				sessionManager: {
					readFullBranchEntries: async () => [
						{ type: "message", id: "old-session-entry", message: { role: "user", content: "Older prompt" } },
						{ type: "message", id: "loaded-session-entry", message: { role: "user", content: "Loaded prompt" } },
					],
				},
				extensionRunner: { getRegisteredCommands: () => [] },
				promptTemplates: [],
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			services: { settingsManager: { getEnableSkillCommands: () => false } },
		} as unknown as AgentSessionRuntime;
		const controller = new AppMenuItemsController({
			...host(runtime),
			getEntries: () => [{ id: "visible-user", kind: "user", text: "Loaded prompt", sessionEntryId: "loaded-session-entry" }],
		});

		await controller.refreshUserMessageJumpMenuItems();

		const older = controller.getUserMessageJumpMenuItems("older")[0];
		assert.equal(older?.value.sessionEntryId, "old-session-entry");
		assert.equal(older?.value.entryId, undefined);

		const loaded = controller.getUserMessageJumpMenuItems("loaded")[0];
		assert.equal(loaded?.value.sessionEntryId, "loaded-session-entry");
		assert.equal(loaded?.value.entryId, "visible-user");
	});
});

function host(runtime: AgentSessionRuntime | undefined) {
	return {
		runtime: () => runtime,
		getBuiltinSlashCommands: () => [],
		getEntries: () => [],
		getResumeSessions: () => [],
	};
}

function model(provider: string, id: string, name: string) {
	return { provider, id, name };
}

function sessionInfo(id: string, path: string, firstMessage: string): SessionInfo {
	return {
		path,
		id,
		cwd: "/workspace",
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-01T00:00:00Z"),
		messageCount: 1,
		firstMessage,
		allMessagesText: firstMessage,
	};
}
