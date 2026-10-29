import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseDesktopSelectionAssistRequest } from "../src/acp/desktop-commands.js";
import { pixProjectConfigPath, pixUserConfigPath } from "../src/acp/pix-config-paths.js";
import { createSelectionAssistant, loadSelectionAssistConfig } from "../src/acp/selection-assist.js";

async function fixture(user: string, project?: string): Promise<{ home: string; cwd: string }> {
	const root = mkdtempSync(join(tmpdir(), "pix-selection-assist-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	const userPath = pixUserConfigPath(home);
	await mkdir(dirname(userPath), { recursive: true });
	await writeFile(userPath, user);
	if (project !== undefined) {
		const projectPath = pixProjectConfigPath(cwd);
		await mkdir(dirname(projectPath), { recursive: true });
		await writeFile(projectPath, project);
	}
	return { home, cwd };
}

test("selection assistant reuses the autocomplete chain and defaults to ru", async () => {
	const { home, cwd } = await fixture(`{ "autocomplete": { "modelRef": "p/auto", "fallbackModels": ["p/auto-fb"] } }`);
	assert.deepEqual(loadSelectionAssistConfig(cwd, home), { modelRefs: ["p/auto", "p/auto-fb"], language: "ru" });
});

test("selection assistant config wins over autocomplete and project overrides user", async () => {
	const { home, cwd } = await fixture(
		`{ "autocomplete": { "modelRef": "p/auto" }, "selectionAssist": { "modelRef": "p/sel", "fallbackModels": ["p/sel-fb", "p/sel"], "language": "en" } }`,
		`{ "selectionAssist": { "language": "de" } }`,
	);
	assert.deepEqual(loadSelectionAssistConfig(cwd, home), { modelRefs: ["p/sel", "p/sel-fb"], language: "de" });
});

test("selection assist request parser validates action and text", () => {
	assert.deepEqual(
		parseDesktopSelectionAssistRequest({ cwd: "/w", action: "explain", text: "x()", context: "a\nx()", path: "src/a.ts" }),
		{ cwd: "/w", action: "explain", text: "x()", context: "a\nx()", path: "src/a.ts" },
	);
	assert.deepEqual(parseDesktopSelectionAssistRequest({ cwd: "/w", action: "translate", text: "hi" }), { cwd: "/w", action: "translate", text: "hi" });
	assert.throws(() => parseDesktopSelectionAssistRequest({ cwd: "/w", action: "summarize", text: "hi" }));
	assert.throws(() => parseDesktopSelectionAssistRequest({ cwd: "/w", action: "translate", text: "  " }));
	assert.throws(() => parseDesktopSelectionAssistRequest({ cwd: "/w", action: "translate", text: "x".repeat(20_001) }));
});

test("selection assistant tries fallbacks in order and puts the language in the prompt", async () => {
	const calls: { model: string; systemPrompt: string }[] = [];
	const runtime = {
		getModel: (provider: string, id: string) => ({ provider, id, maxTokens: 0 }),
		refresh: async () => {},
		streamSimple: (model: { provider: string; id: string }, ctx: { systemPrompt: string }) => {
			calls.push({ model: `${model.provider}/${model.id}`, systemPrompt: ctx.systemPrompt });
			return (async function* () {
				if (model.id === "bad") yield { type: "error", reason: "error", error: { errorMessage: "boom" } };
				else yield { type: "text_delta", delta: " Привет " };
			})();
		},
	};
	const assist = createSelectionAssistant({
		createModelRuntime: async () => runtime as never,
		loadConfig: () => ({ modelRefs: ["p/bad", "p/good"], language: "ru" }),
	});
	const deltas: unknown[] = [];
	const text = await assist({ cwd: "/w", action: "translate", text: "Hello", signal: new AbortController().signal, onDelta: (d) => { deltas.push(d); } });
	assert.equal(text, "Привет");
	assert.deepEqual(deltas, [{ text: " Привет " }]);
	assert.deepEqual(calls.map((c) => c.model), ["p/bad", "p/good"]);
	assert.match(calls[0]!.systemPrompt, /ru/);
});

test("selection assistant resets streamed text before a fallback and skips reasoning by default", async () => {
	const options: Record<string, unknown>[] = [];
	const runtime = {
		getModel: (provider: string, id: string) => ({ provider, id, maxTokens: 0 }),
		refresh: async () => {},
		streamSimple: (model: { id: string }, _ctx: unknown, opts: Record<string, unknown>) => {
			options.push(opts);
			return (async function* () {
				yield { type: "text_delta", delta: model.id === "bad" ? "partial" : "ok" };
				if (model.id === "bad") yield { type: "error", reason: "error", error: { errorMessage: "boom" } };
			})();
		},
	};
	const assist = createSelectionAssistant({
		createModelRuntime: async () => runtime as never,
		loadConfig: () => ({ modelRefs: ["p/bad", "p/good"], language: "ru" }),
	});
	const deltas: unknown[] = [];
	assert.equal(await assist({ cwd: "/w", action: "explain", text: "x()", signal: new AbortController().signal, onDelta: (d) => { deltas.push(d); } }), "ok");
	assert.deepEqual(deltas, [{ text: "partial" }, { reset: true }, { text: "ok" }]);
	assert.equal(options[0]!.reasoning, undefined);
	assert.equal(options[0]!.maxTokens, 400);
});

test("selection assist request parser accepts a streaming request id", () => {
	assert.equal(parseDesktopSelectionAssistRequest({ cwd: "/w", action: "translate", text: "hi", requestId: "r1" }).requestId, "r1");
	assert.throws(() => parseDesktopSelectionAssistRequest({ cwd: "/w", action: "translate", text: "hi", requestId: "" }));
});

test("selection assistant cancellation does not advance the chain", async () => {
	const controller = new AbortController();
	const seen: string[] = [];
	const runtime = {
		getModel: (provider: string, id: string) => ({ provider, id, maxTokens: 0 }),
		refresh: async () => {},
		streamSimple: (model: { id: string }) => {
			seen.push(model.id);
			controller.abort(new Error("cancelled"));
			return (async function* () { yield { type: "error", reason: "aborted", error: { errorMessage: "aborted" } }; })();
		},
	};
	const assist = createSelectionAssistant({
		createModelRuntime: async () => runtime as never,
		loadConfig: () => ({ modelRefs: ["p/a", "p/b"], language: "ru" }),
	});
	await assert.rejects(assist({ cwd: "/w", action: "explain", text: "x()", signal: controller.signal }), /cancelled/);
	assert.deepEqual(seen, ["a"]);
});
