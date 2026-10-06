import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PARTS, WatchAllSupervisor, desktopBuildArguments } from "../scripts/watch-all.mjs";

async function withFixture(test: (root: string) => Promise<void>) {
	const parent = resolve(".pi/artifacts");
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(join(parent, "watch-all-frontend-test-"));
	try {
		await test(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("watch:all private frontend output", () => {
	it("embeds private assets even when another build clears shared dist, then reuses them for Rust-only edits", async () => {
		await withFixture(async (root) => {
			const supervisor = new WatchAllSupervisor();
			supervisor.tempDirectory = join(root, "watcher");
			const sharedDist = join(root, "desktop", "dist");
			await mkdir(sharedDist, { recursive: true });
			await writeFile(join(sharedDist, "asset.js"), "shared");
			let webBuilds = 0;
			let captures = 0;
			supervisor.runCommand = async () => {};
			supervisor.captureDesktopArtifact = async () => { captures += 1; };
			supervisor.runNpmCommand = async (label: string, args: string[]) => {
				if (label === "build desktop web") {
					webBuilds += 1;
					const outDir = args[args.indexOf("--outDir") + 1];
					assert.equal(outDir, join(supervisor.tempDirectory!, "frontend-dist"));
					assert.ok(args.includes("--emptyOutDir"));
					await mkdir(outDir!, { recursive: true });
					await writeFile(join(outDir!, "index.html"), '<script src="asset.js"></script>');
					await writeFile(join(outDir!, "asset.js"), "private");
				} else {
					assert.equal(label, "build desktop native");
					const config = JSON.parse(args[args.indexOf("--config") + 1]!);
					assert.equal(config.build.beforeBuildCommand, "");
					assert.equal(config.build.frontendDist, supervisor.desktopFrontendDist);
					await rm(sharedDist, { recursive: true, force: true });
					assert.equal(await readFile(join(config.build.frontendDist, "asset.js"), "utf8"), "private");
				}
			};
			await supervisor.runBuildStep(PARTS.WEB);
			await supervisor.runBuildStep(PARTS.NATIVE);
			await supervisor.runBuildStep(PARTS.NATIVE);
			assert.equal(webBuilds, 1);
			assert.equal(captures, 2);
		});
	});

	it("uses separate output for separate watchers", async () => {
		await withFixture(async (root) => {
			const supervisors = [new WatchAllSupervisor(), new WatchAllSupervisor()];
			for (const [index, supervisor] of supervisors.entries()) {
				supervisor.tempDirectory = join(root, `watcher-${index}`);
				supervisor.runNpmCommand = async () => {};
				await supervisor.runBuildStep(PARTS.WEB);
			}
			assert.notEqual(supervisors[0]!.desktopFrontendDist, supervisors[1]!.desktopFrontendDist);
		});
	});

	it("rejects native embedding before a successful web build and after a failed rebuild", async () => {
		await withFixture(async (root) => {
			const supervisor = new WatchAllSupervisor();
			let captures = 0;
			let cleans = 0;
			supervisor.tempDirectory = root;
			supervisor.runCommand = async () => { cleans += 1; };
			supervisor.captureDesktopArtifact = async () => { captures += 1; };
			supervisor.runNpmCommand = async () => {};
			await assert.rejects(supervisor.runBuildStep(PARTS.NATIVE), /successful private frontend build is unavailable/);
			await supervisor.runBuildStep(PARTS.WEB);
			assert.ok(supervisor.desktopFrontendDist);
			supervisor.runNpmCommand = async () => { throw new Error("web build failed"); };
			await assert.rejects(supervisor.runBuildStep(PARTS.WEB), /web build failed/);
			assert.equal(supervisor.desktopFrontendDist, undefined);
			await assert.rejects(supervisor.runBuildStep(PARTS.NATIVE), /successful private frontend build is unavailable/);
			assert.equal(cleans, 0);
			assert.equal(captures, 0);
			assert.equal(supervisor.hasNativeBuild, false);
			supervisor.runNpmCommand = async () => {};
			await supervisor.runBuildStep(PARTS.WEB);
			await supervisor.runBuildStep(PARTS.NATIVE);
			assert.equal(captures, 1);
		});
	});

	it("passes absolute private frontendDist through the inline Tauri config", () => {
		const path = resolve(".pi/artifacts/watch frontend with spaces");
		const args = desktopBuildArguments("darwin", path);
		const config = JSON.parse(args[args.indexOf("--config") + 1]!);
		assert.deepEqual(config.build, { beforeBuildCommand: "", frontendDist: path });
	});
});
