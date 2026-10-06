// @ts-nocheck -- injectable Node script modules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile, readdir, stat, symlink, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { checkedPath, safePath, boundedRead, readJson, privateJson, createRun, ownedRoot, validateBundle } from "../scripts/qa-desktop/paths.mjs";
import { discoverWatcher, verifyOwner, successfulState } from "../scripts/qa-desktop/watch.mjs";
import { prepareDesktop, boundedTimeout } from "../scripts/qa-desktop/prepare.mjs";
import { seedProfile, filterApiKeys } from "../scripts/qa-desktop/seed.mjs";

// These fixtures and the scripts they exercise enforce macOS app-bundle structure,
// POSIX ownership/mode bits, exec permissions and O_NOFOLLOW; Windows cannot express them.
const skipWindows = process.platform === "win32"
 ? "QA desktop prepare enforces macOS bundle and POSIX ownership/permission invariants that Windows cannot express"
 : false;

async function fixture(t) {
 const base = join(process.cwd(), ".pi", "artifacts");
 await mkdir(base, { recursive: true });
 const scratch = await realpath(await mkdtemp(join(base, "qa-prepare-test-")));
 t.after(() => rm(scratch, { recursive: true, force: true }));
 const checkout = join(scratch, "checkout"), tempRoot = join(scratch, "temp");
 await mkdir(checkout); await mkdir(tempRoot);
 const directory = join(tempRoot, "pix-watch-all-one"); await mkdir(directory);
 const statePath = join(directory, "desktop-watch-state.json");
 const owner = join(directory, "watch-all-owner.json");
 await privateJson(owner, { pid: 4242, checkoutRoot: checkout });
 async function bundle(name) {
  const app = join(directory, name + ".app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  const target = join(app, "Contents", "MacOS", "pix-desktop");
  await writeFile(target, "fake native", { mode: 0o700 });
  await writeFile(join(app, "Contents", "Info.plist"), "fake plist");
  return target;
 }
 const target = await bundle("First");
 const publish = (status = "idle", selected = target) => privateJson(statePath, { version: 1, target: selected, stale: false, buildStatus: status });
 await publish();
 const probe = async () => ({ cwd: checkout, command: "node scripts/watch-all.mjs" });
 let tick = 0;
 const dependencies = { tempRoot, probe, now: () => tick, wait: async (ms) => { tick += ms; }, seed: { env: {}, home: join(scratch, "absent") } };
 const options = { checkout, state: statePath, timeoutMs: 500, runDir: join(checkout, ".pi", "artifacts", "run") };
 return { scratch, checkout, tempRoot, directory, statePath, owner, target, bundle, publish, probe, dependencies, options,
  watcher: { statePath, directory, ownerPid: 4242, tempRoot } };
}
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function absent(path) { await assert.rejects(stat(path), { code: "ENOENT" }); }

test("prepare pins native and embedded contents into separate private profile/workspace without mutating source", { skip: skipWindows }, async (t) => {
 const f = await fixture(t);
 const before = await Promise.all([readFile(f.owner), readFile(f.statePath), readFile(f.target), stat(f.target)]);
 const result = await prepareDesktop(f.options, f.dependencies);
 const m = await json(result.manifestPath);
 assert.equal(m.source.target, f.target); assert.equal(m.source.buildStatus, "idle");
 assert.equal(m.pinScope, "native-and-embedded-web; development ACP resolves from checkout");
 assert.notEqual(m.executable, f.target); assert.equal(await readFile(m.executable, "utf8"), "fake native");
 assert.equal(m.profileDir, join(m.runDir, "profile")); assert.equal(m.workspace, join(m.runDir, "workspace"));
 assert.equal((await json(join(m.profileDir, "profile.json"))).id, m.profileId);
 for (const path of [m.runDir, m.profileDir, m.workspace]) assert.equal((await stat(path)).mode & 0o777, 0o700);
 for (const path of [result.manifestPath, join(m.profileDir, "profile.json")]) assert.equal((await stat(path)).mode & 0o777, 0o600);
 assert.deepEqual(await readdir(join(m.profileDir, "home", ".pi", "agent")), []);
 assert.deepEqual(await readFile(f.owner), before[0]); assert.deepEqual(await readFile(f.statePath), before[1]);
 assert.deepEqual(await readFile(f.target), before[2]); assert.equal((await stat(f.target)).mtimeMs, before[3].mtimeMs);
 assert.deepEqual((await readdir(m.runDir)).sort(), ["manifest.json", "native", "profile", "workspace"]);
 });

for (const status of ["queued", "building"]) test(`prepare waits for ${status} then pins idle`, { skip: skipWindows }, async (t) => {
 const f = await fixture(t); await f.publish(status); let waits = 0;
 const result = await prepareDesktop(f.options, { ...f.dependencies, wait: async (ms) => { waits++; await f.dependencies.wait(ms); await f.publish(); } });
 assert.equal(waits, 1); assert.equal((await json(result.manifestPath)).source.target, f.target);
});
test("failed state never pins an old successful target and removes owned run", async (t) => {
 const f = await fixture(t); await f.publish("failed");
 await assert.rejects(prepareDesktop(f.options, f.dependencies), /build failed/); await absent(f.options.runDir); await stat(f.target);
});
test("bounded timeout removes run and does not copy queued old target", async (t) => {
 const f = await fixture(t); await f.publish("queued"); let waits = 0;
 await assert.rejects(prepareDesktop({ ...f.options, timeoutMs: 100 }, { ...f.dependencies, copy: () => assert.fail("must not copy"), wait: async (ms) => { waits++; await f.dependencies.wait(ms); } }), /timed out/);
 assert.equal(waits, 1); await absent(f.options.runDir);
 for (const value of [99, 300001, 1.5, "bad", Infinity]) assert.throws(() => boundedTimeout(value));
 assert.equal(boundedTimeout(), 120000);
});
for (const race of ["changed-target", "ENOENT"]) test(`prepare cleans staging and retries ${race} pruning race`, { skip: skipWindows }, async (t) => {
 const f = await fixture(t); const next = await f.bundle("Second"); let copies = 0;
 const result = await prepareDesktop(f.options, { ...f.dependencies, copy: async (source, destination, options) => {
  copies++; await cp(source, destination, options);
  if (copies === 1) { await f.publish("idle", next); if (race === "ENOENT") { await rm(dirname(dirname(dirname(f.target))), { recursive: true }); throw Object.assign(new Error("pruned"), { code: "ENOENT" }); } }
 } });
 const m = await json(result.manifestPath); assert.equal(copies, 2); assert.equal(m.source.target, next);
 assert.deepEqual(await readdir(join(m.runDir, "native")), ["Second.app"]);
 assert.equal((await readdir(m.runDir)).some((name) => name.startsWith(".snapshot")), false);
});
test("copy errors clean owned run but never remove a preexisting run", { skip: skipWindows }, async (t) => {
 const f = await fixture(t);
 await assert.rejects(prepareDesktop(f.options, { ...f.dependencies, copy: async () => { throw new Error("copy failure"); } }), /copy failure/);
 await absent(f.options.runDir);
 await mkdir(f.options.runDir); await writeFile(join(f.options.runDir, "sentinel"), "keep");
 await assert.rejects(prepareDesktop(f.options, f.dependencies), { code: "EEXIST" });
 assert.equal(await readFile(join(f.options.runDir, "sentinel"), "utf8"), "keep");
});
test("discovery verifies checkout, live supervisor, legacy pid owner and explicit ambiguous selection", async (t) => {
 const f = await fixture(t);
 const args = { checkout: f.checkout, tempRoot: f.tempRoot, probe: f.probe };
 await assert.rejects(discoverWatcher({ ...args, deadline: 0, now: () => 0 }), /deadline/);
 await assert.rejects(discoverWatcher({ ...args, state: join(f.checkout, "desktop-watch-state.json") }), /outside system temp/);
 assert.equal((await discoverWatcher(args)).ownerPid, 4242);
 await privateJson(f.owner, { pid: 4242 }); assert.equal((await discoverWatcher(args)).statePath, f.statePath);
 for (const probe of [async () => undefined, async () => ({ cwd: "/wrong", command: "node scripts/watch-all.mjs" }), async () => ({ cwd: f.checkout, command: "node scripts/not-watch-all.mjs" })]) await assert.rejects(discoverWatcher({ ...args, probe }), /no verifiable/);
 await privateJson(f.owner, { pid: 4242, checkoutRoot: "/wrong" });
 await assert.rejects(verifyOwner(f.statePath, f.checkout, f.tempRoot, f.probe), /different checkout/);
 await privateJson(f.owner, { pid: 4242 });
 const second = join(f.tempRoot, "pix-watch-all-second"); await mkdir(second); await privateJson(join(second, "watch-all-owner.json"), { pid: 9999 });
 await assert.rejects(discoverWatcher(args), /multiple live/);
 assert.equal((await discoverWatcher({ ...args, state: f.statePath })).statePath, f.statePath);
});
test("discovery bounds relevant candidates and hung probe by prepare deadline", async (t) => {
 const f = await fixture(t);
 await assert.rejects(prepareDesktop({ ...f.options, timeoutMs: 100 }, { ...f.dependencies, probe: () => new Promise(() => {}) }), /probe timed out/);
 await absent(f.options.runDir);
 for (let i = 0; i < 32; i++) await mkdir(join(f.tempRoot, `pix-watch-all-extra-${i}`));
 await assert.rejects(discoverWatcher({ checkout: f.checkout, tempRoot: f.tempRoot, probe: () => assert.fail("candidate bound before probes") }), /candidate discovery exceeds/);
 await assert.rejects(discoverWatcher({ checkout: f.checkout, tempRoot: f.tempRoot, probe: f.probe, deadline: 0, now: () => 0 }), /candidate discovery exceeds/);
});
test("watch state rejects escaped/non-app targets, oversized state and symlink owners", async (t) => {
 const f = await fixture(t);
 await privateJson(f.statePath, { version: 1, target: f.target, stale: true });
 assert.equal((await successfulState(f.watcher, f.checkout, f.probe)).target, f.target); // Legacy no-status publications.
 await privateJson(f.statePath, { version: 2, target: f.target, stale: false });
 await assert.rejects(successfulState(f.watcher, f.checkout, f.probe), /invalid watcher state/);
 for (const target of [join(f.checkout, "outside"), join(f.directory, "raw", "Contents", "MacOS", "pix-desktop")]) {
  await f.publish("idle", target); await assert.rejects(successfulState(f.watcher, f.checkout, f.probe), /escapes|not the copied/);
 }
 await writeFile(f.statePath, "x".repeat(4097)); await assert.rejects(successfulState(f.watcher, f.checkout, f.probe), /oversized/);
 await rm(f.owner); const outside = join(f.scratch, "owner.json"); await privateJson(outside, { pid: 4242 }); await symlink(outside, f.owner);
 await assert.rejects(verifyOwner(f.statePath, f.checkout, f.tempRoot, f.probe), /symlink/);
});
test("paths reject traversal, symlinks, oversized inputs and invalid bundles; default run is harness-owned", { skip: skipWindows }, async (t) => {
 const f = await fixture(t);
 for (const path of ["../escape", "bad\npath", "x".repeat(4097), ""]) assert.throws(() => checkedPath(path));
 const file = join(f.checkout, "input"); await writeFile(file, "secret".repeat(1000));
 await assert.rejects(boundedRead(file), /limit/); await assert.rejects(readJson(file), /oversized/);
 await writeFile(file, '{"secret":not-json}'); await assert.rejects(readJson(file), (e) => !e.message.includes("secret"));
 const link = join(f.checkout, "link"); await symlink(file, link);
 await assert.rejects(safePath(f.checkout, link, "file"), /symlink/); await assert.rejects(boundedRead(link));
 await assert.rejects(createRun(f.checkout, join(f.checkout, "outside")), /run-dir/);
 await mkdir(join(f.checkout, ".pi"), { recursive: true });
 await symlink(f.tempRoot, join(f.checkout, ".pi", "artifacts"));
 await assert.rejects(createRun(f.checkout, join(f.checkout, ".pi", "artifacts", "linked-run")), /symlink/);
 await rm(join(f.checkout, ".pi", "artifacts"));
 const run = await createRun(f.checkout); assert.equal(dirname(run), join(f.checkout, ".pi", "subagents")); assert.equal(await ownedRoot(f.checkout, run), run);
 await assert.rejects(createRun(f.checkout, run), { code: "EEXIST" });
 const app = dirname(dirname(dirname(f.target)));
 await assert.rejects(validateBundle(app, 0, () => 0), /deadline/);
 await symlink(file, join(app, "bad-link")); await assert.rejects(validateBundle(app), /symlink/);
});

async function seedFixture(f) {
 const home = join(f.scratch, "source-home"), agent = join(home, ".pi", "agent"), user = join(home, ".config", "pi"), suite = join(f.scratch, "suite"), profile = join(f.scratch, "profile");
 for (const dir of [agent, user, suite, join(profile, "home", ".pi", "agent"), join(profile, "home", ".config", "pi")]) await mkdir(dir, { recursive: true });
 return { home, agent, user, suite, profile, env: { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: suite } };
}
test("seed config fixed allowlist is explicit and retains suite precedence, never session/extension inputs", { skip: skipWindows }, async (t) => {
 const f = await fixture(t), s = await seedFixture(f);
 for (const name of ["settings.json", "models.json", "sessions.json", "auth.json", "extensions.js"]) await writeFile(join(s.agent, name), name);
 for (const name of ["pix-desktop.jsonc", "pi-tools-suite.jsonc", "session.json"]) await writeFile(join(s.user, name), name);
 await writeFile(join(s.suite, "pi-tools-suite.jsonc"), "override"); await writeFile(join(s.suite, "settings.json"), "never");
 assert.equal((await seedProfile(s.profile, { env: s.env })).configFiles, 0);
 assert.deepEqual(await readdir(join(s.profile, "home", ".pi", "agent")), []);
 assert.equal((await seedProfile(s.profile, { env: s.env, seedConfig: true })).configFiles, 5);
 assert.deepEqual((await readdir(join(s.profile, "home", ".pi", "agent"))).sort(), ["models.json", "settings.json"]);
 assert.deepEqual((await readdir(join(s.profile, "home", ".config", "pi"))).sort(), ["pi-tools-suite.jsonc", "pix-desktop.jsonc"]);
 assert.equal(await readFile(join(s.profile, "home", ".config", "pi", "pi-tools-suite.jsonc"), "utf8"), "override");
 assert.equal((await stat(join(s.profile, "suite-config", "pi-tools-suite.jsonc"))).mode & 0o777, 0o600);
});
test("seed copies only literal API keys, not OAuth/session/env/commands or bare SDK variable expressions", { skip: skipWindows }, async (t) => {
 const f = await fixture(t), s = await seedFixture(f);
 const input = { literal: { type: "api_key", key: "fake-literal-key", refresh: "discard" }, oauth: { type: "oauth", access: "fake" }, session: { type: "session", key: "fake" }, env: { type: "api_key", key: "$SECRET" }, bare: { type: "api_key", key: "SECRET_API_KEY" }, lower: { type: "api_key", key: "secretName" }, command: { type: "api_key", key: "  !touch never" }, explicit: { type: "api_key", key: "fake-key", env: "SECRET" }, "bad/provider": { type: "api_key", key: "fake-key" } };
 assert.deepEqual(JSON.parse(JSON.stringify(filterApiKeys(input))), { literal: { type: "api_key", key: "fake-literal-key" } });
 await privateJson(join(s.agent, "auth.json"), input);
 const result = await seedProfile(s.profile, { env: s.env, seedApiKeys: true });
 assert.equal(result.apiKeyCount, 1); assert.equal(result.configFiles, 0);
 const auth = join(s.profile, "home", ".pi", "agent", "auth.json");
 assert.deepEqual(await json(auth), { literal: { type: "api_key", key: "fake-literal-key" } }); assert.equal((await stat(auth)).mode & 0o777, 0o600);
});
for (const unsafe of ["symlink", "oversized"]) test(`seed rejects ${unsafe} optional config input`, async (t) => {
 const f = await fixture(t), s = await seedFixture(f);
 if (unsafe === "symlink") { const target = join(f.scratch, "settings"); await writeFile(target, "fake"); await symlink(target, join(s.agent, "settings.json")); }
 else await writeFile(join(s.agent, "settings.json"), "x".repeat(1024 * 1024 + 1));
 await assert.rejects(seedProfile(s.profile, { env: s.env, seedConfig: true }), /unsafe, invalid or exceeds/);
});
