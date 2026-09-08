import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { SessionCommandActions } from "../src/app/commands/command-session-actions.js";
import type { CommandControllerHost } from "../src/app/commands/command-host.js";

describe("SessionCommandActions.runReloadCommand", () => {
	it("reports the resources actually available to the current model after reload", async () => {
		const entries: string[] = [];
		const events: string[] = [];
		const runtime = ({
			cwd: "/tmp/project",
			session: {
				isStreaming: false,
				model: { provider: "openai-codex", id: "gpt-5.6-luna" },
				thinkingLevel: "medium",
				getActiveToolNames: () => ["repo_search", "read", "subagents"],
				resourceLoader: {
					getSkills: () => ({
						skills: [
							{ name: "frontier-model-rollover" },
							{ name: "project-agent-creator" },
						],
					}),
				},
				async reload() { events.push("reload"); },
			},
		} as unknown) as AgentSessionRuntime;
		const host = ({
			options: {},
			runtime: () => runtime,
			subagentTypes: () => ["research", "frontier-review"],
			isRunning: () => true,
			awaitCurrentSessionExtensions: async () => { events.push("await-extensions"); },
			setStatus: (status: string) => events.push(`status:${status}`),
			render: () => events.push("render"),
			setSessionStatus: () => events.push("session-status"),
			addEntry: (entry: { text: string }) => entries.push(entry.text),
			toast: { success: (message: string) => events.push(`toast:${message}`) },
		} as unknown) as CommandControllerHost;

		await new SessionCommandActions(host).runReloadCommand();

		assert.deepEqual(events, [
			"status:reloading",
			"render",
			"await-extensions",
			"reload",
			"session-status",
			"toast:Reloaded resources",
		]);
		assert.equal(entries.length, 1);
		assert.match(entries[0]!, /Model: openai-codex\/gpt-5\.6-luna:medium/);
		assert.match(entries[0]!, /Skills \(in context\): frontier-model-rollover, project-agent-creator/);
		assert.match(entries[0]!, /Tools \(active\): repo_search, read, subagents/);
		assert.match(entries[0]!, /Agents \(available\): frontier-review, research/);
	});
});
