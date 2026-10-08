import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, open, readFile, rename, rm, rmdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "jsonc-parser";
import { publishAtomically, SearchPreferences } from "../src/search/config.js";

async function fixture(t: TestContext) {
  const artifacts = fileURLToPath(new URL("../../.pi/artifacts/search-preferences-tests/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config", "pix-desktop.jsonc");
  return { root, path, preferences: new SearchPreferences(path) };
}

test("consent writes preserve JSONC comments and unrelated native settings", async t => {
  const { path, preferences } = await fixture(t);
  await mkdir(dirname(path));
  await writeFile(path, '{\n  // Keep authored comments.\n  "visibleModels": ["native/model"],\n  "search": { "legacyUnknown": 42 },\n}\n');
  await preferences.setEnabled(true);
  const saved = await readFile(path, "utf8");
  assert.ok(saved.includes("// Keep authored comments."));
  assert.deepEqual(parse(saved), { visibleModels: ["native/model"], search: { legacyUnknown: 42, semanticEnabled: true } });
  await preferences.setEnabled(false);
  assert.equal(await preferences.enabled(), false);
  assert.equal(parse(await readFile(path, "utf8")).search.legacyUnknown, 42);
  await assert.rejects(stat(`${path}.search.lock`), { code: "ENOENT" });
});

test("session title consent is an independent, opt-in JSONC flag", async t => {
  const { path, preferences } = await fixture(t);
  assert.equal(await preferences.sessionTitlesEnabled(), false);
  assert.equal(await preferences.enabled(), false);
  await preferences.setSessionTitlesEnabled(true);
  assert.equal(await preferences.sessionTitlesEnabled(), true);
  assert.equal(await preferences.enabled(), false);
  await preferences.setEnabled(true);
  await preferences.setSessionTitlesEnabled(false);
  assert.equal(await preferences.enabled(), true);
  assert.equal(await preferences.sessionTitlesEnabled(), false);
  const document = parse(await readFile(path, "utf8"));
  assert.deepEqual(document, { search: { sessionTitlesEnabled: false, semanticEnabled: true } });
  await assert.rejects(stat(`${path}.search.lock`), { code: "ENOENT" });
});

test("native mkdir ownership is respected even with an old mtime; consent rereads after release", async t => {
  const { path, preferences } = await fixture(t);
  await mkdir(dirname(path));
  const original = '{ "search": { "semanticEnabled": true } }\n';
  await writeFile(path, original);
  // This is precisely native UserConfigFileLock's ownership operation. No
  // heartbeat is needed: time alone cannot establish that its owner exited.
  const lockPath = `${path}.search.lock`;
  await mkdir(lockPath);
  await utimes(lockPath, new Date(0), new Date(0));
  await assert.rejects(preferences.setEnabled(false), /config busy or unavailable/);
  assert.equal(await readFile(path, "utf8"), original);
  assert.ok((await stat(lockPath)).isDirectory());
  assert.equal((await stat(lockPath)).mtimeMs, 0);

  // Native publishes an unrelated edit while owning the shared lock, then
  // releases. A subsequent ACP write must modify that fresh document.
  const native = '{\n // Native edit survives.\n "theme": "dark", "search": { "semanticEnabled": true }\n}\n';
  await writeFile(`${path}.native.tmp`, native);
  await rename(`${path}.native.tmp`, path);
  await rmdir(lockPath);
  await preferences.setEnabled(false);
  const saved = await readFile(path, "utf8");
  assert.ok(saved.includes("// Native edit survives."));
  assert.deepEqual(parse(saved), { theme: "dark", search: { semanticEnabled: false } });
});

test("failed JSONC updates release ownership without replacing the source", async t => {
  const { path, preferences } = await fixture(t);
  await mkdir(dirname(path));
  await writeFile(path, "{ malformed private source");
  await assert.rejects(preferences.setEnabled(true), /Search preferences could not be saved/);
  assert.equal(await readFile(path, "utf8"), "{ malformed private source");
  await assert.rejects(stat(`${path}.search.lock`), { code: "ENOENT" });
  await writeFile(path, "{}\n");
  await preferences.setEnabled(true);
  assert.equal(await preferences.enabled(), true);
});

test("a missing config and symlinked parent share the same native lock namespace", async t => {
  const { root, path } = await fixture(t);
  await mkdir(dirname(path));
  const alias = join(root, "alias");
  await symlink(dirname(path), alias, "dir");
  const preferences = new SearchPreferences(join(alias, "pix-desktop.jsonc"));
  assert.equal(await preferences.enabled(), false);
  await mkdir(`${path}.search.lock`);
  await assert.rejects(preferences.setEnabled(true), /config busy or unavailable/);
  await assert.rejects(stat(path), { code: "ENOENT" });
  await rmdir(`${path}.search.lock`);
  await preferences.setEnabled(true);
  assert.equal(parse(await readFile(path, "utf8")).search.semanticEnabled, true);
});

test("atomic publish retries transient rename contention and fails on real errors", async () => {
  const contention = (code: string) => Object.assign(new Error(`operation failed: ${code}`), { code });
  let calls = 0;
  await publishAtomically("from", "to", async () => { if (++calls < 3) throw contention("EPERM"); });
  assert.equal(calls, 3);
  await assert.rejects(publishAtomically("from", "to", async () => { throw contention("ENOENT"); }), /ENOENT/);
  let persistent = 0;
  await assert.rejects(publishAtomically("from", "to", async () => { persistent++; throw contention("EACCES"); }), /EACCES/);
  assert.equal(persistent, 21);
});

test("consent updates tolerate a concurrent reader holding the config open", async t => {
  const { path, preferences } = await fixture(t);
  await mkdir(dirname(path));
  await writeFile(path, '{ "search": { "semanticEnabled": true } }\n');
  // Mirrors an in-flight consent check re-reading the document while a config
  // update publishes: on Windows the open handle blocks rename until released.
  // Real readers close within the bounded retry budget, so release promptly.
  const held = await open(path, "r");
  const releasing = delay(100).then(() => held.close());
  try {
    await preferences.setEnabled(false);
    assert.equal(await preferences.enabled(), false);
  } finally { await releasing.catch(() => {}); await held.close().catch(() => {}); }
  assert.deepEqual(parse(await readFile(path, "utf8")), { search: { semanticEnabled: false } });
  await assert.rejects(stat(`${path}.search.lock`), { code: "ENOENT" });
});
