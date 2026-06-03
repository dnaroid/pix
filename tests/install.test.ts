import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { formatPixInstallNextSteps, parsePixInstallArgs, pixInstallUsage, runPixInstallCli, setPixInstallTestDeps } from "../src/app/cli/install.js";

describe("pix install", () => {
	it("parses install CLI options", () => {
		assert.deepEqual(parsePixInstallArgs(["--check"]), { checkOnly: true, help: false });
		assert.deepEqual(parsePixInstallArgs(["-h"]), { checkOnly: false, help: true });
		assert.throws(() => parsePixInstallArgs(["--bad"]), /Unknown pix install argument/u);
		assert.match(pixInstallUsage(), /pi CLI availability/u);
	});

	it("prints post-install configuration guidance", () => {
		const output = formatPixInstallNextSteps("/tmp/pix-home");
		assert.match(output, /[\\/]tmp[\\/]pix-home[\\/]\.config[\\/]pi[\\/]pix\.jsonc/u);
		assert.match(output, /dictation\.language/u);
		assert.match(output, /\.config[\\/]pi[\\/]pi-tools-suite\.jsonc/u);
		assert.match(output, /lsp\.servers/u);
		assert.match(output, /\/opencode-import/u);
		assert.match(output, /\/antigravity-import/u);
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
