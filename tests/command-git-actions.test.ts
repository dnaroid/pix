import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import {
	GitCommandActions,
	loadGitAssistantModelRefs,
} from "../src/app/commands/command-git-actions.js";
import type { CommandControllerHost } from "../src/app/commands/command-host.js";
import type { AsyncProcessResult, RunProcessOptions } from "../src/app/process.js";

describe("GitCommandActions", () => {
	it("generates a commit message, shows it, and commits staged changes after confirmation", async () => {
		const entries: string[] = [];
		const processCalls: Array<{ args: readonly string[]; options?: RunProcessOptions }> = [];
		const runtime = fakeRuntime("/workspace");
		const host = fakeHost(runtime, entries, async () => "commit");
		const runProcess = async (_command: string, args: readonly string[] = [], options?: RunProcessOptions): Promise<AsyncProcessResult> => {
			processCalls.push({ args, options });
			if (args[0] === "rev-parse") return ok("/repo\n");
			if (args[0] === "diff") return ok("diff --git a/a.ts b/a.ts\n+const a = 1;\n");
			if (args[0] === "commit") return ok("[main abc1234] Add a\n");
			throw new Error(`unexpected git args: ${args.join(" ")}`);
		};
		const actions = new GitCommandActions(host, {
			runProcess,
			generateGitAssistantText: async (_runtime, kind, diff) => {
				assert.equal(kind, "commit-message");
				assert.match(diff, /const a = 1/u);
				return "Add a";
			},
		});

		await actions.runCommitMessageCommand();

		assert.ok(entries.some((entry) => entry === "Generated commit message\n\nAdd a"));
		assert.ok(entries.some((entry) => entry.includes("Git commit created")));
		const commit = processCalls.find((call) => call.args[0] === "commit");
		assert.deepEqual(commit?.args, ["commit", "-F", "-"]);
		assert.equal(commit?.options?.input, "Add a\n");
	});

	it("refuses to commit when staged changes changed after generation", async () => {
		const entries: string[] = [];
		const runtime = fakeRuntime("/workspace");
		let stagedReads = 0;
		let committed = false;
		const actions = new GitCommandActions(fakeHost(runtime, entries, async () => "commit"), {
			runProcess: async (_command, args = []) => {
				if (args[0] === "rev-parse") return ok("/repo\n");
				if (args[0] === "diff") return ok(++stagedReads === 1 ? "first diff" : "changed diff");
				if (args[0] === "commit") {
					committed = true;
					return ok();
				}
				throw new Error(`unexpected git args: ${args.join(" ")}`);
			},
			generateGitAssistantText: async () => "Describe first diff",
		});

		await actions.runCommitMessageCommand();

		assert.equal(committed, false);
		assert.ok(entries.some((entry) => entry.includes("Staged changes changed")));
	});

	it("reviews staged, unstaged, and untracked files", async () => {
		const root = mkdtempSync(join(tmpdir(), "pix-git-review-"));
		try {
			writeFileSync(join(root, "new.ts"), "export const added = true;\n");
			const entries: string[] = [];
			const runtime = fakeRuntime(root);
			let assistantInput = "";
			const actions = new GitCommandActions(fakeHost(runtime, entries), {
				runProcess: async (_command, args = []) => {
					if (args[0] === "rev-parse") return ok(`${root}\n`);
					if (args[0] === "diff" && args.includes("--cached")) return ok("staged diff\n");
					if (args[0] === "diff") return ok("working diff\n");
					if (args[0] === "ls-files") return ok("new.ts\0");
					throw new Error(`unexpected git args: ${args.join(" ")}`);
				},
				generateGitAssistantText: async (_runtime, kind, diff) => {
					assert.equal(kind, "review");
					assistantInput = diff;
					return "No significant findings.";
				},
			});

			await actions.runCodeReviewCommand();

			assert.match(assistantInput, /# Staged changes/u);
			assert.match(assistantInput, /# Working tree changes/u);
			assert.match(assistantInput, /# Untracked files/u);
			assert.match(assistantInput, /\+export const added = true;/u);
			assert.ok(entries.some((entry) => entry.includes("Code review\n\nNo significant findings.")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("loadGitAssistantModelRefs", () => {
	it("inherits global fallbacks unless the project explicitly replaces them", () => {
		const root = mkdtempSync(join(tmpdir(), "pix-git-config-"));
		const home = join(root, "home");
		const cwd = join(root, "repo");
		try {
			mkdirSync(join(home, ".config", "pi"), { recursive: true });
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(home, ".config", "pi", "pix.jsonc"), `{
  "desktop": { "git": {
    "reviewModelRef": "provider/global:medium",
    "reviewFallbackModels": ["provider/fallback:low"]
  } }
}`);
			writeFileSync(join(cwd, ".pi", "pix.jsonc"), `{
  "desktop": { "git": { "reviewModelRef": "provider/project:high" } }
}`);

			assert.deepEqual(loadGitAssistantModelRefs(cwd, "review", home), [
				"provider/project:high",
				"provider/fallback:low",
			]);

			writeFileSync(join(cwd, ".pi", "pix.jsonc"), `{
  "desktop": { "git": {
    "reviewModelRef": "provider/project:high",
    "reviewFallbackModels": []
  } }
}`);
			assert.deepEqual(loadGitAssistantModelRefs(cwd, "review", home), ["provider/project:high"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function fakeRuntime(cwd: string): AgentSessionRuntime {
	return ({
		cwd,
		session: { isStreaming: false },
		services: { modelRuntime: {} },
	} as unknown) as AgentSessionRuntime;
}

function fakeHost(
	runtime: AgentSessionRuntime,
	entries: string[],
	showMenu: () => Promise<"commit" | "cancel" | undefined> = async () => undefined,
): CommandControllerHost {
	return ({
		options: {},
		runtime: () => runtime,
		isRunning: () => true,
		addEntry: (entry: { text: string }) => entries.push(entry.text),
		setStatus: () => undefined,
		render: () => undefined,
		setSessionStatus: () => undefined,
		showMenu,
		toast: {
			success: () => undefined,
			info: () => undefined,
			warning: () => undefined,
			error: () => undefined,
		},
	} as unknown) as CommandControllerHost;
}

function ok(stdout = "", stderr = ""): AsyncProcessResult {
	return { status: 0, signal: null, stdout, stderr };
}
