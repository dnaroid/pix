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

		assert.deepEqual(events.slice(0, 7), [
			"status:selecting model openai/gpt-5",
			"render",
			"setModel:openai/gpt-5",
			"entry:Selected model openai/gpt-5",
			"status:reloading resources for openai/gpt-5",
			"render",
			"reload",
		]);
		assert.match(events[7] ?? "", /^entry:Reloaded resources after model change to openai\/gpt-5\n\nModel: openai\/gpt-5/);
		assert.deepEqual(events.slice(8), [
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

	it("does not apply a late model result to a different active runtime", async () => {
		const events: string[] = [];
		let resolveModel!: () => void;
		const session = {
			isStreaming: false,
			async setModel(model: SessionModel) {
				events.push(`setModel:${model.provider}/${model.id}`);
				await new Promise<void>((resolve) => { resolveModel = resolve; });
			},
			async reload() {
				events.push("reload");
			},
		};
		const host = createHost(session, events);
		let activeRuntime = host.runtime();
		host.runtime = () => activeRuntime;

		const changing = new ModelCommandActions(host).runModelCommand(model("openai", "gpt-5"));
		activeRuntime = { session: {} } as ReturnType<CommandControllerHost["runtime"]>;
		resolveModel();
		await changing;

		assert.deepEqual(events, [
			"status:selecting model openai/gpt-5",
			"render",
			"setModel:openai/gpt-5",
		]);
	});
});

describe("ModelCommandActions.runModelThinkingCommand", () => {
	it("stages model and thinking together before the model reload", async () => {
		const events: string[] = [];
		const session = {
			isStreaming: false,
			model: { provider: "anthropic", id: "old" },
			thinkingLevel: "medium",
			async setModel(nextModel: SessionModel) {
				events.push(`setModel:${nextModel.provider}/${nextModel.id}`);
				this.model = nextModel;
				this.thinkingLevel = "medium";
			},
			setThinkingLevel(level: string) {
				events.push(`thinking:${level}`);
				this.thinkingLevel = level;
			},
			async reload() {
				events.push("reload");
			},
		};
		const host = createHost(session, events);

		await new ModelCommandActions(host).runModelThinkingCommand(model("openai", "gpt-5"), "high");

		assert.ok(events.indexOf("setModel:openai/gpt-5") < events.indexOf("thinking:high"));
		assert.ok(events.indexOf("thinking:high") < events.indexOf("reload"));
		assert.ok(events.includes("entry:Selected model openai/gpt-5"));
		assert.ok(events.includes("entry:Selected thinking level high"));
		assert.ok(events.includes("persist:Selected thinking level high"));
	});

	it("changes only thinking without reloading when the model is unchanged", async () => {
		const events: string[] = [];
		const session = {
			isStreaming: false,
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "low",
			async setModel() {
				events.push("setModel");
			},
			setThinkingLevel(level: string) {
				events.push(`thinking:${level}`);
				this.thinkingLevel = level;
			},
			async reload() {
				events.push("reload");
			},
		};
		const host = createHost(session, events);

		await new ModelCommandActions(host).runModelThinkingCommand(model("openai", "gpt-5"), "high");

		assert.ok(events.includes("thinking:high"));
		assert.ok(!events.includes("setModel"));
		assert.ok(!events.includes("reload"));
	});
});

describe("ModelCommandActions combined selector entry points", () => {
	it("opens the same staged selector from argument-free /model and /thinking", async () => {
		const opened: string[] = [];
		const host = {
			runtime: () => ({ session: {} }),
			isRunning: () => true,
			openDirectPopupMenu: (menu: string) => opened.push(menu),
			render: () => undefined,
		} as unknown as CommandControllerHost;
		const actions = new ModelCommandActions(host);

		await actions.runModelSlashCommand("");
		await actions.runThinkingSlashCommand("");

		assert.deepEqual(opened, ["model", "thinking"]);
	});
});

describe("ModelCommandActions.runScopedModelsCommand", () => {
	it("resets model scope to all available models", async () => {
		const events: string[] = [];
		const session = {
			isStreaming: false,
			setScopedModels(models: unknown[]) {
				events.push(`scope:${models.length}`);
			},
		};
		const runtime = {
			session,
			services: {
				settingsManager: {
					setEnabledModels(models: string[] | undefined) {
						events.push(`settings:${models === undefined ? "unset" : models.join(",")}`);
					},
				},
			},
		};
		const host = {
			runtime: () => runtime,
			isRunning: () => true,
			addEntry: (entry: { text?: string }) => events.push(`entry:${entry.text ?? ""}`),
			setSessionStatus: () => events.push("session-status"),
			toast: { error: () => {}, warning: () => {} },
		} as unknown as CommandControllerHost;

		await new ModelCommandActions(host).runScopedModelsCommand("reset");

		assert.deepEqual(events, [
			"settings:unset",
			"scope:0",
			"entry:Model scope reset to all available models.",
			"session-status",
		]);
	});
});

function createHost(session: {
	isStreaming: boolean;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	setModel(model: SessionModel): Promise<void>;
	setThinkingLevel?(level: string): void;
	reload(): Promise<void>;
}, events: string[]): CommandControllerHost {
	const decoratedSession = Object.assign(session, {
		model: session.model ?? { provider: "openai", id: "gpt-5" },
		thinkingLevel: session.thinkingLevel ?? "off",
		setThinkingLevel: session.setThinkingLevel ?? ((level: string) => { decoratedSession.thinkingLevel = level; }),
		sessionManager: {
			appendCustomEntry: (_type: string, data: { text?: string }) => events.push(`persist:${data.text ?? ""}`),
		},
		getActiveToolNames: () => ["read"],
		resourceLoader: { getSkills: () => ({ skills: [] }) },
	});
	const runtime = { session: decoratedSession };
	return ({
		runtime: () => runtime,
		isRunning: () => true,
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
