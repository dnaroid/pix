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
			await mkdir(join(sourcePath, "sub"), { recursive: true });
			await writeFile(join(sourcePath, "index.ts"), "export const skill = 1;\n", "utf8");
			await writeFile(join(sourcePath, "sub", "nested.txt"), "nested", "utf8");

			const installed = await ensureBundledSkillsInstalled({ sourcePath, targetPath });
			assert.equal(installed.action, "installed");
			assert.equal(await readFile(join(targetPath, "index.ts"), "utf8"), "export const skill = 1;\n");
			assert.equal(await readFile(join(targetPath, "sub", "nested.txt"), "utf8"), "nested");

			const repeated = await ensureBundledSkillsInstalled({ sourcePath, targetPath: sourcePath });
			assert.equal(repeated.action, "already-installed");

			const missing = await ensureBundledSkillsInstalled({ sourcePath: join(root, "missing"), targetPath: join(root, "missing-target") });
			assert.equal(missing.action, "missing-source");
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
