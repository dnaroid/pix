import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, utimes, lstat, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { DEFAULT_SEARCH_SOURCES, readSourcePolicy, writeSourcePolicy } from "../src/search/source-policy.js";
import { removeDirsWithRetry } from "../../external/pi-tools-suite/test/support/fs-retry.mjs";

const hosts = {
  ACP: new URL("../src/search/source-policy.js", import.meta.url).href,
  suite: new URL("../../external/pi-tools-suite/src/project-search/source-policy.mjs", import.meta.url).href,
};
const childScript = fileURLToPath(new URL("./fixtures/source-policy-writer.mjs", import.meta.url));

async function fixture(t: TestContext) {
  const base = fileURLToPath(new URL("../../.pi/artifacts/source-policy-lock-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "run-"));
  await mkdir(join(root, ".pi"));
  const file = join(root, ".pi/search-sources.json"), lock = file + ".lock";
  const original = JSON.stringify({ version: 1, enabled: DEFAULT_SEARCH_SOURCES });
  await writeFile(file, original);
  const children: Array<{ process: ChildProcess; finished: Promise<void> }> = [];
  t.after(async () => {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
    }
    await Promise.allSettled(children.map(child => child.finished));
    await removeDirsWithRetry([root]);
  });
  function launch(host: keyof typeof hosts, source: string, enabled: boolean, phase = "none") {
    const child = fork(childScript, [hosts[host], root, source, String(enabled), phase], {
      execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "", closed = false;
    const seen = new Set<string>();
    const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
    child.stderr!.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-4000); });
    child.on("message", (message: { event: string; message?: string }) => {
      if (message.event === "error") stderr += message.message;
      seen.add(message.event);
      pending.get(message.event)?.resolve();
      pending.delete(message.event);
    });
    const finished = new Promise<void>((resolve, reject) => {
      child.once("error", error => {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear(); reject(error);
      });
      child.once("close", () => {
        closed = true;
        for (const waiter of pending.values()) waiter.reject(new Error(`Writer closed before its barrier: ${stderr}`));
        pending.clear(); resolve();
      });
    });
    void finished.catch(() => {});
    children.push({ process: child, finished });
    return {
      child, finished,
      wait(event: string) {
        if (seen.has(event)) return Promise.resolve();
        if (closed) return Promise.reject(new Error(`Writer already closed: ${stderr}`));
        return new Promise<void>((resolve, reject) => pending.set(event, { resolve, reject }));
      },
    };
  }
  return { root, file, lock, original, launch };
}

for (const host of ["ACP", "suite"] as const) for (const phase of ["before", "after"] as const) {
  test(`${host}: crash ${phase} policy rename releases ownership for two competing successors`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const old = f.launch(host, "code", false, phase);
    await old.wait("barrier");
    assert.equal((await readSourcePolicy(f.root)).enabled.code, phase === "before");
    old.child.kill("SIGKILL");
    await old.finished;
    const tasks = f.launch("ACP", "tasks", true), knowledge = f.launch("suite", "knowledge", true);
    await Promise.all([tasks.wait("done"), knowledge.wait("done"), tasks.finished, knowledge.finished]);
    const policy = await readSourcePolicy(f.root);
    assert.equal(policy.enabled.code, phase === "before");
    assert.equal(policy.enabled.tasks, true);
    assert.equal(policy.enabled.knowledge, true);
    assert.equal(policy.error, undefined);
  });
}

test("a live writer is never stolen by age; reads stay available and retry preserves both edits", { timeout: 15000 }, async t => {
  const f = await fixture(t), owner = f.launch("suite", "tasks", true, "before");
  await owner.wait("barrier");
  if (process.platform !== "win32") owner.child.kill("SIGSTOP");
  await utimes(f.lock, new Date(0), new Date(0));
  await assert.rejects(writeSourcePolicy(f.root, "knowledge", true), /busy.*retry/i);
  assert.equal(await readFile(f.file, "utf8"), f.original);
  if (process.platform !== "win32") owner.child.kill("SIGCONT");
  owner.child.send("continue");
  await owner.wait("done"); await owner.finished;
  await writeSourcePolicy(f.root, "knowledge", true);
  assert.equal((await readSourcePolicy(f.root)).enabled.tasks, true);
  assert.equal((await readSourcePolicy(f.root)).enabled.knowledge, true);
});

test("an interrupted lock-directory initialization and later callback failures do not strand ownership", async t => {
  const f = await fixture(t);
  await mkdir(f.lock);
  await writeSourcePolicy(f.root, "tasks", true);
  assert.equal((await lstat(f.lock)).isDirectory(), true);
  await writeFile(f.file, "malformed");
  await assert.rejects(writeSourcePolicy(f.root, "knowledge", true), /policy unavailable/);
  await writeFile(f.file, f.original);
  await writeSourcePolicy(f.root, "knowledge", true);
  const before = await readSourcePolicy(f.root);
  await writeSourcePolicy(f.root, "knowledge", true);
  assert.equal((await readSourcePolicy(f.root)).revision, before.revision, "no-op saves preserve the JSON revision");
});

test("simultaneous first saves create the policy parent once and retain both source selections", { timeout: 15000 }, async t => {
  const f = await fixture(t), root = join(f.root, "fresh");
  await mkdir(root);
  const suite = await import(hosts.suite) as { writeSourcePolicy: typeof writeSourcePolicy };
  await Promise.all([writeSourcePolicy(root, "tasks", true), suite.writeSourcePolicy(root, "knowledge", true)]);
  const policy = await readSourcePolicy(root);
  assert.equal(policy.enabled.tasks, true);
  assert.equal(policy.enabled.knowledge, true);
  assert.equal(policy.error, undefined);
  await assert.rejects(lstat(join(root, ".pi/search")), { code: "ENOENT" }, "selection must not create embedding stores");
});

test("the permanent lock directory prevents an older O_EXCL writer from entering", async t => {
  const f = await fixture(t);
  await writeSourcePolicy(f.root, "tasks", true);
  await assert.rejects(writeFile(f.lock, "", { flag: "wx" }), { code: "EEXIST" });
  assert.equal((await readSourcePolicy(f.root)).enabled.tasks, true);
});

test("an ownerless legacy lock is preserved, with explicit offline-recovery guidance", async t => {
  const f = await fixture(t);
  await writeFile(f.lock, "");
  await utimes(f.lock, new Date(0), new Date(0));
  await assert.rejects(writeSourcePolicy(f.root, "tasks", true), /legacy.*lock.*close/i);
  assert.equal(await readFile(f.lock, "utf8"), "");
  assert.equal(await readFile(f.file, "utf8"), f.original);
  assert.equal((await readSourcePolicy(f.root)).error, undefined);
});

for (const kind of ["directory", "database", "hardlink", "sidecar"] as const) {
  test(`unsafe ${kind} lock storage never redirects a source-policy write`, async t => {
    const f = await fixture(t), outside = join(f.root, "outside");
    await mkdir(outside);
    const target = join(outside, "target");
    await writeFile(target, "untouched");
    if (kind === "directory") await symlink(outside, f.lock, process.platform === "win32" ? "junction" : "dir");
    else {
      await mkdir(f.lock);
      const destination = join(f.lock, "writer.sqlite") + (kind === "sidecar" ? "-journal" : "");
      if (kind === "hardlink") await link(target, destination);
      else await symlink(target, destination);
    }
    await assert.rejects(writeSourcePolicy(f.root, "tasks", true));
    assert.equal(await readFile(target, "utf8"), "untouched");
    assert.equal(await readFile(f.file, "utf8"), f.original);
  });
}
