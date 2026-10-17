import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";

import { resolveModelAnswer, runModelWizard, wizardConfigPaths } from "../src/setup/model-wizard.js";

const models = [
	{ provider: "p", id: "a-flash" },
	{ provider: "p", id: "a" },
	{ provider: "p", id: "a-pro" },
];

test("wizard accepts suggestions, writes pix and suite, updates only existing desktop config", async () => {
	const home = mkdtempSync(join(tmpdir(), "pix-wizard-"));
	const result = await runModelWizard({ io: { ask: async () => "", print: () => {} }, models, homeDir: home });
	assert.ok("roles" in result);
	const paths = wizardConfigPaths(home);
	assert.equal(parse(readFileSync(paths.pix, "utf8")).defaultModel.modelRef, "p/a");
	assert.deepEqual(parse(readFileSync(paths.suite, "utf8")).frontierModels, [{ model: "p/a-pro" }]);
	assert.equal(result.written.includes(paths.desktop), false);
});

test("wizard honors numeric answers and updates existing desktop config", async () => {
	const home = mkdtempSync(join(tmpdir(), "pix-wizard-"));
	const paths = wizardConfigPaths(home);
	mkdirSync(join(home, ".config", "pi"), { recursive: true });
	writeFileSync(paths.desktop, "{}\n");
	const answers = ["1", "", ""];
	await runModelWizard({ io: { ask: async () => answers.shift() ?? "", print: () => {} }, models, homeDir: home });
	assert.equal(parse(readFileSync(paths.desktop, "utf8")).defaultModel.modelRef, "p/a");
});

test("skips when no models are available; resolves answers", async () => {
	const result = await runModelWizard({ io: { ask: async () => "", print: () => {} }, models: [] });
	assert.ok("skipped" in result);
	assert.equal(resolveModelAnswer("2", models), "p/a");
	assert.equal(resolveModelAnswer("zzz", models), undefined);
});

test("wizard customizes slots and writes search settings", async () => {
	const { mkdtempSync, readFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { parse } = await import("jsonc-parser");
	const { runModelWizard, wizardConfigPaths } = await import("../src/setup/model-wizard.js");
	const home = mkdtempSync(join(tmpdir(), "wiz-slots-"));
	const models = [{ provider: "p", id: "a" }, { provider: "p", id: "b-flash" }, { provider: "p", id: "c-pro" }, { provider: "p", id: "v", vision: true }];
	const search = { "Embedding provider": "ollama", "Embedding model:": "emb", "Vector size": "768" } as Record<string, string>;
	const asked: string[] = [];
	const io = {
		ask: async (q: string) => {
			asked.push(q);
			if (/Customi[sz]e|individual/i.test(q) || q.includes("Configure search")) return "y";
			for (const [k, v] of Object.entries(search)) if (q.includes(k)) return v;
			return "";
		},
		print: () => {},
	};
	const result = await runModelWizard({ io, models, homeDir: home });
	assert.ok("written" in result);
	const suite = parse(readFileSync(wizardConfigPaths(home).suite, "utf8"));
	assert.equal(suite.search.embedding.embeddingModel, "emb");
	assert.ok(asked.some((q) => q.includes("Lookup")));
});
