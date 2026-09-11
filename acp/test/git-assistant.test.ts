import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitAssistant, loadGitAssistantModelRef, loadGitAssistantModelRefs } from "../src/acp/git-assistant.js";

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

test("Git assistant keeps and executes the configured fallback chain", async () => {
	const root = mkdtempSync(join(tmpdir(), "pix-git-assistant-fallback-"));
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, ".pi", "pix.jsonc"), `{
		"desktop": {
			"git": {
				"reviewModelRef": "missing/primary:medium",
				"reviewFallbackModels": ["provider/fallback:low"]
			}
		}
	}\n`, "utf8");

	assert.deepEqual(loadGitAssistantModelRefs(cwd, "review"), [
		"missing/primary:medium",
		"provider/fallback:low",
	]);

	const streamed: string[] = [];
	const assistant = createGitAssistant({
		createModelRuntime: async () => ({
			getModel: (provider: string, modelId: string) => provider === "provider" && modelId === "fallback"
				? { provider, id: modelId, maxTokens: 4_096 }
				: undefined,
			refresh: async () => {},
			streamSimple: (model: { provider: string; id: string }) => {
				streamed.push(`${model.provider}/${model.id}`);
				return (async function* () {
					yield { type: "text_delta", delta: "No significant findings." };
				})();
			},
		}) as never,
		timeoutMs: 1_000,
	});

	const result = await assistant({
		cwd,
		kind: "review",
		diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
		signal: new AbortController().signal,
	});

	assert.equal(result, "No significant findings.");
	assert.deepEqual(streamed, ["provider/fallback"]);
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

test("Git assistant gives code review more time than commit-message generation", async () => {
	const timeoutValues: number[] = [];
	const assistant = createGitAssistant({
		createModelRuntime: async () => ({
			getModel: (provider: string, modelId: string) => ({ provider, id: modelId, maxTokens: 4_096 }),
			refresh: async () => {},
			streamSimple: (_model: unknown, _context: unknown, options: { timeoutMs?: number }) => {
				timeoutValues.push(options.timeoutMs ?? 0);
				return (async function* () {
					yield { type: "text_delta", delta: "ok" };
				})();
			},
		}) as never,
		loadModelRef: () => "provider/model",
	});

	for (const kind of ["review", "commit-message"] as const) {
		await assistant({
			cwd: "/tmp/project",
			kind,
			diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
			signal: new AbortController().signal,
		});
	}

	assert.deepEqual(timeoutValues, [120_000, 45_000]);
});

