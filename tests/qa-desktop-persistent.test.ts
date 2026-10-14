// @ts-nocheck -- injectable untyped project scripts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArguments } from "../scripts/qa-desktop/cli.mjs";
import { acquireLaunchLock, launchEnvironment, matchesRuntime, NATIVE_QA_CONTRACT, validateManifest } from "../scripts/qa-desktop/launch.mjs";
import { persistentProjectOption, preparePersistentProject, PERSISTENT_QA_CONTRACT, validatePersistentProject } from "../scripts/qa-desktop/persistent.mjs";
import { privateJson } from "../scripts/qa-desktop/paths.mjs";

const skip = process.platform === "win32" ? "QA profile enforces POSIX ownership and permissions" : false;
async function fixture(t) {
	await mkdir(".pi/artifacts", { recursive: true });
	const root = await realpath(await mkdtemp(".pi/artifacts/qa-persistent-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const checkout = join(root, "checkout"), workspace = join(root, "project");
	await mkdir(checkout, { mode: 0o700 });
	return { root, checkout, workspace };
}

test("persistent flags are bounded and local defaults can be explicitly bypassed", { skip }, async (t) => {
	const f = await fixture(t);
	assert.equal(parseArguments(["prepare", "--persistent-project", f.workspace]).persistentProject, f.workspace);
	assert.equal(parseArguments(["prepare", "--temporary"]).temporary, true);
	await mkdir(join(f.checkout, ".pi"));
	await privateJson(join(f.checkout, ".pi", "qa-desktop.json"), { version: 1, persistentProject: f.workspace });
	assert.equal(await persistentProjectOption(f.checkout, {}), f.workspace);
	assert.equal(await persistentProjectOption(f.checkout, { temporary: true, seedConfig: true }), undefined);
	for (const extra of [{ emptyWorkspace: true }, { seedConfig: true }, { seedApiKeys: true }, { temporary: true, persistentProject: f.workspace }]) await assert.rejects(persistentProjectOption(f.checkout, extra), /persistent|conflicts/);
	await privateJson(join(f.checkout, ".pi", "qa-desktop.json"), { version: 9 });
	await assert.rejects(persistentProjectOption(f.checkout, {}), /settings/);
});

test("reuse preserves profile UUID, model configuration, history and project files", { skip }, async (t) => {
	const f = await fixture(t);
	const first = await preparePersistentProject(f.checkout, f.workspace);
	const settings = join(first.profileDir, "home/.pi/agent/settings.json");
	await writeFile(settings, "fake-model-settings-only");
	await writeFile(join(f.workspace, "notes.md"), "test project work");
	const second = await preparePersistentProject(f.checkout, f.workspace);
	assert.deepEqual(second, first);
	assert.equal(await readFile(settings, "utf8"), "fake-model-settings-only");
	assert.equal(await readFile(join(f.workspace, "notes.md"), "utf8"), "test project work");
	const release = await acquireLaunchLock(first);
	await assert.rejects(acquireLaunchLock(second), /locked/);
	await release();
	const next = await acquireLaunchLock(second); await next();
});

test("reject redirected, source/ancestor, foreign, incomplete and public profiles without deleting them", { skip }, async (t) => {
	const f = await fixture(t);
	for (const path of [f.checkout, join(f.checkout, "child"), f.root]) await assert.rejects(preparePersistentProject(f.checkout, path), /separate/);
	const p = await preparePersistentProject(f.checkout, f.workspace);
	await symlink(f.workspace, join(f.root, "link"));
	await assert.rejects(preparePersistentProject(f.checkout, join(f.root, "link")), /redirected/);
	await assert.rejects(validatePersistentProject(join(f.root, "other"), f.workspace), /ownership/);
	await chmod(p.profileDir, 0o755);
	await assert.rejects(preparePersistentProject(f.checkout, f.workspace), /private/);
	await chmod(p.profileDir, 0o700);
	await rm(join(p.profileDir, "profile.json"));
	await assert.rejects(preparePersistentProject(f.checkout, f.workspace));
	assert.equal(await realpath(p.profileDir), p.profileDir);
});

test("concurrent first prepare creates only one UUID; loser fails closed or adopts committed identity", { skip }, async (t) => {
	const f = await fixture(t);
	const results = await Promise.allSettled([preparePersistentProject(f.checkout, f.workspace), preparePersistentProject(f.checkout, f.workspace)]);
	const completed = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
	assert.ok(completed.length >= 1);
	const actual = await validatePersistentProject(f.checkout, f.workspace);
	for (const p of completed) assert.equal(p.profileId, actual.profileId);
});

test("persistent environment and runtime require explicit store proof; ephemeral cannot adopt it", () => {
	const m = { profileId: "12345678-1234-4234-8234-123456789abc", profileDir: "/qa/profile", workspace: "/qa/project", executable: "/qa/app", persistentWebview: true };
	const env = launchEnvironment(m, { PI_UI_QA_PERSISTENT_WEBVIEW: "wrong", HOME: "/real" });
	assert.equal(env.PI_UI_QA_PERSISTENT_WEBVIEW, "1");
	assert.equal(launchEnvironment({ ...m, persistentWebview: undefined }, env).PI_UI_QA_PERSISTENT_WEBVIEW, undefined);
	const marker = { version: 1, contract: PERSISTENT_QA_CONTRACT, pid: 1, executable: m.executable, profileDir: m.profileDir,
		appIdentifier: `dev.pix.desktop.qa.${m.profileId.replaceAll("-", "")}`, isolated: true, persistentWebview: true, webviewStoreId: m.profileId };
	assert.equal(matchesRuntime(marker, m, 1), true);
	for (const patch of [{ contract: NATIVE_QA_CONTRACT }, { persistentWebview: false }, { webviewStoreId: "other" }]) assert.equal(matchesRuntime({ ...marker, ...patch }, m, 1), false);
	assert.equal(matchesRuntime(marker, { ...m, persistentWebview: undefined }, 1), false);
});

test("external profile manifest is exact, private and capability-gated before launch", { skip }, async (t) => {
	const f = await fixture(t), p = await preparePersistentProject(f.checkout, f.workspace);
	const runDir = join(f.checkout, ".pi/artifacts/run");
	const app = join(runDir, "native/Test.app"), executable = join(app, "Contents/MacOS/pix-desktop");
	await mkdir(join(app, "Contents/MacOS"), { recursive: true, mode: 0o700 });
	await chmod(runDir, 0o700);
	await writeFile(executable, NATIVE_QA_CONTRACT, { mode: 0o700 });
	await writeFile(join(app, "Contents/Info.plist"), "fake");
	const m = { version: 1, kind: "pix-desktop-qa", checkoutRoot: f.checkout, runDir, ...p, app, executable,
		source: { buildStatus: "idle", ownerPid: 1, target: "/fake/source.app", statePath: "/fake/state.json" } };
	const manifest = join(runDir, "manifest.json");
	await privateJson(manifest, m);
	await assert.rejects(validateManifest(manifest, f.checkout), /predates/);
	await writeFile(executable, `${NATIVE_QA_CONTRACT} ${PERSISTENT_QA_CONTRACT}`);
	assert.equal((await validateManifest(manifest, f.checkout)).profileId, p.profileId);
	for (const patch of [{ profileDir: join(p.workspace, "wrong") }, { profileId: "87654321-1234-4234-8234-123456789abc" }, { persistentWebview: false }]) {
		await privateJson(manifest, { ...m, ...patch });
		await assert.rejects(validateManifest(manifest, f.checkout), /identity|layout/);
	}
});
