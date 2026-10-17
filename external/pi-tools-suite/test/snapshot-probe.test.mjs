import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile, rename, stat, readFile, utimes, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { probeSnapshots } from "../src/project-search/snapshot-probe.mjs";
import { writeSourcePolicy } from "../src/project-search/source-policy.mjs";
import { openStore, snapshot, publish } from "../src/project-search/native-store.mjs";
import { scanProject } from "../src/project-search/native-scan.mjs";
import { readRepositorySnapshot } from "../src/project-search/repository-snapshot.mjs";
import { openVectorStore } from "../src/project-search/native-vector-store.mjs";
import { removeDirsWithRetry } from "./support/fs-retry.mjs";

const signal = () => new AbortController().signal;
async function publishLocal(root, source = "code") {
  const store = await openStore(root, source);
  try {
    const previous = snapshot(store), scan = await scanProject(root, previous, undefined, signal(), source);
    assert.equal(scan.complete, true, scan.notices.join(" "));
    assert.equal(publish(store, previous, scan), true);
  } finally { store.close(); }
}

const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/snapshot-probe-tests/", import.meta.url));
const sources = ["code", "knowledge", "settings", "sessions", "tasks", "commits"];
async function openDatabase(filename) {
  if ("Bun" in globalThis) {
    const { Database } = await import("bun:sqlite");
    return new Database(filename);
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(filename);
}
async function fixture(t) {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "run-"));
  const home = join(root, "home");
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "PIX_ACP_SESSION_MAP"];
  const previous = keys.map(key => process.env[key]);
  const resources = [];
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, "agent"); process.env.PIX_ACP_SESSION_MAP = join(home, "map.json");
  t.after(async () => {
    for (const resource of resources) resource.close();
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await removeDirsWithRetry([root]);
  });
  await mkdir(join(root, ".pi/search"), { recursive: true });
  await mkdir(join(home, ".config/pi"), { recursive: true });
  const policy = join(root, ".pi/search-sources.json");
  await writeFile(policy, JSON.stringify({ version: 1, enabled: Object.fromEntries(sources.map(s => [s, true])) }));
  await writeFile(join(root, ".gitignore"), "home/\n.pi/\n");
  const config = join(home, ".config/pi/pi-tools-suite.jsonc");
  await writeFile(config, "{}");
  const check = async (selected = sources, extra = {}) => (await probeSnapshots(root, {
    operation: "snapshot-probe", sources: selected, settingsDigest: "a".repeat(64), ...extra,
  })).observations;
  return { root, home, policy, config, check, resources };
}

test("content checks detect files/add/remove/rename without creating caches", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.ts"), "export const a=1");
  await writeFile(join(f.root, "a.md"), "docs");
  const first = await f.check(["code", "knowledge"]);
  assert.ok(first.code.source); assert.ok(first.knowledge.source);
  assert.deepEqual(Object.keys(first.code).sort(), ["checkedAt", "index", "indexPresent", "source"]);
  assert.equal(first.code.indexPresent, false);
  assert.equal((await f.check(["code"])).code.source, first.code.source);
  await writeFile(join(f.root, "b.ts"), "export const b=2");
  const added = await f.check(["code", "knowledge"]);
  assert.notEqual(added.code.source, first.code.source);
  assert.equal(added.knowledge.source, first.knowledge.source);
  await rename(join(f.root, "b.ts"), join(f.root, "c.ts"));
  assert.notEqual((await f.check(["code"])).code.source, added.code.source);
  await rm(join(f.root, "c.ts"));
  assert.equal((await f.check(["code"])).code.source, first.code.source);
  await assert.rejects(stat(join(f.root, ".pi/search/code.sqlite")), { code: "ENOENT" });
  await writeFile(join(f.root, ".pi/search/code.sqlite"), "not even a database");
  const cached = await f.check(["code"]);
  assert.ok(cached.code.error); assert.equal(cached.code.source, undefined);
});

test("empty SQLite sidecars from readers do not invalidate an index receipt", async t => {
  const f = await fixture(t);
  const file = join(f.root, ".pi/search/tasks.sqlite");
  await writeFile(file, "stored index");
  const first = (await f.check(["tasks"])).tasks;
  await writeFile(`${file}-wal`, ""); await writeFile(`${file}-journal`, "");
  assert.equal((await f.check(["tasks"])).tasks.index, first.index);
  await writeFile(`${file}-wal`, "committed WAL pages");
  assert.notEqual((await f.check(["tasks"])).tasks.index, first.index);
});

test("published hashes avoid source reads; touch and database maintenance do not change content identity", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.ts"), "export const a=1");
  await writeFile(join(f.root, "a.md"), "# docs");
  await publishLocal(f.root); await publishLocal(f.root, "knowledge");
  const first = await f.check(["code", "knowledge"]);
  assert.equal(first.code.matchesIndex, true); assert.equal(first.knowledge.matchesIndex, true);
  const previous = await readRepositorySnapshot(f.root, "code", signal());
  const scan = () => scanProject(f.root, previous, undefined, signal(), "code", true);
  assert.equal((await scan()).hashedFiles, 0);
  await utimes(join(f.root, "a.ts"), new Date(1000), new Date(1000));
  assert.equal((await scan()).hashedFiles, 1);
  const touched = (await f.check(["code"])).code;
  assert.equal(touched.source, first.code.source); assert.equal(touched.matchesIndex, true);
  await publishLocal(f.root);
  const db = await openDatabase(join(f.root, ".pi/search/code.sqlite"));
  f.resources.push(db);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM");
  const maintained = (await f.check(["code"])).code;
  assert.equal(maintained.source, first.code.source); assert.equal(maintained.index, first.code.index);
  await writeFile(join(f.root, "a.ts"), "export const a=2");
  const changed = await f.check(["code", "knowledge"]);
  assert.equal(changed.code.matchesIndex, false); assert.notEqual(changed.code.source, first.code.source);
  assert.equal(changed.knowledge.source, first.knowledge.source);
  await writeFile(join(f.root, "a.ts"), "export const a=1");
  assert.equal((await f.check(["code"])).code.matchesIndex, true);
});

test("v1 read is non-mutating and additive migration preserves content and vectors", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.ts"), "export const a=1");
  await publishLocal(f.root);
  const vectors = await openVectorStore(f.root);
  const token = vectors.acquire("fixture");
  vectors.put("fixture", token, [{ digest: "a".repeat(64), vector: [1, 0, 0] }], 3);
  vectors.release("fixture", token); vectors.close();
  const db = await openDatabase(join(f.root, ".pi/search/code.sqlite"));
  f.resources.push(db);
  db.exec("DROP TABLE pix_native_stamps; UPDATE pix_native_meta SET version=1");
  const before = await readRepositorySnapshot(f.root, "code", signal());
  assert.equal(before.stamps.size, 0);
  assert.equal((await f.check(["code"])).code.matchesIndex, true);
  assert.equal(db.prepare("SELECT version FROM pix_native_meta").get().version, 1);
  const upgraded = await openStore(f.root); upgraded.close();
  assert.equal(db.prepare("SELECT version FROM pix_native_meta").get().version, 2);
  assert.equal((await readRepositorySnapshot(f.root, "code", signal())).index, before.index);
  await publishLocal(f.root);
  assert.equal(db.prepare("SELECT count(*) AS n FROM vectors").get().n, 1);
  assert.equal((await readRepositorySnapshot(f.root, "code", signal())).index, before.index);
  db.exec("BEGIN IMMEDIATE; DELETE FROM vectors");
  assert.equal((await readRepositorySnapshot(f.root, "code", signal())).index, before.index);
  db.exec("COMMIT");
  assert.notEqual((await readRepositorySnapshot(f.root, "code", signal())).index, before.index);
});

test("Git candidates include dirty, untracked and renamed content but exclude ignored/unsupported files", async t => {
  const f = await fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: f.root, stdio: "pipe" });
  git("init");
  await writeFile(join(f.root, "a.ts"), "export const a=1"); git("add", "a.ts");
  await publishLocal(f.root);
  assert.equal((await f.check(["code"])).code.matchesIndex, true);
  await writeFile(join(f.root, "b.ts"), "export const b=2");
  assert.equal((await f.check(["code"])).code.matchesIndex, false);
  await rm(join(f.root, "b.ts"));
  await writeFile(join(f.root, ".gitignore"), "home/\n.pi/\nb.ts\n");
  await writeFile(join(f.root, "b.ts"), "ignored");
  await writeFile(join(f.root, "binary.ts"), Buffer.alloc(10));
  await writeFile(join(f.root, "oversized.ts"), Buffer.alloc(2 * 1024 * 1024));
  await symlink(join(f.root, "a.ts"), join(f.root, "linked.ts"));
  assert.equal((await f.check(["code"])).code.matchesIndex, true);
  await rename(join(f.root, "a.ts"), join(f.root, "renamed.ts"));
  assert.equal((await f.check(["code"])).code.matchesIndex, false);
});

test("cached hash reuse retains the end-of-scan edit fence and cancellation", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.ts"), "export const a=1"); await publishLocal(f.root);
  const previous = await readRepositorySnapshot(f.root, "code", signal());
  const cached = previous.stamps.get("a.ts");
  previous.stamps.get = () => { writeFileSync(join(f.root, "a.ts"), "export const a=changed"); return cached; };
  const scan = await scanProject(f.root, previous, undefined, signal(), "code", true);
  assert.equal(scan.complete, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readRepositorySnapshot(f.root, "code", controller.signal));
});

test("effective embedding identity fences receipts without treating formatting as content change", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.ts"), "export const a=1"); await publishLocal(f.root);
  const embedding = { embeddingProvider: "openrouter", embeddingModel: "fixture/model-one", vectorSize: 3 };
  await writeFile(f.config, JSON.stringify({ search: { embedding } }));
  const before = (await f.check(["code"])).code;
  await writeFile(f.config, JSON.stringify({ search: { embedding } }, null, 2));
  assert.equal((await f.check(["code"])).code.source, before.source);
  embedding.embeddingModel = "fixture/model-two";
  await writeFile(f.config, JSON.stringify({ search: { embedding } }));
  const after = (await f.check(["code"])).code;
  assert.notEqual(after.source, before.source); assert.notEqual(after.index, before.index);
  assert.equal(after.matchesIndex, true);
});

test("repository probes reject unsupported schema and recursive views without executing them", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.ts"), "export const a=1"); await publishLocal(f.root);
  const db = await openDatabase(join(f.root, ".pi/search/code.sqlite"));
  f.resources.push(db);
  db.exec("UPDATE pix_native_meta SET version=99");
  await assert.rejects(readRepositorySnapshot(f.root, "code", signal()), /identity/);
  db.exec("UPDATE pix_native_meta SET version=2; DROP TABLE pix_native_stamps; CREATE VIEW pix_native_stamps AS SELECT * FROM pix_native_stamps");
  await assert.rejects(readRepositorySnapshot(f.root, "code", signal()), /schema/);
  assert.ok((await f.check(["code"])).code.error);
});

test("settings catalogue/configuration and invalid task stores have independent signatures", async t => {
  const f = await fixture(t), first = await f.check(["settings", "tasks"]);
  const settings = await f.check(["settings"], { settingsDigest: "b".repeat(64) });
  assert.notEqual(settings.settings.source, first.settings.source);
  await writeFile(join(f.root, ".pi/tasks.sqlite"), "task-store");
  assert.ok(first.tasks.source);
  assert.ok((await f.check(["tasks"])).tasks.error);
  // A configuration file edit without an embedding identity change is not a source change.
  await writeFile(f.config, "{ /* comment only */ }");
  assert.equal((await f.check(["settings"])).settings.source, first.settings.source);
  await writeFile(f.config, JSON.stringify({ search: { embedding: { embeddingProvider: "openrouter", embeddingModel: "fixture/model", vectorSize: 3 } } }));
  assert.notEqual((await f.check(["settings"])).settings.source, first.settings.source);
});

test("non-repository sources report writer-recorded coverage via matchesIndex", async t => {
  const f = await fixture(t);
  const { coverageDigest, recordCoverage, COVERAGE_KEEP } = await import("../src/project-search/source-coverage.mjs");
  const file = join(f.root, ".pi/search/tasks.sqlite");
  const db = await openDatabase(file);
  f.resources.push(db);
  db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const absent = (await f.check(["tasks"])).tasks;
  assert.equal(absent.matchesIndex, undefined); // No coverage table: legacy receipt comparison.
  recordCoverage(db, "0".repeat(64), COVERAGE_KEEP.tasks);
  assert.equal((await f.check(["tasks"])).tasks.matchesIndex, false);
  recordCoverage(db, coverageDigest("tasks", "absent", null), COVERAGE_KEEP.tasks);
  const covered = (await f.check(["tasks"])).tasks;
  assert.equal(covered.matchesIndex, true);
  assert.equal(covered.source, coverageDigest("tasks", "absent", null));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pix_source_coverage").get().n, 1); // keep=1 prunes older digests.
});

test("Tasks revision ignores checkpoint, VACUUM and positions but tracks committed rows", async t => {
  const f = await fixture(t);
  const db = await openDatabase(join(f.root, ".pi/tasks.sqlite"));
  f.resources.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0)");
  const revision = async () => {
    const result = (await f.check(["tasks"])).tasks;
    assert.ok(result.source, result.error);
    return result.source;
  };
  const empty = await revision();
  db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?)").run("one", '{"title":"one"}');
  const added = await revision(); assert.notEqual(added, empty);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal(await revision(), added);
  db.exec("VACUUM");
  assert.equal(await revision(), added);
  db.exec("UPDATE tasks SET position=42");
  assert.equal(await revision(), added);
  db.exec("BEGIN IMMEDIATE; UPDATE tasks SET revision=2");
  assert.equal(await revision(), added); // Reader sees committed state, not pending edits.
  db.exec("COMMIT");
  const edited = await revision(); assert.notEqual(edited, added);
  db.prepare("UPDATE tasks SET payload=?").run('{"title":"changed"}');
  assert.notEqual(await revision(), edited);
  db.exec("DELETE FROM tasks");
  assert.equal(await revision(), empty);
});

test("Tasks rejects unsupported schemas and views without executing them", async t => {
  const f = await fixture(t);
  const db = await openDatabase(join(f.root, ".pi/tasks.sqlite"));
  f.resources.push(db);
  db.exec("PRAGMA user_version=2");
  assert.ok((await f.check(["tasks"])).tasks.error);
  db.exec("PRAGMA user_version=1; CREATE VIEW tasks AS SELECT * FROM tasks");
  assert.ok((await f.check(["tasks"])).tasks.error);
});

test("session probes use bounded map metadata and never parse transcript bodies", async t => {
  const f = await fixture(t);
  const file = join(f.home, "2020-01-01T00-00-00-000Z_session.jsonl");
  await writeFile(file, "This is not valid JSONL; metadata checks must not parse it.");
  const record = { sessionId: "a", piSessionId: "b", cwd: f.root, piSessionPath: file, namedTitle: "before" };
  await writeFile(process.env.PIX_ACP_SESSION_MAP, JSON.stringify({ version: 1, sessions: [record] }));
  const first = (await f.check(["sessions"])).sessions; assert.ok(first.source);
  await writeFile(file, "edited transcript");
  assert.notEqual((await f.check(["sessions"])).sessions.source, first.source);
  const second = (await f.check(["sessions"])).sessions;
  await writeFile(process.env.PIX_ACP_SESSION_MAP, JSON.stringify({ version: 1, sessions: [{ ...record, namedTitle: "after" }] }));
  assert.notEqual((await f.check(["sessions"])).sessions.source, second.source);
  assert.equal(await readFile(file, "utf8"), "edited transcript");
});

test("probe diagnostics distinguish known failures without exposing raw paths", async t => {
  const f = await fixture(t);
  await writeFile(process.env.PIX_ACP_SESSION_MAP, JSON.stringify({ version: 2, sessions: [] }));
  assert.equal((await f.check(["sessions"])).sessions.error, "Invalid session map");
  await writeFile(process.env.PIX_ACP_SESSION_MAP, "not JSON with private text");
  assert.equal((await f.check(["sessions"])).sessions.error, "Cheap change check unavailable, incomplete, or source disabled");
  const controller = new AbortController(); controller.abort();
  const reply = await probeSnapshots(f.root, { operation: "snapshot-probe", sources: ["sessions"] }, controller.signal);
  assert.equal(reply.observations.sessions.error, "Metadata check timed out or was cancelled");
});

test("commits compare HEAD without scanning log history; detached HEAD works", async t => {
  const f = await fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: f.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  assert.ok((await f.check(["commits"])).commits.error); // Unborn is not invented coverage.
  git("commit", "--allow-empty", "-m", "one");
  const first = (await f.check(["commits"])).commits; assert.ok(first.source);
  git("commit", "--allow-empty", "-m", "two");
  const second = (await f.check(["commits"])).commits; assert.notEqual(second.source, first.source);
  git("checkout", "--detach", "HEAD");
  assert.equal((await f.check(["commits"])).commits.source, second.source);
});

test("disabled, malformed, and aborted probes never return a fresh signature", async t => {
  const f = await fixture(t);
  await writeFile(f.policy, JSON.stringify({ version: 1, enabled: Object.fromEntries(sources.map(s => [s, false])) }));
  await writeSourcePolicy(f.root, "settings", false);
  const disabled = await f.check();
  for (const value of Object.values(disabled)) { assert.ok(value.error); assert.equal(value.source, undefined); }
  await assert.rejects(f.check(["invented"]));
  await writeFile(f.policy, "malformed");
  assert.ok((await f.check(["code"])).code.error);
  const controller = new AbortController(); controller.abort();
  const aborted = await probeSnapshots(f.root, { operation: "snapshot-probe", sources: ["tasks"] }, controller.signal);
  assert.ok(aborted.observations.tasks.error);
});

test("native CLI exposes the diagnostic operation without creating an index", async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL("../src/project-search/native-cli.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [cli, f.root], {
    input: JSON.stringify({ operation: "snapshot-probe", sources: ["settings"], settingsDigest: "a".repeat(64) }),
    encoding: "utf8", timeout: 8000,
  });
  assert.ok(JSON.parse(output).observations.settings.source);
  await assert.rejects(stat(join(f.root, ".pi/search/settings.sqlite")), { code: "ENOENT" });
});
