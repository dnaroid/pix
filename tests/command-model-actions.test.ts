import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ModelCommandActions } from "../src/app/commands/command-model-actions.js";
import type { CommandControllerHost } from "../src/app/commands/command-host.js";
import type { SessionModel } from "../src/app/types.js";

describe("ModelCommandActions.runModelCommand", () => {
	it("reloads resources after switching models when idle", async () => {
		const events: string[] = [];
		const session = {
			isStreaming: false,
			async setModel(model: SessionModel) {
				events.push(`setModel:${model.provider}/${model.id}`);
			},
			async reload() {
				events.push("reload");
			},
		};
		const host = createHost(session, events);

		await new ModelCommandActions(host).runModelCommand(model("openai", "gpt-5"));

		assert.deepEqual(events, [
			"status:selecting model openai/gpt-5",
			"render",
			"setModel:openai/gpt-5",
			"entry:Selected model openai/gpt-5",
			"status:reloading resources for openai/gpt-5",
			"render",
			"reload",
			"entry:Reloaded resources after model change to openai/gpt-5",
			"toast:success:Model changed and resources reloaded",
			"session-status",
		]);
	});

	it("keeps the model change but reports reload failures", async () => {
		const events: string[] = [];
		const session = {
			isStreaming: false,
			async setModel(model: SessionModel) {
				events.push(`setModel:${model.provider}/${model.id}`);
			},
			async reload() {
				events.push("reload");
				throw new Error("boom");
			},
		};
		const host = createHost(session, events);

		await new ModelCommandActions(host).runModelCommand(model("openai", "gpt-5"));

		assert.deepEqual(events, [
			"status:selecting model openai/gpt-5",
			"render",
			"setModel:openai/gpt-5",
			"entry:Selected model openai/gpt-5",
			"status:reloading resources for openai/gpt-5",
			"render",
			"reload",
			"entry:Model changed to openai/gpt-5, but reload failed: boom",
			"toast:error:Model changed, but reload failed",
			"session-status",
		]);
	});

	it("skips reload while the agent is already running", async () => {
		const events: string[] = [];
		const session = {
			isStreaming: true,
			async setModel(model: SessionModel) {
				events.push(`setModel:${model.provider}/${model.id}`);
			},
			async reload() {
				events.push("reload");
			},
		};
		const host = createHost(session, events);

		await new ModelCommandActions(host).runModelCommand(model("openai", "gpt-5"));

		assert.deepEqual(events, [
			"status:selecting model openai/gpt-5",
			"render",
			"setModel:openai/gpt-5",
			"entry:Selected model openai/gpt-5",
			"entry:Skipped reload because the agent is still running. Run /reload when idle to refresh model-specific tools.",
			"toast:warning:Model changed; reload skipped while the agent is running",
			"session-status",
		]);
	});
});

function createHost(session: { isStreaming: boolean; setModel(model: SessionModel): Promise<void>; reload(): Promise<void> }, events: string[]): CommandControllerHost {
	return ({
		runtime: () => ({ session }),
		modelRef: (item: SessionModel) => `${item.provider}/${item.id}`,
		setStatus: (status: string) => events.push(`status:${status}`),
		render: () => events.push("render"),
		addEntry: (entry: { text?: string }) => events.push(`entry:${entry.text ?? ""}`),
		setSessionStatus: () => events.push("session-status"),
		toast: {
			success: (message: string) => events.push(`toast:success:${message}`),
			error: (message: string) => events.push(`toast:error:${message}`),
			warning: (message: string) => events.push(`toast:warning:${message}`),
		},
	} as unknown) as CommandControllerHost;
}

function model(provider: string, id: string): SessionModel {
	return { provider, id } as SessionModel;
}
