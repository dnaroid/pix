import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
	PARTS,
	WatchAllSupervisor,
	appendCommandOutputTail,
	classifyChange,
	createBuildPlan,
	desktopWatchState,
	parseDesktopWatchState,
	desktopAppBundlePath,
	desktopArtifactDestination,
	desktopBundleDirectory,
	desktopBuildArguments,
	desktopLaunchExecutable,
	findProcessByExecutablePath,
	formatCommandFailureReport,
	hasProcessPid,
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

	it("does not replace Desktop for builds that produce no new artifact", () => {
		assert.deepEqual(createBuildPlan([PARTS.ACP], { hasNativeBuild: true }), {
			steps: [PARTS.ACP],
			restartDesktop: false,
		});
	});

	it("orders a complete initial build by dependency", () => {
		assert.deepEqual(createBuildPlan([], { initial: true, hasNativeBuild: false }), {
			steps: [PARTS.SUITE, PARTS.PIX, PARTS.ACP, PARTS.WEB, PARTS.NATIVE],
			restartDesktop: true,
		});
	});

	it("makes the Vite entrypoint a Cargo input for Tauri asset embedding", async () => {
		const buildScript = await readFile(resolve("desktop/src-tauri/build.rs"), "utf8");
		assert.match(buildScript, /cargo:rerun-if-changed=\.\.\/dist\/index\.html/u);
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
			desktopLaunchExecutable("/tmp/run/pix-desktop-3.app", "darwin", "pix-desktop"),
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

describe("watch:all Desktop restart handoff", () => {
	it("publishes a bounded state with the new artifact and explicit stale flag", () => {
		assert.equal(
			desktopWatchState("/tmp/pix-desktop-2", true),
			'{"version":1,"target":"/tmp/pix-desktop-2","stale":true}\n',
		);
		assert.throws(() => desktopWatchState("x".repeat(5_000), true), /size limit/u);
	});

	it("accepts only valid supervisor state", () => {
		assert.deepEqual(
			parseDesktopWatchState(JSON.parse(desktopWatchState("/tmp/pix-desktop-2", true))),
			{ target: "/tmp/pix-desktop-2", stale: true },
		);
		assert.equal(parseDesktopWatchState({ version: 2, target: "/tmp/pix", stale: true }), undefined);
	});

	it("schedules the initial Desktop launch after the successful build has finished", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "watch-all-test-"));
		const supervisor = new WatchAllSupervisor();
		const buildingStates: boolean[] = [];
		supervisor.desktopWatchStatePath = join(temporaryDirectory, "desktop-watch-state.json");
		supervisor.pendingParts.add(PARTS.WEB);
		supervisor.runBuildStep = async (step: string) => {
			if (step === PARTS.NATIVE) supervisor.desktopExecutable = "/tmp/pix-desktop";
		};
		supervisor.scheduleDesktopRestart = () => buildingStates.push(supervisor.building);

		try {
			await supervisor.runQueuedBuild();
			assert.deepEqual(buildingStates, [true, false]);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("honors a restart request that arrives while a newer artifact is being published", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "watch-all-test-"));
		const supervisor = new WatchAllSupervisor();
		const statePath = join(temporaryDirectory, "desktop-watch-state.json");
		const requestPath = join(temporaryDirectory, "desktop-watch-state.restart");
		let scheduled = false;
		supervisor.desktopWatchStatePath = statePath;
		supervisor.desktopRestartRequestPath = requestPath;
		supervisor.desktopExecutable = "/tmp/pix-desktop-new";
		supervisor.scheduleDesktopRestart = () => { scheduled = true; };
		await writeFile(statePath, desktopWatchState("/tmp/pix-desktop-previous", true));
		await writeFile(requestPath, "restart\n");

		try {
			await supervisor.consumeDesktopRestartRequest();
			assert.equal(scheduled, true);
			assert.equal(existsSync(requestPath), false);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("keeps a newer Desktop revision pending when a restart finishes concurrently", async () => {
		const supervisor = new WatchAllSupervisor();
		let rescheduled = false;
		supervisor.restartPending = true;
		supervisor.desktopRevision = 4;
		supervisor.restartDesktop = async () => {
			supervisor.desktopRevision = 5;
			return true;
		};
		supervisor.scheduleDesktopRestart = () => { rescheduled = true; };

		await supervisor.runDesktopRestart();

		assert.equal(supervisor.restartPending, true);
		assert.equal(supervisor.desktopRestarting, false);
		assert.equal(rescheduled, true);
	});

	it("does not spin after a restart failure", async () => {
		const supervisor = new WatchAllSupervisor();
		let rescheduled = false;
		supervisor.restartPending = true;
		supervisor.restartDesktop = async () => { throw new Error("cannot launch"); };
		supervisor.scheduleDesktopRestart = () => { rescheduled = true; };

		await supervisor.runDesktopRestart();

		assert.equal(supervisor.restartPending, false);
		assert.equal(rescheduled, false);
	});

	it("retries a newer revision when the previous restart fails", async () => {
		const supervisor = new WatchAllSupervisor();
		let rescheduled = false;
		supervisor.restartPending = true;
		supervisor.desktopRevision = 4;
		supervisor.restartDesktop = async () => {
			supervisor.desktopRevision = 5;
			throw new Error("cannot launch previous artifact");
		};
		supervisor.scheduleDesktopRestart = () => { rescheduled = true; };

		await supervisor.runDesktopRestart();

		assert.equal(supervisor.restartPending, true);
		assert.equal(rescheduled, true);
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
		const tempDirectory = resolve("/tmp", "run");
		const bundle = desktopArtifactDestination(tempDirectory, 3, "/targets/macos/Pix Desktop.app", "darwin");
		const executable = desktopLaunchExecutable(bundle, "darwin", "pix-desktop");
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

	it("can verify that the real app PID survived startup independently from /usr/bin/open", () => {
		const entries = parseProcessList("  4711 /usr/bin/open -n -W /tmp/run\n  8112 /tmp/run/Pix Desktop.app/Contents/MacOS/pix-desktop\n");
		assert.equal(hasProcessPid(entries, 8112), true);
		assert.equal(hasProcessPid(entries, 9999), false);
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
	it("uses the npm selected by PATH through cmd.exe on Windows", () => {
		assert.deepEqual(npmInvocation(["run", "build"], "win32", "C:\\Windows\\System32\\cmd.exe"), {
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "npm", "run", "build"],
		});
	});

	it("uses the npm executable directly on Unix", () => {
		assert.deepEqual(npmInvocation(["run", "build"], "darwin"), {
			command: "npm",
			args: ["run", "build"],
		});
	});
});

describe("watch:all build failure reporting", () => {
	it("keeps a bounded tail instead of retaining an unbounded build log", () => {
		const first = appendCommandOutputTail("", "012345", 8);
		assert.equal(first, "012345");
		assert.equal(appendCommandOutputTail(first, "6789", 8), "23456789");
	});

	it("repeats the captured error underneath a prominent failed-build banner", () => {
		const report = formatCommandFailureReport(
			"build desktop native",
			{ code: 1, signal: null },
			"Compiling pix-desktop\nerror[E0282]: type annotations needed\n",
		);
		assert.match(report, /BUILD FAILED: build desktop native \(exit 1\)/u);
		assert.match(report, /error\[E0282\]: type annotations needed/u);
	});
});
