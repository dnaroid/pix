import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";

import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

import {
	checkPiCliAvailability,
	checkPiToolsSuiteExtensionAvailability,
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
