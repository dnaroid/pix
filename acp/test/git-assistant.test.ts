import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitAssistant, loadGitAssistantModelRef } from "../src/acp/git-assistant.js";

test("Git assistant model config has independent review/commit values with project overrides", async () => {
	const root = mkdtempSync(join(tmpdir(), "pix-git-assistant-config-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	await mkdir(join(home, ".config", "pi"), { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(home, ".config", "pi", "pix.jsonc"), `{
		"desktop": {
			"git": {
				"reviewModelRef": "provider/global-review:high",
				"commitMessageModelRef": "provider/global-commit:minimal"
			}
		}
	}\n`, "utf8");
	await writeFile(join(cwd, ".pi", "pix.jsonc"), `{
		"desktop": {
			"git": {
				"reviewModelRef": "provider/project-review:medium"
			}
		}
	}\n`, "utf8");

	assert.equal(loadGitAssistantModelRef(cwd, "review", home), "provider/project-review:medium");
	assert.equal(loadGitAssistantModelRef(cwd, "commit-message", home), "provider/global-commit:minimal");
});

test("Git assistant timeout includes ModelRuntime initialization", async () => {
	const assistant = createGitAssistant({
		createModelRuntime: async () => await new Promise<never>(() => {}),
		loadModelRef: () => "provider/model",
		timeoutMs: 25,
	});
	const startedAt = Date.now();

	await assert.rejects(
		assistant({
			cwd: "/tmp/project",
			kind: "review",
			diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
			signal: new AbortController().signal,
		}),
		/timeout|aborted/iu,
	);
	assert.ok(Date.now() - startedAt < 1_000, "runtime initialization should be bounded by the request timeout");
});

