import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { NativeSessionCatalog, sessionDirectoryRevision } from "../src/acp/native-session-catalog.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("native session catalog coalesces slow scans, skips unchanged revisions and republishes changes", async () => {
  let version = "one";
  let scans = 0;
  const start = deferred();
  const release = deferred();
  const notified = deferred();
  const errors: unknown[] = [];
  const catalog = new NativeSessionCatalog(async (_cwd, signal) => {
    scans += 1;
    if (scans === 1) { start.resolve(); await release.promise; }
    signal.throwIfAborted();
  }, (error) => errors.push(error), async () => version);
  try {
    const notifications: string[] = [];
    catalog.refresh("/first", () => { notifications.push("a"); notified.resolve(); });
    await start.promise;
    catalog.refresh("/first", () => notifications.push("b"));
    assert.equal(scans, 1, "duplicate callers share the active full scan");
    assert.equal(notifications.length, 0);
    release.resolve();
    await notified.promise;
    assert.equal(notifications.join(","), "a,b");
    await nextTurn();

    catalog.refresh("/first", () => notifications.push("unchanged"));
    await nextTurn();
    assert.equal(scans, 1);
    assert.equal(notifications.join(","), "a,b");

    version = "two";
    const changed = deferred();
    catalog.refresh("/first", () => { notifications.push("changed"); changed.resolve(); });
    await changed.promise;
    assert.equal(scans, 2);
    assert.equal(notifications.join(","), "a,b,changed");
    assert.deepEqual(errors, []);
  } finally {
    await catalog.dispose();
  }
});

test("failure does not poison the last successful revision, and disposal cancels delayed scan", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const changed = deferred();
  const catalog = new NativeSessionCatalog(async () => {
    if (++calls === 1) throw new Error("snapshot temporarily unavailable");
  }, (error) => errors.push(error), async () => "stable");
  catalog.refresh("/one", () => assert.fail("failed scan must not notify"));
  await nextTurn();
  assert.equal(errors.length, 1);
  catalog.refresh("/one", () => changed.resolve());
  await changed.promise;
  assert.equal(calls, 2, "failed scans are retried even when the signature is unchanged");
  await catalog.dispose();

  const blocked = deferred();
  const aborted = deferred();
  let notifications = 0;
  const pending = new NativeSessionCatalog(async (_, signal) => {
    blocked.resolve();
    await new Promise<void>((resolveAbort) => {
      if (signal.aborted) { resolveAbort(); return; }
      signal.addEventListener("abort", () => { aborted.resolve(); resolveAbort(); }, { once: true });
    });
    signal.throwIfAborted();
  }, () => assert.fail("aborting a scan must not report failure"), async () => "one");
  pending.refresh("/two", () => notifications++);
  await blocked.promise;
  await pending.dispose();
  await aborted.promise;
  pending.refresh("/two", () => notifications++);
  assert.equal(notifications, 0);
});

test("a session growing during discovery does not trigger an immediate second scan", async () => {
  let revision = "before";
  let scans = 0;
  const scanStarted = deferred();
  const release = deferred();
  const updated = deferred();
  const catalog = new NativeSessionCatalog(async () => {
    scans++;
    scanStarted.resolve();
    await release.promise;
  }, error => assert.fail(String(error)), async () => revision);
  try {
    catalog.refresh("/project", () => updated.resolve());
    await scanStarted.promise;
    revision = "after"; // a JSONL append happens while its directory is scanned
    release.resolve();
    await updated.promise;
    catalog.refresh("/project", () => assert.fail("post-scan revision already reconciled"));
    await nextTurn();
    assert.equal(scans, 1);
  } finally {
    await catalog.dispose();
  }
});

test("catalog fingerprint detects file creation, rename, and content modification by metadata", async (t) => {
  const root = resolve(import.meta.dirname, "../../.pi/artifacts");
  await mkdir(root, { recursive: true });
  const agentDir = await mkdtemp(join(root, "native-revision-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const cwd = "/test/catalog-project";
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  const empty = await sessionDirectoryRevision(cwd, agentDir);
  await mkdir(sessionDir, { recursive: true });
  assert.equal(await sessionDirectoryRevision(cwd, agentDir), empty);
  const file = join(sessionDir, "a.jsonl");
  await writeFile(file, '{"type":"session"}\n');
  const created = await sessionDirectoryRevision(cwd, agentDir);
  assert.notEqual(created, empty);
  assert.equal(await sessionDirectoryRevision(cwd, agentDir), created);
  await writeFile(file, '{"type":"session","id":"two"}\n');
  const edited = await sessionDirectoryRevision(cwd, agentDir);
  assert.notEqual(edited, created);
  await utimes(file, new Date(), new Date());
  assert.equal((await sessionDirectoryRevision(cwd, agentDir)).length, 64);
  await writeFile(join(sessionDir, "b.jsonl"), "{}\n");
  assert.notEqual(await sessionDirectoryRevision(cwd, agentDir), edited);
});
