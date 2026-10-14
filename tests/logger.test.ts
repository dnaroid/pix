import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { getPixLogPath, installPixProcessLogging, PixFileLogger, PIX_LOG_RETENTION_MS, withPixLogContext } from "../src/app/logger.js";

async function fixture(test: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pix-logs-"));
  try { await test(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function records(directory: string): Promise<Record<string, any>[]> {
  const paths = (await readdir(directory)).filter(name => name.endsWith(".jsonl"));
  const lines = await Promise.all(paths.map(name => readFile(join(directory, name), "utf8")));
  return lines.flatMap(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

describe("unified JSONL diagnostics", () => {
	it("publishes a scoped in-process suite sink and restores its predecessor on teardown", async () => fixture(async directory => {
		const symbol = Symbol.for("pix.diagnostics.sink");
		const registry = globalThis as Record<symbol, unknown>;
		const before = registry[symbol];
		const logger = new PixFileLogger({ directory });
		const stop = installPixProcessLogging({}, logger);
		try {
			const sink = registry[symbol] as (level: string, event: string, details: object, scope: object) => void;
			assert.equal(typeof sink, "function");
			sink("warn", "suite:module-load-failed", { count: 2 }, { project: "/projects/suite", module: "suite.loader" });
			await logger.flush();
			const [record] = await records(directory);
			assert.equal(record?.event, "suite:module-load-failed");
			assert.equal(record?.module, "suite.loader");
			assert.equal(record?.project?.path, "/projects/suite");
		} finally {
			stop();
		}
		assert.equal(registry[symbol], before);
	}));
  it("uses the shared log directory", () => {
    assert.equal(getPixLogPath("/home/test"), join("/home/test", ".config", "pi", "logs"));
  });
  it("snapshots project context across concurrent operations and defaults globals to null", async () => fixture(async directory => {
    const logger = new PixFileLogger({ directory });
    const first = withPixLogContext({ project: "/projects/first", sessionId: "s1" }, async () => {
      await Promise.resolve();
      await logger.log("warn", "first", {}, { module: "worker" });
    });
    const second = withPixLogContext({ project: "/other/second", sessionId: "s2" }, () => logger.info("second"));
    await Promise.all([first, second]);
    await logger.info("global");
    await logger.debug("hidden");
    const rows = await records(directory);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.find(row => row.event === "first")?.project, { name: "first", path: "/projects/first" });
    assert.equal(rows.find(row => row.event === "first")?.module, "worker");
    assert.equal(rows.find(row => row.event === "first")?.sessionId, "s1");
    assert.deepEqual(rows.find(row => row.event === "second")?.project, { name: "second", path: "/other/second" });
    assert.equal(rows.find(row => row.event === "global")?.project, null);
  }));
  it("rotates on byte limits, isolates writers and never interleaves JSON", async () => fixture(async directory => {
    const a = new PixFileLogger({ directory, maxBytes: 1024, maxQueuedBytes: 1024 * 1024 });
    const b = new PixFileLogger({ directory, source: "acp", maxBytes: 1024 });
    await Promise.all(Array.from({ length: 50 }, (_, index) => Promise.all([a.info("a", { index }), b.warn("b", { index })])));
    assert.equal((await records(directory)).length, 100);
    const files = await readdir(directory);
    assert.ok(files.length > 2);
    for (const name of files) {
      const info = await stat(join(directory, name));
      assert.ok(info.size <= 1024, `${name}: ${info.size}`);
      if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
    }
  }));
  it("purges expired native/ACP/backend segments, preserves unrelated files and rotates idle writers", async () => fixture(async directory => {
    let now = PIX_LOG_RETENTION_MS;
    const logger = new PixFileLogger({ directory, now: () => now });
    await logger.info("old");
    await writeFile(join(directory, "pix-v1-0-desktop-123-test-0.jsonl"), "old native\n");
    await writeFile(join(directory, "pix-v1-0-acp-456-test-0.jsonl"), "old acp\n");
    await writeFile(join(directory, "personal.log"), "keep");
    now += PIX_LOG_RETENTION_MS;
    await logger.maintain();
    await logger.info("new");
    assert.deepEqual((await records(directory)).map(row => row.event), ["new"]);
    assert.equal(await readFile(join(directory, "personal.log"), "utf8"), "keep");
  }));
  it("bounds queues and oversized records, supports opt-in debug and redacts structured secrets", async () => fixture(async directory => {
    const logger = new PixFileLogger({ directory, maxBytes: 1024, maxQueuedBytes: 1024, level: "debug" });
    const details: Record<string, unknown> = { token: "private", prompt: "conversation", nested: { password: "bad" }, url: "https://user:secret@host/?key=sensitive" };
    details.cycle = details;
    Object.defineProperty(details, "getter", { enumerable: true, get() { throw new Error("must not invoke"); } });
    await logger.debug("visible", details);
    await Promise.all(Array.from({ length: 100 }, () => logger.info("burst", { text: "x".repeat(4000) })));
    assert.ok(logger.dropped > 0);
    await logger.info("after-overload");
    const rows = await records(directory);
    assert.ok(rows.find(row => row.event === "after-overload")?.dropped > 0);
    const raw = JSON.stringify(rows);
    assert.doesNotMatch(raw, /private|conversation|sensitive|must not invoke/);
    assert.equal(rows[0]?.event, "visible");
    for (const name of await readdir(directory)) assert.ok((await stat(join(directory, name))).size <= 1024);
  }));
  it("rotates hourly even below the byte limit", async () => fixture(async directory => {
    let now = PIX_LOG_RETENTION_MS;
    const logger = new PixFileLogger({ directory, now: () => now });
    await logger.info("before");
    now += 3_600_000;
    await logger.info("after");
    assert.equal((await readdir(directory)).length, 2);
    assert.equal((await records(directory)).length, 2);
  }));
  it("never rejects on unavailable storage and can flush after failure", async () => fixture(async directory => {
    const file = join(directory, "not-a-directory");
    await writeFile(file, "occupied");
    const logger = new PixFileLogger({ directory: file });
    await logger.error("test");
    await logger.flush();
    assert.equal(logger.dropped, 1);
  }));
  it("persists fatal errors before Node exits without suppressing failure", async () => fixture(async directory => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { PixFileLogger, installPixProcessLogging } from './src/app/logger.ts';
      installPixProcessLogging({ project: '/projects/fatal' }, new PixFileLogger({ directory: ${JSON.stringify(directory)} }));
      setImmediate(() => { throw new Error('fatal test'); });
    `], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(child.status, 0, child.stderr);
    const rows = await records(directory);
    assert.equal(rows[0]?.event, "process:uncaught");
    assert.equal(rows[0]?.project.path, "/projects/fatal");
  }));
});
