import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { formatPixInstallNextSteps, inspectPixOnboarding, parsePixInstallArgs, pixInstallUsage, runPixInstallCli, setPixInstallTestDeps } from "../src/app/cli/install.js";

describe("pix install", () => {
	it("parses install CLI options", () => {
		assert.deepEqual(parsePixInstallArgs(["--check"]), { checkOnly: true, help: false });
		assert.deepEqual(parsePixInstallArgs(["-h"]), { checkOnly: false, help: true });
		assert.throws(() => parsePixInstallArgs(["--bad"]), /Unknown pix install argument/u);
		assert.match(pixInstallUsage(), /pi CLI availability/u);
	});

	it("prints post-install configuration guidance", () => {
		const output = formatPixInstallNextSteps("/tmp/pix-home", emptyOnboardingState());
		assert.match(output, /[\\/]tmp[\\/]pix-home[\\/]\.config[\\/]pi[\\/]pix\.jsonc/u);
		assert.match(output, /dictation\.language/u);
		assert.match(output, /\.config[\\/]pi[\\/]pi-tools-suite\.jsonc/u);
		assert.match(output, /lsp\.servers/u);
		assert.match(output, /Configure a model provider first/u);
		assert.match(output, /\/web-credentials/u);
		assert.doesNotMatch(output, /\/antigravity-import/u);
	});

	it("detects existing OpenCode credentials without exposing their values", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "pix-install-opencode-"));
		try {
			const authPath = join(homeDir, ".local", "share", "opencode", "auth.json");
			await mkdir(dirname(authPath), { recursive: true });
			await writeFile(authPath, JSON.stringify({ openai: { access: "do-not-print" } }), "utf8");

			const state = inspectPixOnboarding(homeDir, {});
			assert.equal(state.opencodeAuthExists, true);
			const output = formatPixInstallNextSteps(homeDir, state);
			assert.match(output, /OpenCode credentials detected/u);
			assert.match(output, /\/opencode-import/u);
			assert.doesNotMatch(output, /do-not-print/u);
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("creates config templates during install and preserves them on repeat", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "pix-install-config-"));
		const restoreConsole = captureConsole();
		try {
			setPixInstallTestDeps({
				isJetBrainsNerdFontInstalled: async () => true,
				clipboardSupportAvailable: async () => true,
				existsSync: (path) => String(path).includes("mock-bin") || existsSync(path),
			});
			const env = { PATH: "", PIX_BUNDLED_PI_BIN: join("/", "mock-bin") };
			assert.equal(await runPixInstallCli([], { env, homeDir }), 0);

			const pixConfigPath = join(homeDir, ".config", "pi", "pix.jsonc");
			const toolsConfigPath = join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");
			assert.match(await readFile(pixConfigPath, "utf8"), /pix renderer configuration/u);
			assert.match(await readFile(toolsConfigPath, "utf8"), /todoThinking/u);
			await writeFile(toolsConfigPath, "user config\n", "utf8");
			assert.equal(await runPixInstallCli([], { env, homeDir }), 0);
			assert.equal(await readFile(toolsConfigPath, "utf8"), "user config\n");
		} finally {
			setPixInstallTestDeps();
			restoreConsole.restore();
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("prints help without running setup checks", async () => {
		const exitCode = await runPixInstallCli(["--help"]);

		assert.equal(exitCode, 0);
	});

	it("accepts Pix's bundled pi bin during setup checks", async () => {
		const restoreConsole = captureConsole();
		try {
			setPixInstallTestDeps({
				existsSync: (path) => String(path).endsWith(process.platform === "win32" ? "pi.cmd" : "pi"),
				isJetBrainsNerdFontInstalled: async () => true,
				clipboardSupportAvailable: async () => true,
			});

			const exitCode = await runPixInstallCli(["--check"], {
				env: {
					PATH: "",
					PIX_BUNDLED_PI_BIN: "/mock/pix/bin",
				},
			});

			assert.equal(exitCode, 0);
			assert.match(restoreConsole.output().stdout, /pi CLI is available \(bundled with Pix\)/u);
		} finally {
			setPixInstallTestDeps();
			restoreConsole.restore();
		}
	});

	it("reports missing helpers in check-only mode without installing anything", async () => {
		const restoreConsole = captureConsole();
		let installFontCalls = 0;
		let spawnCalls = 0;
		try {
			setPixInstallTestDeps({
				existsSync: () => false,
				isJetBrainsNerdFontInstalled: async () => false,
				installJetBrainsNerdFont: async () => { installFontCalls += 1; return "/mock/font.ttf"; },
				clipboardSupportAvailable: async () => false,
				clipboardInstallHint: () => "install clipboard helper",
				spawn: (() => { spawnCalls += 1; throw new Error("spawn should not run in --check"); }) as never,
			});

			const exitCode = await runPixInstallCli(["--check"], { env: { PATH: "" }, homeDir: "/home/test" });

			assert.equal(exitCode, 1);
			assert.equal(installFontCalls, 0);
			assert.equal(spawnCalls, 0);
			const { stdout } = restoreConsole.output();
			assert.match(stdout, /JetBrainsMono Nerd Font Mono is missing/u);
			assert.match(stdout, /pi CLI is missing/u);
			assert.match(stdout, /Clipboard support is missing\. install clipboard helper/u);
		} finally {
			setPixInstallTestDeps();
			restoreConsole.restore();
		}
	});

	it("does not fail check-only mode for optional font and clipboard helpers", async () => {
		const restoreConsole = captureConsole();
		try {
			setPixInstallTestDeps({
				existsSync: (path) => String(path).endsWith(process.platform === "win32" ? "pi.cmd" : "pi"),
				isJetBrainsNerdFontInstalled: async () => false,
				clipboardSupportAvailable: async () => false,
				clipboardInstallHint: () => "optional clipboard helper",
			});
			const exitCode = await runPixInstallCli(["--check"], {
				env: { PATH: "", PIX_BUNDLED_PI_BIN: "/mock/pix/bin" },
				homeDir: "/home/test",
			});
			assert.equal(exitCode, 0);
		} finally {
			setPixInstallTestDeps();
			restoreConsole.restore();
		}
	});

	it("installs missing helpers through mocked installers and reports npm failures", async () => {
		const restoreConsole = captureConsole();
		let fontInstallCalls = 0;
		const spawned: Array<{ command: string; args: readonly string[] }> = [];
		try {
			setPixInstallTestDeps({
				existsSync: () => false,
				isJetBrainsNerdFontInstalled: async () => false,
				installJetBrainsNerdFont: async () => { fontInstallCalls += 1; return "/mock/font.ttf"; },
				clipboardSupportAvailable: async () => true,
				spawn: ((command: string, args: readonly string[]) => {
					spawned.push({ command, args });
					return closeWith(1, "npm denied");
				}) as never,
			});

			const exitCode = await runPixInstallCli([], { env: { PATH: "" }, homeDir: "/home/test" });

			assert.equal(exitCode, 1);
			assert.equal(fontInstallCalls, 1);
			assert.deepEqual(spawned[0]?.command, "npm");
			assert.ok(spawned[0]?.args.includes("@earendil-works/pi-coding-agent"));
			const { stdout, stderr } = restoreConsole.output();
			assert.match(stdout, /Installed JetBrainsMono Nerd Font Mono/u);
			assert.match(stdout, /Clipboard support is available/u);
			assert.match(stderr, /Failed to install pi CLI: npm denied/u);
		} finally {
			setPixInstallTestDeps();
			restoreConsole.restore();
		}
	});
});

function emptyOnboardingState() {
	return {
		pixConfigExists: false,
		toolsConfigExists: false,
		providerAuthConfigured: false,
		opencodeAuthExists: false,
		opencodeAntigravityExists: false,
		webCredentialsConfigured: false,
		context7Configured: false,
		telegramConfigured: false,
	};
}

function closeWith(code: number, stderr: string): EventEmitter & { stderr: EventEmitter } {
	const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
	child.stderr = new EventEmitter();
	queueMicrotask(() => {
		child.stderr.emit("data", Buffer.from(stderr));
		child.emit("close", code);
	});
	return child;
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
