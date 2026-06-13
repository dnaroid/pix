import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	checkPixUpdate,
	checkPiUpdate,
	formatPiStartupUpdateToast,
	formatPixUpdateCheck,
	formatPixStartupUpdateDialog,
	getPixSelfUpdateCommand,
	parsePixUpdateArgs,
	runPixUpdateCli,
	setPixUpdateTestDeps,
} from "../src/app/cli/update.js";

describe("pix update", () => {
	it("parses update CLI options", () => {
		assert.deepEqual(parsePixUpdateArgs(["--check", "--force"]), {
			checkOnly: true,
			force: true,
			help: false,
		});
		assert.deepEqual(parsePixUpdateArgs(["-h"]), {
			checkOnly: false,
			force: false,
			help: true,
		});
		assert.throws(() => parsePixUpdateArgs(["--bad"]), /Unknown pix update argument/u);
	});

	it("reports current, skipped, and unknown update states deterministically", async () => {
		await withPackageJson({ name: "pi-ui-extend", version: "0.1.0" }, async (packageRoot) => {
			const current = await checkPixUpdate({
				packageRoot,
				fetchLatestVersion: async () => "0.1.0",
			});
			assert.equal(current.status, "current");
			assert.equal(current.latestVersion, "0.1.0");
			assert.match(formatPixUpdateCheck(current), /status: up to date/u);

			const unknown = await checkPixUpdate({
				packageRoot,
				fetchLatestVersion: async () => { throw new Error("registry down"); },
			});
			assert.equal(unknown.status, "unknown");
			assert.match(formatPixUpdateCheck(unknown), /unable to check \(registry down\)/u);
		});

		await withEnv({ PIX_SKIP_VERSION_CHECK: "1" }, async () => {
			await withPackageJson({ name: "pi-ui-extend", version: "0.1.0" }, async (packageRoot) => {
				const skipped = await checkPixUpdate({
					packageRoot,
					fetchLatestVersion: async () => "0.2.0",
				});

				assert.equal(skipped.status, "skipped");
				assert.match(formatPixUpdateCheck(skipped), /check skipped \(PIX_SKIP_VERSION_CHECK is set\)/u);
			});
		});
	});

	it("formats startup update dialog instructions", () => {
		const message = formatPixStartupUpdateDialog({
			status: "newer",
			packageName: "pi-ui-extend",
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			packageRoot: "/tmp/pi-ui-extend",
		});

		assert.match(message, /A new Pix version is available/u);
		assert.match(message, /latest: 0\.2\.0/u);
		assert.match(message, /pinned Pi SDK\/dependencies/u);
		assert.match(message, /global `pi` CLI is not enough/u);
		assert.match(message, /Exit Pix/u);
		assert.match(message, /pix update/u);
		assert.match(message, /Start Pix again/u);
	});

	it("checks bundled Pi package updates and formats startup toast", async () => {
		await withPackageJson({ name: "@earendil-works/pi-coding-agent", version: "0.79.3" }, async (packageRoot) => {
			const result = await checkPiUpdate({
				packageRoot,
				fetchLatestVersion: async () => "0.79.4",
			});

			assert.equal(result.status, "newer");
			assert.equal(result.packageName, "@earendil-works/pi-coding-agent");
			assert.equal(result.currentVersion, "0.79.3");
			assert.equal(result.latestVersion, "0.79.4");
			assert.match(formatPiStartupUpdateToast(result), /Pi 0\.79\.4 is available/u);
			assert.match(formatPiStartupUpdateToast(result), /Pix bundles Pi 0\.79\.3/u);
			assert.match(formatPiStartupUpdateToast(result), /matching Pix update/u);
		});
	});

	it("does not offer npm updates for private source packages", async () => {
		await withPackageJson({ name: "pi-ui-extend", version: "0.1.0", private: true }, async (packageRoot) => {
			const result = await checkPixUpdate({
				packageRoot,
				fetchLatestVersion: async () => "0.2.0",
			});

			assert.equal(result.status, "unavailable");
			assert.match(formatPixUpdateCheck(result), /source checkout/u);
		});
	});

	it("builds package-manager self-update commands for managed installs", () => {
		assert.equal(getPixSelfUpdateCommand("pi-ui-extend", "0.2.0", "/tmp/prefix/lib/node_modules/pi-ui-extend")?.command, "npm");
		assert.equal(getPixSelfUpdateCommand("pi-ui-extend", "0.2.0", "/tmp/prefix/lib/node_modules/.pnpm/pi-ui-extend")?.command, "pnpm");
		assert.equal(getPixSelfUpdateCommand("pi-ui-extend", "0.2.0", "/tmp/prefix/lib/node_modules/.yarn/pi-ui-extend")?.command, "yarn");
		assert.equal(getPixSelfUpdateCommand("pi-ui-extend", "0.2.0", "/tmp/prefix/lib/node_modules/.bun/pi-ui-extend")?.command, "bun");
		assert.equal(getPixSelfUpdateCommand("pi-ui-extend", "0.2.0", "/tmp/pi-ui-extend"), undefined);
	});

	it("does not self-update source checkouts", () => {
		assert.equal(getPixSelfUpdateCommand("pi-ui-extend", "0.2.0", "/tmp/pi-ui-extend"), undefined);
	});

	it("runs check-only, help, and unavailable CLI paths without spawning updates", async () => {
		const restoreConsole = captureConsole();
		let runCalls = 0;
		try {
			setPixUpdateTestDeps({
				checkPixUpdate: async () => ({
					status: "unavailable",
					packageName: "pi-ui-extend",
					currentVersion: "0.1.0",
					packageRoot: "/tmp/source/pi-ui-extend",
					reason: "source checkout",
				}),
				runCommand: async () => { runCalls += 1; },
			});

			assert.equal(await runPixUpdateCli(["--help"]), 0);
			assert.equal(await runPixUpdateCli(["--bad"]), 1);
			assert.equal(await runPixUpdateCli(["--check"]), 1);
			assert.equal(await runPixUpdateCli([]), 1);
			assert.equal(runCalls, 0);
			const { stdout, stderr } = restoreConsole.output();
			assert.match(stdout, /Usage: pix update/u);
			assert.match(stdout, /update unavailable/u);
			assert.match(stderr, /Unknown pix update argument/u);
		} finally {
			setPixUpdateTestDeps();
			restoreConsole.restore();
		}
	});

	it("runs forced self-update through a mocked package-manager command", async () => {
		const restoreConsole = captureConsole();
		const commands: string[] = [];
		try {
			setPixUpdateTestDeps({
				checkPixUpdate: async () => ({
					status: "current",
					packageName: "pi-ui-extend",
					currentVersion: "0.1.0",
					latestVersion: "0.1.0",
					packageRoot: "/tmp/prefix/lib/node_modules/pi-ui-extend",
				}),
				runCommand: async (command) => { commands.push(command.display); },
			});

			assert.equal(await runPixUpdateCli([]), 0);
			assert.deepEqual(commands, []);
			assert.equal(await runPixUpdateCli(["--force"]), 0);
			assert.equal(commands.length, 1);
			assert.match(commands[0] ?? "", /npm install -g/u);
			assert.match(restoreConsole.output().stdout, /Updated Pix/u);
		} finally {
			setPixUpdateTestDeps();
			restoreConsole.restore();
		}
	});

	it("reports mocked self-update command failures", async () => {
		const restoreConsole = captureConsole();
		try {
			setPixUpdateTestDeps({
				checkPixUpdate: async () => ({
					status: "newer",
					packageName: "pi-ui-extend",
					currentVersion: "0.1.0",
					latestVersion: "0.2.0",
					packageRoot: "/tmp/prefix/lib/node_modules/pi-ui-extend",
				}),
				runCommand: async () => { throw new Error("install failed"); },
			});

			assert.equal(await runPixUpdateCli([]), 1);
			assert.match(restoreConsole.output().stderr, /Pix update failed: install failed/u);
		} finally {
			setPixUpdateTestDeps();
			restoreConsole.restore();
		}
	});
});

async function withPackageJson(packageJson: Record<string, unknown>, callback: (packageRoot: string) => Promise<void>): Promise<void> {
	const packageRoot = await mkdtemp(join(tmpdir(), "pix-update-"));
	try {
		await writeFile(join(packageRoot, "package.json"), JSON.stringify(packageJson), "utf8");
		await callback(packageRoot);
	} finally {
		await rm(packageRoot, { recursive: true, force: true });
	}
}

async function withEnv(env: Record<string, string | undefined>, callback: () => Promise<void>): Promise<void> {
	const previous = new Map(Object.entries(env).map(([key]) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await callback();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function captureConsole(): { output(): { stdout: string; stderr: string }; restore(): void } {
	const originalLog = console.log;
	const originalError = console.error;
	const stdout: string[] = [];
	const stderr: string[] = [];
	console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); };
	console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
	return {
		output: () => ({ stdout: stdout.join("\n"), stderr: stderr.join("\n") }),
		restore: () => {
			console.log = originalLog;
			console.error = originalError;
		},
	};
}
