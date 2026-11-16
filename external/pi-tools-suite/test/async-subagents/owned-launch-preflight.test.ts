import { afterEach, describe, expect, test } from "bun:test";

const originalPlatform = process.platform;
const originalPath = process.env.PATH;

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	process.env.PATH = originalPath;
});

describe.serial("owned-launch preflight", () => {
	for (const platform of ["linux", "win32"] as const) {
		test.serial(`prepares no macOS binaries on ${platform}`, async () => {
			const { resolveOwnedLaunchOptions } = await import("../../src/async-subagents/tools/spawn.js");
			Object.defineProperty(process, "platform", { value: platform, configurable: true });
			// Regression: a non-Claude task with a Claude fallback reached the
			// xcrun-based build here and failed the whole spawn off macOS.
			process.env.PATH = "";
			await expect(resolveOwnedLaunchOptions([process.cwd()])).resolves.toEqual({});
		});
	}
});
