import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

import {
	bundledQuestionExtensionPath,
	bundledSessionTitleExtensionPath,
	bundledTerminalBellExtensionPath,
	ensureBundledSkillsInstalled,
	ensurePiToolsSuiteExtensionInstalled,
	getBundledExtensionPaths,
	prioritizeBundledQuestionExtension,
	refreshPixModelRuntimeForStartup,
} from "../src/app/runtime.js";

const questionExtensionPath = bundledQuestionExtensionPath();

describe("runtime installation helpers", () => {
	it("installs and reuses the bundled pi-tools-suite symlink deterministically", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-runtime-tools-"));
		const sourcePath = join(root, "source");
		const targetPath = join(root, "target", "pi-tools-suite");
		try {
			await mkdir(sourcePath, { recursive: true });
			await writeFile(join(sourcePath, "index.ts"), "export {}\n", "utf8");

			const installed = await ensurePiToolsSuiteExtensionInstalled({ sourcePath, targetPath });
			assert.equal(installed.action, "installed");
			assert.equal(await lstat(targetPath).then((stat) => stat.isSymbolicLink()), true);

			const repeated = await ensurePiToolsSuiteExtensionInstalled({ sourcePath, targetPath });
			assert.equal(repeated.action, "already-installed");

			const keptTargetPath = join(root, "kept", "pi-tools-suite");
			await mkdir(join(root, "kept"), { recursive: true });
			await writeFile(keptTargetPath, "existing", "utf8");
			const kept = await ensurePiToolsSuiteExtensionInstalled({ sourcePath, targetPath: keptTargetPath });
			assert.equal(kept.action, "existing-kept");

			const missing = await ensurePiToolsSuiteExtensionInstalled({ sourcePath: join(root, "missing"), targetPath: join(root, "missing-target") });
			assert.equal(missing.action, "missing-source");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("copies bundled skills and recognizes same-entry installs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-runtime-skills-"));
		const sourcePath = join(root, "skills-source");
		const targetPath = join(root, "agents", "skills");
		try {
			await mkdir(join(sourcePath, "demo", "sub"), { recursive: true });
			await writeFile(join(sourcePath, "demo", "SKILL.md"), "demo\n", "utf8");
			await writeFile(join(sourcePath, "demo", "sub", "nested.txt"), "nested", "utf8");

			const installed = await ensureBundledSkillsInstalled({ sourcePath, targetPath });
			assert.equal(installed.action, "installed");
			assert.equal(await readFile(join(targetPath, "demo", "SKILL.md"), "utf8"), "demo\n");
			assert.equal(await readFile(join(targetPath, "demo", "sub", "nested.txt"), "utf8"), "nested");

			const repeated = await ensureBundledSkillsInstalled({ sourcePath, targetPath: sourcePath });
			assert.equal(repeated.action, "already-installed");

			const missing = await ensureBundledSkillsInstalled({ sourcePath: join(root, "missing"), targetPath: join(root, "missing-target") });
			assert.equal(missing.action, "missing-source");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves existing user skills while installing missing bundled skills", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-runtime-skill-conflict-"));
		const sourcePath = join(root, "skills-source");
		const targetPath = join(root, "agents", "skills");
		try {
			await mkdir(join(sourcePath, "existing"), { recursive: true });
			await mkdir(join(sourcePath, "new-skill"), { recursive: true });
			await mkdir(join(targetPath, "existing"), { recursive: true });
			await writeFile(join(sourcePath, "existing", "SKILL.md"), "bundled\n", "utf8");
			await writeFile(join(sourcePath, "new-skill", "SKILL.md"), "new\n", "utf8");
			await writeFile(join(targetPath, "existing", "SKILL.md"), "user\n", "utf8");

			const result = await ensureBundledSkillsInstalled({ sourcePath, targetPath });

			assert.equal(result.action, "installed");
			assert.deepEqual(result.installedSkills, ["new-skill"]);
			assert.deepEqual(result.preservedSkills, ["existing"]);
			assert.equal(await readFile(join(targetPath, "existing", "SKILL.md"), "utf8"), "user\n");
			assert.equal(await readFile(join(targetPath, "new-skill", "SKILL.md"), "utf8"), "new\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lists bundled extension payloads and keeps the question extension first", () => {
		const bundled = getBundledExtensionPaths();
		assert.ok(bundled.includes(questionExtensionPath));
		assert.ok(bundled.includes(bundledSessionTitleExtensionPath()));
		assert.ok(bundled.includes(bundledTerminalBellExtensionPath()));

		const base = extensionResult([
			extensionAt(join(questionExtensionPath, "index.ts"), { tools: ["question"] }),
			extensionAt("/workspace/other-extension/index.ts", { tools: ["other"] }),
		], [
			{ path: join(questionExtensionPath, "index.ts"), error: `Tool "question" conflicts with ${join(questionExtensionPath, "index.ts")}` },
		]);
		const prioritized = prioritizeBundledQuestionExtension(base, questionExtensionPath);

		assert.deepEqual(prioritized.extensions.map((extension) => extension.path), [join(questionExtensionPath, "index.ts"), "/workspace/other-extension/index.ts"]);
		assert.deepEqual(prioritized.errors, []);
	});

	it("refreshes the startup model catalog without network access", async () => {
		const refreshCalls: unknown[] = [];
		const glm53 = {
			id: "glm-5.3",
			reasoning: true,
			compat: { thinkingFormat: "zai", supportsReasoningEffort: false },
		};

		await refreshPixModelRuntimeForStartup({
			refresh: async (options) => {
				refreshCalls.push(options);
				return {} as never;
			},
			getModels: () => [glm53] as never,
		});

		assert.deepEqual(refreshCalls, [{ allowNetwork: false }]);
		assert.deepEqual((glm53 as any).thinkingLevelMap, {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		assert.equal(glm53.compat.supportsReasoningEffort, true);
	});
});

function extensionResult(
	extensions: LoadExtensionsResult["extensions"],
	errors: LoadExtensionsResult["errors"] = [],
): LoadExtensionsResult {
	return {
		extensions,
		errors,
		runtime: {} as LoadExtensionsResult["runtime"],
	};
}

function extensionAt(path: string, overrides: { tools?: string[] } = {}): LoadExtensionsResult["extensions"][number] {
	const { tools = [] } = overrides;
	return {
		path,
		resolvedPath: path,
		sourceInfo: {
			path,
			source: path,
			scope: "user",
			origin: "top-level",
		},
		handlers: new Map(),
		tools: new Map(tools.map((tool) => [tool, {} as never])),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}
