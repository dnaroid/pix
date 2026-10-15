import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { projectAgentsResourceOptions } from "../src/app/project-agents-context.js";

test("TUI context includes project-local private rules last and refreshes on reload", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pix-local-agents-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, "AGENTS.md"), "Shared project rules");
	const file = join(cwd, ".pi", "AGENTS.md");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, ".pi-agent"),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		...projectAgentsResourceOptions(cwd, false),
	});
	await loader.reload();
	assert.deepEqual(loader.getAgentsFiles().agentsFiles, [
		{ path: join(cwd, "AGENTS.md"), content: "Shared project rules" },
	]);
	writeFileSync(file, "\uFEFFPersonal private instructions");
	await loader.reload();
	assert.deepEqual(loader.getAgentsFiles().agentsFiles, [
		{ path: join(cwd, "AGENTS.md"), content: "Shared project rules" },
		{ path: file, content: "Personal private instructions" },
	]);
	writeFileSync(file, "Updated private instructions");
	await loader.reload();
	assert.equal(loader.getAgentsFiles().agentsFiles.at(-1)?.content, "Updated private instructions");
});

test("disabled context files skip both ordinary and private project rules", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pix-no-local-agents-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, "AGENTS.md"), "Shared project rules");
	writeFileSync(join(cwd, ".pi", "AGENTS.md"), "Private project rules");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, ".pi-agent"),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		...projectAgentsResourceOptions(cwd, true),
	});
	await loader.reload();
	assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
});
