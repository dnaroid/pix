import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";

import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

import {
	checkAndUpdateIdxOnStartup,
	checkPiCliAvailability,
	checkPiToolsSuiteExtensionAvailability,
	checkSelectedModelAuthAvailability,
	formatIdxStartupUpdateNotice,
} from "../src/app/cli/startup-checks.js";

describe("startup availability checks", () => {
	it("reports a missing pi CLI", async () => {
		const issues = await checkPiCliAvailability("");

		assert.deepEqual(issues, [{
			kind: "error",
			message: "pi CLI is not available on PATH. Run `pix install` or add pi to PATH before starting pix.",
		}]);
	});

	it("accepts a pi executable on PATH", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-pi-cli-"));
		try {
			const binDir = join(root, "bin");
			const piPath = join(binDir, "pi");
			await mkdir(binDir, { recursive: true });
			await writeFile(piPath, "#!/bin/sh\nexit 0\n");
			await chmod(piPath, 0o755);

			assert.deepEqual(await checkPiCliAvailability([binDir, "/missing"].join(delimiter)), []);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("silently accepts an up-to-date idx version", async () => {
		const result = await checkAndUpdateIdxOnStartup({
			runUpdate: async () => ({
				code: 0,
				signal: null,
				stdout: "indexer-cli is already up to date (0.12.33).\n",
				stderr: "",
			}),
		});

		assert.deepEqual(result, { status: "current", currentVersion: "0.12.33" });
		assert.equal(formatIdxStartupUpdateNotice(result), undefined);
	});

	it("runs the official idx update command", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-idx-update-"));
		try {
			const binDir = join(root, "bin");
			const idxPath = join(binDir, process.platform === "win32" ? "idx.cmd" : "idx");
			await mkdir(binDir, { recursive: true });
			if (process.platform === "win32") {
				await writeFile(idxPath, "@echo off\r\nif \"%1\"==\"update\" echo indexer-cli is already up to date (0.12.33).\r\n");
			} else {
				await writeFile(idxPath, "#!/bin/sh\n[ \"$1\" = update ] && echo 'indexer-cli is already up to date (0.12.33).'\n");
				await chmod(idxPath, 0o755);
			}

			const result = await checkAndUpdateIdxOnStartup({
				env: { ...process.env, PATH: binDir },
				timeoutMs: 5_000,
			});

			assert.deepEqual(result, { status: "current", currentVersion: "0.12.33" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports an idx update with its previous and current versions", async () => {
		const result = await checkAndUpdateIdxOnStartup({
			runUpdate: async () => ({
				code: 0,
				signal: null,
				stdout: "Updating indexer-cli 0.12.32 → 0.12.33...\nUpdated indexer-cli 0.12.32 → 0.12.33.\n",
				stderr: "",
			}),
		});

		assert.deepEqual(result, {
			status: "updated",
			previousVersion: "0.12.32",
			currentVersion: "0.12.33",
		});
		assert.equal(formatIdxStartupUpdateNotice(result), "idx updated from 0.12.32 to 0.12.33.");
	});

	it("skips the idx update while Pix is offline", async () => {
		let called = false;
		const result = await checkAndUpdateIdxOnStartup({
			env: { PI_OFFLINE: "1" },
			runUpdate: async () => {
				called = true;
				throw new Error("must not run");
			},
		});

		assert.deepEqual(result, { status: "skipped", reason: "PI_OFFLINE is set" });
		assert.equal(called, false);
	});

	it("silently skips the startup update when idx is not installed", async () => {
		const result = await checkAndUpdateIdxOnStartup({
			env: { PATH: "" },
		});

		assert.deepEqual(result, { status: "unavailable" });
		assert.equal(formatIdxStartupUpdateNotice(result), undefined);
	});

	it("reports a failed idx update with bounded diagnostic context", async () => {
		const result = await checkAndUpdateIdxOnStartup({
			runUpdate: async () => ({
				code: 1,
				signal: null,
				stdout: "",
				stderr: "registry unavailable",
			}),
		});

		assert.deepEqual(result, {
			status: "failed",
			reason: "idx update exited with code 1: registry unavailable",
		});
	});

	it("accepts a loaded pi-tools-suite extension", () => {
		const result = extensionResult({
			extensions: [extensionAt("/Users/test/.pi/agent/extensions/pi-tools-suite/index.ts")],
		});

		assert.deepEqual(checkPiToolsSuiteExtensionAvailability(result), []);
	});

	it("reports pi-tools-suite load failures", () => {
		const issues = checkPiToolsSuiteExtensionAvailability(extensionResult({
			errors: [{ path: "/Users/test/.pi/agent/extensions/pi-tools-suite/index.ts", error: "boom" }],
		}));

	assert.deepEqual(issues, [{
		kind: "error",
		message: "Pix bundled pi-tools-suite failed to load: boom. Check write access to ~/.pi/agent/extensions and the bundled external/pi-tools-suite payload.",
	}]);
});

	it("reports a missing pi-tools-suite extension", () => {
		const issues = checkPiToolsSuiteExtensionAvailability(extensionResult());

	assert.deepEqual(issues, [{
		kind: "error",
		message: "Pix bundled pi-tools-suite is not loaded from ~/.pi/agent/extensions/pi-tools-suite. Check write access to ~/.pi/agent/extensions and the bundled external/pi-tools-suite payload.",
	}]);
});
	it("accepts a pi-tools-suite extension when the path only appears in source metadata", () => {
		const result = extensionResult({
			extensions: [extensionAt("/workspace/custom-extension/index.ts", {
				path: "/workspace/custom-extension/index.ts",
				resolvedPath: "/workspace/custom-extension/index.ts",
				sourceInfo: {
					path: "/workspace/custom-extension/index.ts",
					source: "git:https://github.com/acme/pi-tools-suite.git",
					scope: "user",
					origin: "top-level",
				},
			})],
		});

		assert.deepEqual(checkPiToolsSuiteExtensionAvailability(result), []);
	});

	it("guides first-run users when no model or provider credentials are configured", () => {
		const withoutModel = {
			session: { model: undefined },
			services: { modelRuntime: { getProviderAuthStatus: () => ({ configured: false }) } },
		} as never;
		assert.match(checkSelectedModelAuthAvailability(withoutModel)[0]?.message ?? "", /No model is selected/u);

		const withoutAuth = {
			session: { model: { provider: "openai-codex", id: "gpt-test" } },
			services: { modelRuntime: { getProviderAuthStatus: () => ({ configured: false }) } },
		} as never;
		assert.match(checkSelectedModelAuthAvailability(withoutAuth)[0]?.message ?? "", /\/opencode-import/u);

		const configured = {
			session: { model: { provider: "zai", id: "glm-test" } },
			services: { modelRuntime: { getProviderAuthStatus: () => ({ configured: true, source: "stored" }) } },
		} as never;
		assert.deepEqual(checkSelectedModelAuthAvailability(configured), []);
	});

});

function extensionResult(overrides: Partial<Pick<LoadExtensionsResult, "extensions" | "errors">> = {}): LoadExtensionsResult {
	return {
		extensions: overrides.extensions ?? [],
		errors: overrides.errors ?? [],
		runtime: {} as LoadExtensionsResult["runtime"],
	};
}

function extensionAt(path: string, overrides: Partial<LoadExtensionsResult["extensions"][number]> = {}): LoadExtensionsResult["extensions"][number] {
	return {
		path,
		resolvedPath: path,
		sourceInfo: {
			path,
			source: path,
			scope: "user",
			origin: "top-level",
			...overrides.sourceInfo,
		},
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		...overrides,
	};
}
