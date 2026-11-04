// @ts-nocheck -- project scripts are intentionally untyped injectable Node modules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { parseArguments, runCli } from "../scripts/qa-desktop/cli.mjs";
import { sessionTarget } from "../scripts/qa-desktop/session.mjs";
import { acquireLaunchLock, launchDesktop, launchEnvironment, matchesRuntime, NATIVE_QA_CONTRACT, requireNativeIsolation, validateManifest } from "../scripts/qa-desktop/launch.mjs";
import { privateJson, readJson } from "../scripts/qa-desktop/paths.mjs";
import { filterApiKeys } from "../scripts/qa-desktop/seed.mjs";

// These fixtures and the scripts they exercise enforce macOS app-bundle structure,
// POSIX ownership/mode bits and exec permissions; Windows cannot express them.
const skipWindows = process.platform === "win32"
	? "QA desktop launch enforces macOS bundle and POSIX ownership/permission invariants that Windows cannot express"
	: false;

async function fixture(t) {
	const artifacts = join(process.cwd(), ".pi", "artifacts");
	await mkdir(artifacts, { recursive: true });
	const scratch = await mkdtemp(join(artifacts, "qa-launch-test-"));
	t.after(() => rm(scratch, { recursive: true, force: true }));
	const checkout = await realpath(scratch);
	const runDir = join(checkout, ".pi", "artifacts", "run");
	await mkdir(runDir, { recursive: true, mode: 0o700 });
	for (const path of ["profile", "profile/home", "profile/home/.pi", "profile/home/.pi/agent", "profile/home/.config", "profile/home/.config/pi", "workspace", "native", "native/Test.app", "native/Test.app/Contents", "native/Test.app/Contents/MacOS"]) await mkdir(join(runDir, path), { mode: 0o700 });
	const app = join(runDir, "native", "Test.app");
	const executable = join(app, "Contents", "MacOS", "pix-desktop");
	await writeFile(executable, `fake executable ${NATIVE_QA_CONTRACT}`, { mode: 0o700 });
	await writeFile(join(app, "Contents", "Info.plist"), "fake plist");
	const manifest = { version: 1, kind: "pix-desktop-qa", checkoutRoot: checkout, runDir,
		profileDir: join(runDir, "profile"), profileId: randomUUID(), workspace: join(runDir, "workspace"), app, executable,
		source: { buildStatus: "idle", ownerPid: 4242, statePath: "/fake/state.json", target: "/fake/Test.app" } };
	await privateJson(join(manifest.profileDir, "profile.json"), { version: 1, id: manifest.profileId });
	const manifestPath = join(runDir, "manifest.json");
	await privateJson(manifestPath, manifest);
	return { manifest, manifestPath, checkout };
}

function runtime(m, pid) { return { version: 1, contract: NATIVE_QA_CONTRACT, pid, executable: m.executable, profileDir: m.profileDir, appIdentifier: `dev.pix.desktop.qa.${m.profileId.replaceAll("-", "")}`, isolated: true }; }
function child() {
	const c = new EventEmitter(); c.pid = 7070;
	c.kill = () => { assert.fail("clean quit should not signal any process"); };
	return c;
}

test("bounded exact CLI flags", () => {
	assert.equal(parseArguments(["prepare", "--timeout-ms", "100", "--seed-config"]).seedConfig, true);
	for (const args of [["launch"], ["launch", "--manifest", "/x", "--seed-config"], ["prepare", "--timeout-ms", "900001"], ["prepare", "--state", "../escape"], ["prepare", "--seed-config", "--seed-config"], ["prepare", "--state"]]) assert.throws(() => parseArguments(args));
});

test("launch environment overrides isolation roots and removes working watcher/profile values", () => {
	const env = launchEnvironment({ profileDir: "/private/profile", workspace: "/private/workspace" }, { HOME: "/real", PI_CODING_AGENT_DIR: "/real/agent", PI_CONFIG_DIR: "/real/config", PIX_DESKTOP_WATCH_STATE: "/working/state", PIX_CONFIG_PROFILE: "working", PI_UI_QA_OTHER: "wrong", PATH: "/bin" });
	assert.equal(env.HOME, "/private/profile/home");
	assert.equal(env.PI_CODING_AGENT_DIR, "/private/profile/home/.pi/agent");
	assert.equal(env.PI_CONFIG_DIR, "/private/profile/home/.config/pi");
	assert.equal(env.PIX_DESKTOP_WATCH_STATE, undefined);
	assert.equal(env.PIX_CONFIG_PROFILE, undefined);
	assert.equal(env.PI_UI_QA_OTHER, undefined);
	assert.equal(env.PATH, "/bin");
});

test("API key filter never includes OAuth, command/env keys or extra credential fields", () => {
	const filtered = filterApiKeys({ api: { type: "api_key", key: "fake-only", refresh: "not-copied" }, oauth: { type: "oauth", access: "fake" }, command: { type: "api_key", key: "!echo nope" }, env: { type: "api_key", key: "$SECRET" } });
	assert.deepEqual(JSON.parse(JSON.stringify(filtered)), { api: { type: "api_key", key: "fake-only" } });
});

test("manifest exact identity, symlink rejection and exclusive lock", { skip: skipWindows }, async (t) => {
	const { manifest: m, manifestPath, checkout } = await fixture(t);
	assert.equal((await validateManifest(manifestPath, checkout)).profileId, m.profileId);
	const release = await acquireLaunchLock(m);
	await assert.rejects(acquireLaunchLock(m), /locked/);
	await release();
	const releaseAgain = await acquireLaunchLock(m); await releaseAgain();
	await privateJson(manifestPath, { ...m, executable: "/wrong/app" });
	await assert.rejects(validateManifest(manifestPath, checkout), /layout/);
	await privateJson(manifestPath, m);
	await rm(join(m.profileDir, "home", ".pi", "agent"), { recursive: true });
	await symlink(m.workspace, join(m.profileDir, "home", ".pi", "agent"));
	await assert.rejects(validateManifest(manifestPath, checkout), /symlink/);
});

test("runtime proof requires exact true child PID, executable, profile and isolation", () => {
	const m = { executable: "/private/app", profileDir: "/private/profile", profileId: randomUUID() };
	assert.equal(matchesRuntime(runtime(m, 7070), m, 7070), true);
	for (const patch of [{ pid: 4242 }, { executable: "/working/app" }, { profileDir: "/working/profile" }, { isolated: false }, { contract: "old" }, { appIdentifier: "dev.pix.desktop" }]) assert.equal(matchesRuntime({ ...runtime(m, 7070), ...patch }, m, 7070), false);
});

test("pre-isolation binary is rejected before spawn; capability can cross a read boundary", { skip: skipWindows }, async (t) => {
	const { manifest: m, manifestPath, checkout } = await fixture(t);
	await writeFile(m.executable, "old Desktop without isolation");
	await assert.rejects(launchDesktop({ manifest: manifestPath, checkout }, {
		spawnChild: () => assert.fail("old app must never open shared WebView state"),
	}), /predates isolated QA/);
	await assert.rejects(access(join(m.profileDir, "launch.lock")));
	await writeFile(m.executable, Buffer.concat([Buffer.alloc(1024 * 1024 - 5), Buffer.from(NATIVE_QA_CONTRACT)]));
	await requireNativeIsolation(m.executable);
});

test("ambient runtime, credential and provider-home overrides are not forwarded", () => {
	const env = launchEnvironment({ profileDir: "/qa/profile", workspace: "/qa/workspace" }, {
		PATH: "/bin", USER: "developer", XDG_DATA_HOME: "/working/data", NODE_OPTIONS: "--require /working/loader",
		PIX_ACP_ENTRY: "/working/acp.js", CODEX_HOME: "/working/codex", CLAUDE_CONFIG_DIR: "/working/claude", API_KEY: "secret",
	});
	for (const key of ["NODE_OPTIONS", "PIX_ACP_ENTRY", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "API_KEY"]) assert.equal(env[key], undefined);
	assert.equal(env.XDG_DATA_HOME, "/qa/profile/home/.local/share");
	assert.equal(env.USER, "developer");
});

test("direct same-PGID launch verifies child marker then propagates exit", { skip: skipWindows }, async (t) => {
	const { manifest: m, manifestPath, checkout } = await fixture(t);
	const c = child(); const signals = new EventEmitter(); let tick = 0, observed;
	const result = await launchDesktop({ manifest: manifestPath, checkout }, {
		signals, now: () => tick, wait: async () => { tick += 50; await privateJson(join(m.profileDir, "runtime.json"), runtime(m, c.pid)); },
		spawnChild: (executable, args, options) => { observed = { executable, args, options }; return c; },
		onReady: ({ pid }) => { assert.equal(pid, c.pid); c.emit("exit", 7, null); },
		quit: () => assert.fail("exited app needs no quit"),
	});
	assert.equal(result.code, 7);
	assert.equal(observed.executable, m.executable);
	assert.equal(observed.options.detached, false);
	assert.equal(observed.options.cwd, m.workspace);
	assert.equal((await readJson(join(m.runDir, "identity.json"))).pid, c.pid);
	assert.equal(signals.listenerCount("SIGTERM"), 0);
	await assert.rejects(access(join(m.profileDir, "launch.lock")));
});

test("missing handshake closes only owned child and releases lock", { skip: skipWindows }, async (t) => {
	const { manifest: m, manifestPath, checkout } = await fixture(t);
	const c = child(); let tick = 0, quitPid;
	await privateJson(join(m.profileDir, "runtime.json"), runtime(m, 4242)); // stale marker must be removed
	await privateJson(join(m.runDir, "identity.json"), runtime(m, 4242));
	await assert.rejects(launchDesktop({ manifest: manifestPath, checkout }, {
		signals: new EventEmitter(), spawnChild: () => c, now: () => tick, startupTimeoutMs: 100,
		wait: async () => { tick += 50; }, quit: async (pid) => { quitPid = pid; c.emit("exit", 0, null); },
	}), /did not prove isolated/);
	assert.equal(quitPid, c.pid);
	await assert.rejects(access(join(m.runDir, "identity.json")));
	await assert.rejects(access(join(m.profileDir, "launch.lock")));
});

test("signal cancellation cleanly quits exact child, removes listeners and unlocks", { skip: skipWindows }, async (t) => {
	const { manifest: m, manifestPath, checkout } = await fixture(t);
	const c = child(); const signals = new EventEmitter(); let tick = 0, quitPid;
	const result = await launchDesktop({ manifest: manifestPath, checkout }, {
		signals, spawnChild: () => c, now: () => tick,
		wait: async () => { tick += 50; await privateJson(join(m.profileDir, "runtime.json"), runtime(m, c.pid)); },
		onReady: () => signals.emit("SIGTERM"), quit: async (pid) => { quitPid = pid; c.emit("exit", 0, null); },
	});
	assert.equal(result.code, 143); assert.equal(quitPid, c.pid);
	assert.equal(signals.listenerCount("SIGTERM"), 0);
	await assert.rejects(access(join(m.profileDir, "launch.lock")));
});

test("session CLI requires a manifest, bounds lifetime, and leaves ordinary launch unchanged", async () => {
	for (const args of [["session"], ["session-target"], ["session", "--manifest", "/x", "--timeout-ms", "99"], ["session-target", "--manifest", "/x", "--timeout-ms", "100"], ["launch", "--manifest", "/x", "--timeout-ms", "100"]]) assert.throws(() => parseArguments(args));
	for (const [args, expected] of [[ ["session", "--manifest", "/x"], 900000 ], [ ["session", "--manifest", "/x", "--timeout-ms", "500"], 500 ], [ ["launch", "--manifest", "/x"], undefined ]]) {
		assert.equal(await runCli(args, "/checkout", { platform: "darwin", launch: async (options) => {
			assert.equal(options.sessionTimeoutMs, expected); return { code: 0 };
		} }), 0);
	}
});

test("continuous session survives repeated target checks and stops only at its deadline", { skip: skipWindows }, async (t) => {
	const { manifest: m, manifestPath, checkout } = await fixture(t);
	const c = child(); const signals = new EventEmitter(); let tick = 0, deadline, cleared = 0, quits = 0;
	const inspect = async () => ({ executable: m.executable, parentPid: process.pid });
	const result = await launchDesktop({ manifest: manifestPath, checkout, sessionTimeoutMs: 1000 }, {
		signals, spawnChild: () => c, now: () => tick,
		setTimer: (fn, ms) => { assert.equal(ms, 1000); deadline = fn; return 123; },
		clearTimer: (id) => { assert.equal(id, 123); cleared++; },
		wait: async () => { tick += 50; await privateJson(join(m.profileDir, "runtime.json"), runtime(m, c.pid)); },
		onReady: async () => {
			for (let i = 0; i < 2; i++) {
				const target = await sessionTarget({ manifest: manifestPath, checkout }, { now: () => tick, inspect });
				assert.deepEqual(target.target, { application: { pid: c.pid } });
				assert.equal(target.ownerPid, process.pid);
				assert.equal(quits, 0);
				await assert.rejects(acquireLaunchLock(m), /locked/);
			}
			tick = 1000; deadline(); signals.emit("SIGTERM"); // first cancellation wins
		},
		quit: async (pid) => { assert.equal(pid, c.pid); quits++; c.emit("exit", 0, null); },
	});
	assert.equal(result.code, 124); assert.equal(quits, 1); assert.equal(cleared, 1);
	assert.equal(signals.listenerCount("SIGTERM"), 0);
	await assert.rejects(access(join(m.profileDir, "launch.lock")));
	await assert.rejects(sessionTarget({ manifest: manifestPath, checkout }, { now: () => tick, inspect }));
});

test("session target rejects expired, foreign, reparented and stale live identities", { skip: skipWindows }, async (t) => {
	const { manifest: m, manifestPath, checkout } = await fixture(t);
	const release = await acquireLaunchLock(m); t.after(release);
	const identity = { ...runtime(m, 7070), profileId: m.profileId, ownerPid: process.pid, expiresAt: 1000 };
	await privateJson(join(m.runDir, "identity.json"), identity);
	await privateJson(join(m.profileDir, "runtime.json"), runtime(m, 7070));
	const options = { manifest: manifestPath, checkout };
	const deps = { now: () => 0, inspect: async () => ({ executable: m.executable, parentPid: process.pid }) };
	for (const patch of [{ expiresAt: 0 }, { ownerPid: process.pid + 1 }, { profileId: randomUUID() }, { pid: -1 }, { expiresAt: undefined }]) {
		await privateJson(join(m.runDir, "identity.json"), { ...identity, ...patch });
		await assert.rejects(sessionTarget(options, deps), /no live owned/);
	}
	await privateJson(join(m.runDir, "identity.json"), identity);
	for (const patch of [{ executable: "/working/Desktop" }, { parentPid: 1 }]) await assert.rejects(sessionTarget(options, { ...deps, inspect: async () => ({ ...await deps.inspect(), ...patch }) }), /no longer matches/);
	await privateJson(join(m.profileDir, "runtime.json"), runtime(m, 9999));
	await assert.rejects(sessionTarget(options, deps), /no longer matches/);
	await rm(join(m.profileDir, "runtime.json"));
	await assert.rejects(sessionTarget(options, deps));
});

test("session natural exit clears watchdog; pre-ready expiry cleans up without publishing target", { skip: skipWindows }, async (t) => {
	for (const expires of [false, true]) {
		const { manifest: m, manifestPath, checkout } = await fixture(t);
		const c = child(); const signals = new EventEmitter(); let deadline, cleared = 0;
		const promise = launchDesktop({ manifest: manifestPath, checkout, sessionTimeoutMs: 100 }, {
			signals, spawnChild: () => c,
			setTimer: (fn) => { deadline = fn; return 123; }, clearTimer: () => { cleared++; },
			wait: async () => { if (expires) deadline(); else await privateJson(join(m.profileDir, "runtime.json"), runtime(m, c.pid)); },
			onReady: () => c.emit("exit", 0, null), quit: async () => c.emit("exit", 0, null),
		});
		if (expires) await assert.rejects(promise, /cancelled by deadline/);
		else assert.equal((await promise).code, 0);
		assert.equal(cleared, 1); assert.equal(signals.listenerCount("SIGTERM"), 0);
		await assert.rejects(access(join(m.profileDir, "launch.lock")));
		if (expires) await assert.rejects(access(join(m.runDir, "identity.json")));
	}
});

test("failed session cleanup rejects without hanging or unlocking a live child", { skip: skipWindows }, async (t) => {
	const { manifest: m, manifestPath, checkout } = await fixture(t);
	const c = child(); const signals = new EventEmitter(); const kills = []; let deadline;
	c.kill = (signal) => { kills.push(signal); };
	await assert.rejects(launchDesktop({ manifest: manifestPath, checkout, sessionTimeoutMs: 100 }, {
		signals, spawnChild: () => c, setTimer: (fn) => { deadline = fn; return 123; }, clearTimer: () => {},
		wait: async () => { await privateJson(join(m.profileDir, "runtime.json"), runtime(m, c.pid)); },
		onReady: () => deadline(), quit: async () => { throw new Error("quit failed"); },
	}), /owned QA child did not exit/);
	assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
	await access(join(m.profileDir, "launch.lock"));
	assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("session revokes attach before pending quit while preserving historical identity", { skip: skipWindows }, async (t) => {
	const { manifest: m, manifestPath, checkout } = await fixture(t);
	const c = child(); const signals = new EventEmitter();
	const options = { manifest: manifestPath, checkout, sessionTimeoutMs: 900000 };
	const deps = { inspect: async () => ({ executable: m.executable, parentPid: process.pid }) };
	const result = await launchDesktop(options, {
		signals, spawnChild: () => c,
		wait: async () => { await privateJson(join(m.profileDir, "runtime.json"), runtime(m, c.pid)); },
		onReady: async () => {
			await sessionTarget(options, deps);
			signals.emit("SIGTERM");
		},
		quit: async () => {
			// Child, runtime and identity still exist, but new attach is revoked.
			await access(join(m.runDir, "identity.json"));
			await assert.rejects(sessionTarget(options, deps), /no live owned/);
			c.emit("exit", 0, null);
		},
	});
	assert.equal(result.code, 143);
});
