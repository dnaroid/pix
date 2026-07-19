import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	checkPixUpdate,
	checkPiUpdate,
	checkGlobalPiInstall,
	formatGlobalPiCheck,
	formatPiStartupUpdateToast,
	formatPixUpdateCheck,
	formatPixStartupUpdateDialog,
	getPixSelfUpdateCommand,
	getGlobalPiUpdateCommand,
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
		assert.match(message, /synchronizes the global `pi` CLI/u);
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

	it("resolves the bundled Pi package via the default runtime path", async () => {
		// Regression: the default path used CJS require.resolve on a subpath the
		// Pi package does not export, so the startup Pi update toast never showed.
		const result = await checkPiUpdate({
			fetchLatestVersion: async () => "0.0.0",
		});

		assert.equal(result.packageName, "@earendil-works/pi-coding-agent");
		assert.equal(result.status, "current");
		assert.match(result.packageRoot, /[/\\]@earendil-works[/\\]pi-coding-agent$/u);
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

	it("checks the global Pi package against Pix's exact pinned version", async () => {
		await withManagedInstall("0.80.10", "0.80.9", async (packageRoot) => {
			const mismatched = checkGlobalPiInstall(packageRoot);
			assert.equal(mismatched.status, "mismatched");
			assert.equal(mismatched.currentVersion, "0.80.9");
			assert.equal(mismatched.targetVersion, "0.80.10");
			assert.match(formatGlobalPiCheck(mismatched), /version mismatch/u);

			await writeGlobalPiPackage(packageRoot, "0.80.10");
			assert.equal(checkGlobalPiInstall(packageRoot).status, "current");
		});

		await withManagedInstall("0.80.10", undefined, async (packageRoot) => {
			assert.equal(checkGlobalPiInstall(packageRoot).status, "missing");
		});
	});

	it("builds a global Pi install command pinned to Pix's package manager", () => {
		const command = getGlobalPiUpdateCommand("0.80.10", "/tmp/prefix/lib/node_modules/pi-ui-extend");
		assert.equal(command?.command, "npm");
		assert.match(command?.display ?? "", /@earendil-works\/pi-coding-agent@0\.80\.10/u);
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
		await withManagedInstall("0.80.10", "0.80.10", async (packageRoot) => {
			const restoreConsole = captureConsole();
			const commands: string[] = [];
			try {
				setPixUpdateTestDeps({
					checkPixUpdate: async () => ({
						status: "current",
						packageName: "pi-ui-extend",
						currentVersion: "0.1.0",
						latestVersion: "0.1.0",
						packageRoot,
					}),
					runCommand: async (command) => { commands.push(command.display); },
				});

				assert.equal(await runPixUpdateCli([]), 0);
				assert.deepEqual(commands, []);
				assert.equal(await runPixUpdateCli(["--force"]), 0);
				assert.equal(commands.length, 2);
				assert.match(commands[0] ?? "", /pi-ui-extend@0\.1\.0/u);
				assert.match(commands[1] ?? "", /pi-coding-agent@0\.80\.10/u);
				assert.match(restoreConsole.output().stdout, /Updated Pix and global Pi/u);
			} finally {
				setPixUpdateTestDeps();
				restoreConsole.restore();
			}
		});
	});

	it("synchronizes Pi even when Pix itself is already current", async () => {
		await withManagedInstall("0.80.10", "0.80.9", async (packageRoot) => {
			const restoreConsole = captureConsole();
			const commands: string[] = [];
			try {
				setPixUpdateTestDeps({
					checkPixUpdate: async () => ({
						status: "current",
						packageName: "pi-ui-extend",
						currentVersion: "0.1.0",
						latestVersion: "0.1.0",
						packageRoot,
					}),
					runCommand: async (command) => { commands.push(command.display); },
				});

				assert.equal(await runPixUpdateCli([]), 0);
				assert.equal(commands.length, 1);
				assert.match(commands[0] ?? "", /pi-coding-agent@0\.80\.10/u);
			} finally {
				setPixUpdateTestDeps();
				restoreConsole.restore();
			}
		});
	});

	it("reports a global Pi mismatch in check-only mode without installing", async () => {
		await withManagedInstall("0.80.10", "0.80.9", async (packageRoot) => {
			const restoreConsole = captureConsole();
			let runCalls = 0;
			try {
				setPixUpdateTestDeps({
					checkPixUpdate: async () => ({
						status: "current",
						packageName: "pi-ui-extend",
						currentVersion: "0.1.0",
						latestVersion: "0.1.0",
						packageRoot,
					}),
					runCommand: async () => { runCalls += 1; },
				});

				assert.equal(await runPixUpdateCli(["--check"]), 0);
				assert.equal(runCalls, 0);
				assert.match(restoreConsole.output().stdout, /Global Pi compatibility[\s\S]*version mismatch/u);
			} finally {
				setPixUpdateTestDeps();
				restoreConsole.restore();
			}
		});
	});

	it("refreshes the Pi target after updating Pix", async () => {
		await withManagedInstall("0.80.10", "0.80.10", async (packageRoot) => {
			const restoreConsole = captureConsole();
			const commands: string[] = [];
			try {
				setPixUpdateTestDeps({
					checkPixUpdate: async () => ({
						status: "newer",
						packageName: "pi-ui-extend",
						currentVersion: "0.1.0",
						latestVersion: "0.2.0",
						packageRoot,
					}),
					runCommand: async (command) => {
						commands.push(command.display);
						if (commands.length === 1) await writePixPackage(packageRoot, "0.2.0", "0.80.11");
					},
				});

				assert.equal(await runPixUpdateCli([]), 0);
				assert.equal(commands.length, 2);
				assert.match(commands[0] ?? "", /pi-ui-extend@0\.2\.0/u);
				assert.match(commands[1] ?? "", /pi-coding-agent@0\.80\.11/u);
			} finally {
				setPixUpdateTestDeps();
				restoreConsole.restore();
			}
		});
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

	it("reports a recoverable partial failure when the global Pi install fails", async () => {
		await withManagedInstall("0.80.10", "0.80.9", async (packageRoot) => {
			const restoreConsole = captureConsole();
			try {
				setPixUpdateTestDeps({
					checkPixUpdate: async () => ({
						status: "current",
						packageName: "pi-ui-extend",
						currentVersion: "0.1.0",
						latestVersion: "0.1.0",
						packageRoot,
					}),
					runCommand: async () => { throw new Error("pi install failed"); },
				});

				assert.equal(await runPixUpdateCli([]), 1);
				const stderr = restoreConsole.output().stderr;
				assert.match(stderr, /Global Pi update failed: pi install failed/u);
				assert.match(stderr, /Try running manually:.*pi-coding-agent@0\.80\.10/u);
			} finally {
				setPixUpdateTestDeps();
				restoreConsole.restore();
			}
		});
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

async function withManagedInstall(piTargetVersion: string, globalPiVersion: string | undefined, callback: (packageRoot: string) => Promise<void>): Promise<void> {
	const prefixRoot = await mkdtemp(join(tmpdir(), "pix-managed-update-"));
	const packageRoot = join(prefixRoot, "lib", "node_modules", "pi-ui-extend");
	try {
		await writePixPackage(packageRoot, "0.1.0", piTargetVersion);
		if (globalPiVersion) await writeGlobalPiPackage(packageRoot, globalPiVersion);
		await callback(packageRoot);
	} finally {
		await rm(prefixRoot, { recursive: true, force: true });
	}
}

async function writePixPackage(packageRoot: string, version: string, piTargetVersion: string): Promise<void> {
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({
		name: "pi-ui-extend",
		version,
		dependencies: { "@earendil-works/pi-coding-agent": piTargetVersion },
	}), "utf8");
}

async function writeGlobalPiPackage(pixPackageRoot: string, version: string): Promise<void> {
	const packageRoot = join(pixPackageRoot, "..", "@earendil-works", "pi-coding-agent");
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent",
		version,
	}), "utf8");
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
