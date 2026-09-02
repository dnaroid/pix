import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyConfigOption,
	buildConfigOptions,
	modelValue,
	parseModelValue,
} from "../src/acp/config-options.js";
import type { PiClient, PiModel, PiSessionState } from "../src/pi/pi-rpc-client.js";

/** Minimal PiClient fake; only the methods used by config-options. */
function fakePi(overrides: {
	state?: Partial<PiSessionState>;
	models?: PiModel[];
	levels?: string[];
} = {}): PiClient & { state: PiSessionState } {
	const state: PiSessionState = {
		model: { provider: "anthropic", id: "claude-4" },
		thinkingLevel: "medium",
		sessionFile: "/tmp/s.jsonl",
		sessionId: "s1",
		isStreaming: false,
		...overrides.state,
	};
	return {
		state,
		start: async () => {},
		stop: async () => {},
		onEvent: () => () => {},
		prompt: async () => {},
		steer: async () => {},
		followUp: async () => {},
		abort: async () => {},
		respondToExtensionUi: () => {},
		getState: async () => state,
		switchSession: async () => ({ cancelled: false }),
		clone: async () => ({ cancelled: false }),
		getMessages: async () => [],
		setSessionName: async () => {},
		getAvailableModels: async () => overrides.models ?? [{ provider: "anthropic", id: "claude-4" }],
		getAvailableThinkingLevels: async () => overrides.levels ?? ["off", "medium", "high"],
		setModel: async () => state.model!,
		cycleModel: async () => null,
		setThinkingLevel: async () => {},
		setAutoCompaction: async () => {},
		setSteeringMode: async () => {},
		setFollowUpMode: async () => {},
		compact: async () => ({ summary: "", tokensBefore: 0 }),
		exportHtml: async () => ({ path: "/tmp/out.html" }),
	} as PiClient & { state: PiSessionState };
}

test("buildConfigOptions exposes grouped model selector and thought levels", async () => {
	const pi = fakePi({
		models: [
			{ provider: "anthropic", id: "claude-4", name: "Claude 4" },
			{ provider: "anthropic", id: "claude-3" },
			{ provider: "openai", id: "gpt-5", name: "GPT-5" },
		],
	});
	const options = await buildConfigOptions(pi);

	assert.equal(options.length, 2);
	const model = options[0]!;
	assert.equal(model.type, "select");
	assert.equal(model.id, "model");
	assert.equal(model.category, "model");
	assert.equal(model.currentValue, "anthropic/claude-4");
	assert.deepEqual(
		(model.options as { group: string }[]).map((group) => group.group),
		["anthropic", "openai"],
	);
	const anthropic = (model.options as { options: { value: string }[] }[])[0]!;
	assert.deepEqual(
		anthropic.options.map((option) => option.value),
		["anthropic/claude-3", "anthropic/claude-4"],
	);

	const thought = options[1]!;
	assert.equal(thought.id, "thought_level");
	assert.equal(thought.currentValue, "medium");
	assert.deepEqual(
		(thought.options as { value: string }[]).map((option) => option.value),
		["off", "medium", "high"],
	);
});

test("options are omitted when pi exposes no models or levels", async () => {
	assert.deepEqual(await buildConfigOptions(fakePi({ models: [], levels: [] })), []);
	const noModel = fakePi({ state: { model: undefined } });
	const options = await buildConfigOptions(noModel);
	assert.deepEqual(
		options.map((o) => o.id),
		["thought_level"],
		"model option dropped, thought levels still exposed",
	);
});

test("unknown current thinking level falls back to the first option", async () => {
	const pi = fakePi({ state: { thinkingLevel: "xhigh" }, levels: ["off", "high"] });
	const options = await buildConfigOptions(pi);
	assert.equal(options[1]!.currentValue, "off");
});

test("modelValue round-trips through parseModelValue", () => {
	assert.equal(modelValue("anthropic", "claude-4"), "anthropic/claude-4");
	assert.deepEqual(parseModelValue("anthropic/claude-4"), { provider: "anthropic", modelId: "claude-4" });
	assert.equal(parseModelValue("no-slash"), undefined);
	assert.equal(parseModelValue("/leading"), undefined);
	assert.equal(parseModelValue("trailing/"), undefined);
});

test("applyConfigOption validates option ids and values", async () => {
	const pi = fakePi();
	await assert.rejects(applyConfigOption(pi, "bogus", "x"), /unknown config option/);
	await assert.rejects(applyConfigOption(pi, "model", "nodash"), /invalid model value/);
	await assert.rejects(applyConfigOption(pi, "thought_level", "quantum"), /unknown thought level/);
});
