import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSupervisorWorkerModels, supervisorWorkerModelGuidance } from "../src/acp/supervisor-worker-models.js";
import supervisorExtension from "../src/extensions/supervisor.js";

test("supervisor loads only Desktop models, with live project overrides by tier", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pix-worker-models-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const cwd = join(root, "workspace");
	const profile = join(home, ".config/pi/pix-desktop.jsonc");
	const project = join(cwd, ".pi/pix-desktop.jsonc");
	const warnings: string[] = [];
	const load = () => loadSupervisorWorkerModels(cwd, (warning) => warnings.push(warning), home);
	const writeModels = async (path: string, workerModels: unknown) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ supervisor: { workerModels } }));
	};
	await writeModels(join(dirname(profile), "pix.jsonc"), { standard: { modelRef: "p/tui" } });
	assert.deepEqual(await load(), {});
	assert.deepEqual(warnings, []);
	await writeModels(profile, {
		simple: { modelRef: "p/fast", thinking: "off" },
		standard: { modelRef: "p/main", thinking: "medium" },
		complex: { modelRef: "p/strong", thinking: "high" },
	});
	await writeModels(project, { standard: { modelRef: "p/local" }, complex: { modelRef: "p/unsafe\ninstruction" } });
	const models = await load();
	assert.deepEqual(models, { simple: "p/fast:off", standard: "p/local", complex: "p/strong:high" });
	assert.match(warnings[0] ?? "", /Invalid complex supervisor worker model/);
	const guidance = supervisorWorkerModelGuidance(models) ?? "";
	assert.match(guidance, /^- standard: p\/local$/m);
	assert.match(guidance, /saved task's own model always takes precedence/);
	assert.equal(supervisorWorkerModelGuidance({}), undefined);
	await writeModels(project, { standard: { modelRef: "p/changed", thinking: "low" } });
	assert.equal((await load()).standard, "p/changed:low");
});

test("supervisor extension adds current tiers to the system prompt of each run", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pix-worker-prompt-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await mkdir(join(cwd, ".pi"));
	const writeConfig = (modelRef: string) => writeFile(join(cwd, ".pi/pix-desktop.jsonc"), JSON.stringify({
		supervisor: { workerModels: { standard: { modelRef, thinking: "low" } } },
	}));
	let beforeStart: ((event: BeforeAgentStartEvent) => Promise<BeforeAgentStartEventResult | undefined>) | undefined;
	supervisorExtension({
		on: (event: string, handler: typeof beforeStart) => { if (event === "before_agent_start") beforeStart = handler; },
		registerTool: () => {},
	} as unknown as ExtensionAPI);
	assert.ok(beforeStart);
	const sections = { existing: "Keep this", supervisor_worker_models: "" };
	const event = { systemPrompt: "Existing prompt", systemPromptOptions: { cwd, sections } } as unknown as BeforeAgentStartEvent;
	await writeConfig("p/first");
	await beforeStart(event);
	assert.match(sections.supervisor_worker_models, /^- standard: p\/first:low$/m);
	await writeConfig("p/next");
	await beforeStart(event);
	assert.match(sections.supervisor_worker_models, /^- standard: p\/next:low$/m);
	assert.doesNotMatch(sections.supervisor_worker_models, /p\/first/);
	assert.equal(sections.existing, "Keep this");
	event.systemPromptOptions.forceSystemPrompt = "Existing prompt";
	assert.match((await beforeStart(event))?.systemPrompt ?? "", /^Existing prompt[\s\S]+p\/next:low/);
});
