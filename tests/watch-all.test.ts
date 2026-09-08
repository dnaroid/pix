import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	PARTS,
	classifyChange,
	createBuildPlan,
	desktopAppBundlePath,
	desktopArtifactDestination,
	desktopBundleDirectory,
	desktopBuildArguments,
	desktopLaunchExecutable,
	findProcessByExecutablePath,
	macOSCodeSignArguments,
	macOSOpenArguments,
	npmInvocation,
	parseProcessList,
	selectDesktopAppBundle,
	updateWatchedPathStamp,
	usesDesktopAppBundle,
} from "../scripts/watch-all.mjs";

function sortedParts(path: string): string[] {
	return [...classifyChange(path)].sort();
}

describe("watch:all change classification", () => {
	it("maps each source tree to its independently buildable part", () => {
		assert.deepEqual(sortedParts("src/main.ts"), [PARTS.PIX]);
		assert.deepEqual(sortedParts("acp/src/main.ts"), [PARTS.ACP]);
		assert.deepEqual(sortedParts("desktop/src/App.svelte"), [PARTS.WEB]);
		assert.deepEqual(sortedParts("desktop/src-tauri/src/lib.rs"), [PARTS.NATIVE]);
		assert.deepEqual(sortedParts("external/pi-tools-suite/src/index.ts"), [PARTS.SUITE]);
	});

	it("tracks build configuration but ignores generated and test output", () => {
		assert.deepEqual(sortedParts("scripts/generate-schemas.ts"), [PARTS.PIX]);
		assert.deepEqual(sortedParts("desktop/vite.config.ts"), [PARTS.WEB]);
		assert.deepEqual(sortedParts("desktop/src-tauri/Cargo.toml"), [PARTS.NATIVE]);
		assert.deepEqual(sortedParts("desktop/src-tauri/icons/icon.png"), [PARTS.NATIVE]);
		assert.deepEqual(sortedParts("desktop/src-tauri/tauri.macos.conf.json"), [PARTS.NATIVE]);
		assert.deepEqual(sortedParts("external/pi-tools-suite/dist/index.js"), []);
		assert.deepEqual(sortedParts("desktop/src-tauri/target/debug/pix-desktop"), []);
		assert.deepEqual(sortedParts("tests/watch-all.test.ts"), []);
	});

	it("normalizes Windows separators", () => {
		assert.deepEqual(sortedParts("desktop\\src\\App.svelte"), [PARTS.WEB]);
	});
});

describe("watch:all build planning", () => {
	it("embeds changed web assets in a fresh native build", () => {
		assert.deepEqual(createBuildPlan([PARTS.WEB]), {
			steps: [PARTS.WEB, PARTS.NATIVE],
			restartDesktop: true,
		});
	});

	it("syncs suite-only changes without restarting desktop", () => {
		assert.deepEqual(createBuildPlan([PARTS.SUITE]), {
			steps: [PARTS.SUITE],
			restartDesktop: false,
		});
	});

	it("bootstraps web and native output until a runnable desktop exists", () => {
		assert.deepEqual(createBuildPlan([PARTS.ACP], { hasNativeBuild: false }), {
			steps: [PARTS.ACP, PARTS.WEB, PARTS.NATIVE],
			restartDesktop: true,
		});
	});

	it("orders a complete initial build by dependency", () => {
		assert.deepEqual(createBuildPlan([], { initial: true, hasNativeBuild: false }), {
			steps: [PARTS.SUITE, PARTS.PIX, PARTS.ACP, PARTS.WEB, PARTS.NATIVE],
			restartDesktop: true,
		});
	});
});

describe("watch:all desktop artifact selection", () => {
	function inlineBuildConfig(args: string[]): unknown {
		return JSON.parse(args[args.indexOf("--config") + 1] as string);
	}

	it("bundles a debug .app on macOS without triggering an extra web build", () => {
		assert.equal(usesDesktopAppBundle("darwin"), true);
		const args = desktopBuildArguments("darwin");
		assert.equal(args[0], "--debug");
		assert.equal(args.includes("--no-bundle"), false);
		assert.equal(args.includes("--debug"), true);
		assert.deepEqual(args.slice(args.indexOf("--bundles"), args.indexOf("--bundles") + 2), ["--bundles", "app"]);
		assert.deepEqual(inlineBuildConfig(args), {
			build: { beforeBuildCommand: "" },
			bundle: { active: true },
		});
		assert.equal(desktopBundleDirectory("/targets"), join("/targets", "debug", "bundle", "macos"));
	});

	it("keeps the raw executable and no bundling on every other platform", () => {
		for (const platform of ["linux", "win32"] as const) {
			assert.equal(usesDesktopAppBundle(platform), false);
			const args = desktopBuildArguments(platform);
			assert.equal(args.includes("--no-bundle"), true);
			assert.equal(args.includes("--debug"), true);
			assert.deepEqual(inlineBuildConfig(args), { build: { beforeBuildCommand: "" } });
		}
	});

	it("resolves the bundle's inner executable on macOS and the copied binary elsewhere", () => {
		assert.equal(
			desktopLaunchExecutable("/tmp/run/pix-desktop-3.app", "darwin"),
			join("/tmp/run/pix-desktop-3.app", "Contents", "MacOS", "pix-desktop"),
		);
		assert.equal(desktopLaunchExecutable("/tmp/run/pix-desktop-3.exe", "win32"), "/tmp/run/pix-desktop-3.exe");
		assert.equal(desktopLaunchExecutable("/tmp/run/pix-desktop-3", "linux"), "/tmp/run/pix-desktop-3");
	});

	it("selects the newest validated macOS bundle, breaking ties deterministically", () => {
		assert.equal(
			selectDesktopAppBundle([
				{ name: "Pix Desktop.app", path: "/old/Pix Desktop.app", modifiedMs: 100 },
				{ name: "Pix Desktop.app", path: "/new/Pix Desktop.app", modifiedMs: 300 },
			])?.path,
			"/new/Pix Desktop.app",
		);
		assert.equal(
			selectDesktopAppBundle([
				{ name: "b.app", path: "/t/b.app", modifiedMs: 100 },
				{ name: "a.app", path: "/t/a.app", modifiedMs: 100 },
			])?.path,
			"/t/a.app",
		);
		assert.equal(selectDesktopAppBundle([]), undefined);
	});
});

describe("watch:all macOS launch identity", () => {
	it("copies each bundle under a unique parent while preserving the source bundle name", () => {
		assert.equal(
			desktopArtifactDestination("/tmp/run", 3, "/targets/macos/Pix Desktop.app", "darwin"),
			join("/tmp/run", "pix-desktop-3", "Pix Desktop.app"),
		);
		assert.equal(
			desktopArtifactDestination("/tmp/run", 4, "/t/pix-desktop", "linux"),
			join("/tmp/run", "pix-desktop-4"),
		);
		assert.equal(
			desktopArtifactDestination("/tmp/run", 4, "/t/pix-desktop.exe", "win32"),
			join("/tmp/run", "pix-desktop-4.exe"),
		);
	});

	it("launches fresh instances via /usr/bin/open -n -W on the copied bundle", () => {
		const bundle = desktopArtifactDestination("/tmp/run", 3, "/targets/macos/Pix Desktop.app", "darwin");
		const executable = desktopLaunchExecutable(bundle, "darwin");
		assert.equal(desktopAppBundlePath(executable), bundle);
		assert.deepEqual(macOSOpenArguments(bundle), ["-n", "-W", bundle]);
	});

	it("ad-hoc signs every macOS dev bundle with one stable TCC identity", () => {
		const bundle = "/tmp/run/pix-desktop-3/Pix Desktop.app";
		assert.deepEqual(macOSCodeSignArguments(bundle), [
			"--force",
			"--deep",
			"--sign",
			"-",
			"--identifier",
			"dev.pix.desktop",
			"--requirements",
			'=designated => identifier "dev.pix.desktop"',
			bundle,
		]);
	});

	it("parses ps output into pid/command records", () => {
		const entries = parseProcessList("    1 /sbin/launchd\n  4711 /usr/bin/open -n -W /tmp/run\n\njunk\n");
		assert.deepEqual(entries, [
			{ pid: 1, command: "/sbin/launchd" },
			{ pid: 4711, command: "/usr/bin/open -n -W /tmp/run" },
		]);
		assert.deepEqual(parseProcessList(""), []);
	});

	it("matches only the exact unique inner executable path, not prefix-sharing helpers", () => {
		const executable = "/tmp/run/pix-desktop-3/Pix Desktop.app/Contents/MacOS/pix-desktop";
		const entries = parseProcessList(
			[`  4711 ${executable}`, `  4712 ${executable} --flag`, `  4713 ${executable}-helper\n`].join("\n"),
		);
		assert.equal(findProcessByExecutablePath(entries, executable), 4711);
		assert.equal(findProcessByExecutablePath(entries, `${executable}-helper`), 4713);
		assert.equal(findProcessByExecutablePath(entries, "/tmp/run/other/Pix Desktop.app/Contents/MacOS/pix-desktop"), undefined);
	});
});

describe("watch:all filesystem event filtering", () => {
	it("ignores unchanged icon metadata events but still reports real edits and deletion", () => {
		const stamps = new Map([["desktop/src-tauri/icons/icon.icns", "file:100:10"]]);
		const path = "desktop/src-tauri/icons/icon.icns";

		assert.equal(updateWatchedPathStamp(stamps, path, "file:100:10"), false);
		assert.equal(updateWatchedPathStamp(stamps, path, "file:101:20"), true);
		assert.equal(updateWatchedPathStamp(stamps, path, "file:101:20"), false);
		assert.equal(updateWatchedPathStamp(stamps, path, "missing"), true);
	});
});

describe("watch:all npm invocation", () => {
	it("runs npm through its JavaScript entrypoint on Windows", () => {
		assert.deepEqual(npmInvocation(["run", "build"], "win32", "C:\\npm\\npm-cli.js"), {
			command: process.execPath,
			args: ["C:\\npm\\npm-cli.js", "run", "build"],
		});
		assert.throws(() => npmInvocation([], "win32", ""), /must be started through npm/u);
	});

	it("uses the npm executable directly on Unix", () => {
		assert.deepEqual(npmInvocation(["run", "build"], "darwin"), {
			command: "npm",
			args: ["run", "build"],
		});
	});
});
