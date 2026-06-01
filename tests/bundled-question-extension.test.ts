import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createAgentSessionServices, discoverAndLoadExtensions, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
	bundledQuestionExtensionPath,
	bundledSessionTitleExtensionPath,
	bundledTerminalBellExtensionPath,
	ensurePiToolsSuiteExtensionInstalled,
	getBundledExtensionPaths,
	prioritizeBundledQuestionExtension,
} from "../src/app/runtime.js";

describe("bundled extensions", () => {
	it("ships the renderer-owned extensions from the project extensions directory", async () => {
		const questionExtensionPath = bundledQuestionExtensionPath();
		const sessionTitleExtensionPath = bundledSessionTitleExtensionPath();
		const terminalBellExtensionPath = bundledTerminalBellExtensionPath();
		assert.deepEqual(getBundledExtensionPaths(), [
			questionExtensionPath,
			sessionTitleExtensionPath,
			terminalBellExtensionPath,
		]);

		const result = await loadBundledExtensions();
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 3);
		assert.ok(result.extensions.some((extension) => extension.tools.has("question")));
		assert.ok(result.extensions.some((extension) => extension.resolvedPath.startsWith(sessionTitleExtensionPath)));
		assert.ok(result.extensions.some((extension) => extension.resolvedPath.startsWith(terminalBellExtensionPath)));
	});

	it("keeps the bundled question tool ahead of other question registrations", async () => {
		const result = await loadBundledExtensions();
		const bundledExtension = result.extensions.find((extension) => extension.tools.has("question"))!;
		const externalExtension = {
			...bundledExtension,
			path: "/tmp/external-question/index.ts",
			resolvedPath: "/tmp/external-question/index.ts",
		};
		const remainingError = { path: "/tmp/other-extension/index.ts", error: "Failed to load extension" };

		const prioritized = prioritizeBundledQuestionExtension({
			...result,
			extensions: [externalExtension, bundledExtension],
			errors: [
				{ path: externalExtension.path, error: `Tool "question" conflicts with ${bundledExtension.path}` },
				remainingError,
			],
		} satisfies LoadExtensionsResult);

		assert.equal(prioritized.extensions[0], bundledExtension);
		assert.equal(prioritized.extensions[1], externalExtension);
		assert.deepEqual(prioritized.errors, [remainingError]);
	});

	it("registers renderer-owned extensions through Pi resource loading when pix starts", async () => {
		await withTempPiDirs(async (cwd, agentDir) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderOptions: {
					additionalExtensionPaths: getBundledExtensionPaths(),
					extensionsOverride: prioritizeBundledQuestionExtension,
				},
			});

			const extensions = services.resourceLoader.getExtensions();
			assert.deepEqual(extensions.errors, []);
			assert.ok(extensions.extensions.some((extension) => extension.tools.has("question")));
			assert.ok(extensions.extensions.some((extension) => extension.resolvedPath.startsWith(bundledSessionTitleExtensionPath())));
			assert.ok(extensions.extensions.some((extension) => extension.resolvedPath.startsWith(bundledTerminalBellExtensionPath())));
		});
	});

	it("installs pi-tools-suite into the user extensions directory as a package link", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-suite-install-"));
		try {
			const sourcePath = join(root, "source", "pi-tools-suite");
			const agentDir = join(root, "agent");
			const targetPath = join(agentDir, "extensions", "pi-tools-suite");
			await mkdir(sourcePath, { recursive: true });
			await writeFile(join(sourcePath, "index.ts"), "export default function () {}\n", "utf8");

			const installed = await ensurePiToolsSuiteExtensionInstalled({ agentDir, sourcePath });
			assert.equal(installed.action, "installed");
			assert.equal(await realpath(targetPath), await realpath(sourcePath));

			const targetStat = await lstat(targetPath);
			assert.equal(targetStat.isSymbolicLink(), process.platform !== "win32");

			const second = await ensurePiToolsSuiteExtensionInstalled({ agentDir, sourcePath });
			assert.equal(second.action, "already-installed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps an existing real pi-tools-suite extension directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-suite-install-"));
		try {
			const sourcePath = join(root, "source", "pi-tools-suite");
			const agentDir = join(root, "agent");
			const targetPath = join(agentDir, "extensions", "pi-tools-suite");
			await mkdir(sourcePath, { recursive: true });
			await writeFile(join(sourcePath, "index.ts"), "export default function () {}\n", "utf8");
			await mkdir(targetPath, { recursive: true });
			await writeFile(join(targetPath, "index.ts"), "export default function existing() {}\n", "utf8");

			const result = await ensurePiToolsSuiteExtensionInstalled({ agentDir, sourcePath });

			assert.equal(result.action, "existing-kept");
			assert.notEqual(await realpath(targetPath), await realpath(sourcePath));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

async function loadBundledExtensions(): Promise<LoadExtensionsResult> {
	return withTempPiDirs(async (cwd, agentDir) => discoverAndLoadExtensions(getBundledExtensionPaths(), cwd, agentDir));
}

async function withTempPiDirs<T>(callback: (cwd: string, agentDir: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pix-question-extension-"));
	try {
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		return await callback(cwd, agentDir);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
