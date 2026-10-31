import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeKnowledgeSearch } from "../src/knowledge/native-search.js";
import type { KnowledgeSearch, KnowledgeSearchResult } from "../src/knowledge/evidence.js";

const artifactRoot = fileURLToPath(new URL("../../.pi/artifacts/", import.meta.url));
const request: Parameters<KnowledgeSearch>[1] = {
  query: "Retry policy — повторы café 📚", sources: ["knowledge"], mode: "hybrid",
  pathPrefix: "handbook/product", limit: 12, includeContent: false, dedupeFile: true,
};
const response: KnowledgeSearchResult = {
  hits: [{ kind: "knowledge", path: "handbook/product/политика.md", startLine: 3, endLine: 7 }],
  notices: ["Проверено 📚 café"],
  limitNotices: [],
  status: { complete: true, completeForSelection: true, stale: false, semanticEnabled: true, semantic: { enabled: true, complete: true, state: "ready" } },
};

async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Stub search did not settle promptly")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const pid = Number(await readFile(path, "utf8"));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const pid = await readPid(path);
    if (pid !== undefined) return pid;
    await delay(10);
  }
  throw new Error("Stub search process did not start");
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (alive(pid) && Date.now() < deadline) await delay(10);
  assert.equal(alive(pid), false, "The cancelled search process must exit");
}

async function fixture(t: TestContext, body: string, longRunning = false) {
  await mkdir(artifactRoot, { recursive: true });
  const root = await realpath(await mkdtemp(join(artifactRoot, "knowledge-native-search-")));
  const cwd = join(root, "target project"), agentDir = join(root, "agent data");
  const extension = join(agentDir, "extensions", "pi-tools-suite");
  const entry = join(extension, "index.ts"), script = join(extension, "src", "project-search", "native-cli.mjs");
  const pidFile = join(cwd, "worker.pid");
  t.after(async () => {
    // Only these deliberately persistent fixture processes can need cleanup after a failed assertion.
    if (longRunning) {
      const pid = await readPid(pidFile);
      if (pid !== undefined && alive(pid)) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await waitForExit(pid);
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(cwd, { recursive: true });
  await mkdir(join(extension, "src", "project-search"), { recursive: true });
  await writeFile(entry, "// Fixture extension entry\n");
  await writeFile(script, `
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
setTimeout(() => process.exit(88), 5_000).unref();
await writeFile("worker.pid", String(process.pid));
process.stdin.setEncoding("utf8");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
${body}
`);
  return { cwd, agentDir, extension, entry, script, pidFile };
}

test("native search forwards the hybrid Knowledge request and target cwd through each extension location", async t => {
  const f = await fixture(t, `
await writeFile("received.json", JSON.stringify({ request, cwd: process.cwd(), args: process.argv.slice(2), script: process.argv[1] }));
process.stdout.end(JSON.stringify(${JSON.stringify(response)}));
`);
  for (const extension of [f.extension, f.entry, undefined]) {
    const search = createNativeKnowledgeSearch(extension, f.agentDir);
    assert.deepEqual(await within(search(f.cwd, request, new AbortController().signal)), response);
    assert.deepEqual(JSON.parse(await readFile(join(f.cwd, "received.json"), "utf8")), {
      request, cwd: f.cwd, args: [f.cwd], script: f.script,
    });
  }
});

test("native search preserves Unicode when stdout splits inside multibyte characters", async t => {
  const f = await fixture(t, `
const bytes = Buffer.from(JSON.stringify(${JSON.stringify(response)}));
const emoji = bytes.indexOf(Buffer.from("📚"));
const cuts = [bytes.indexOf(Buffer.from("п")) + 1, emoji + 1, emoji + 2, emoji + 3];
let offset = 0;
for (const end of cuts) {
  await new Promise(resolve => process.stdout.write(bytes.subarray(offset, end), resolve));
  offset = end;
  await delay(20);
}
process.stdout.end(bytes.subarray(offset));
`);
  const result = await within(createNativeKnowledgeSearch(f.extension, f.agentDir)(f.cwd, request, new AbortController().signal));
  assert.deepEqual(result, response);
});

test("native search rejects malformed, invalid-shape and unsuccessful CLI responses", async t => {
  const cases = [
    { name: "malformed JSON", body: 'process.stdout.end("not JSON");', error: /JSON|Unexpected/u },
    { name: "invalid hits", body: 'process.stdout.end(JSON.stringify({ hits: {}, notices: [], status: { complete: true, stale: false } }));', error: /Invalid Wiki search response/u },
    { name: "invalid status", body: 'process.stdout.end(JSON.stringify({ hits: [], notices: [], status: { complete: "true", stale: false } }));', error: /Invalid Wiki search response/u },
    { name: "invalid selection status", body: 'process.stdout.end(JSON.stringify({ hits: [], notices: [], status: { complete: false, completeForSelection: "true", stale: false } }));', error: /Invalid Wiki search response/u },
    { name: "invalid limit notices", body: 'process.stdout.end(JSON.stringify({ hits: [], notices: [], limitNotices: [3], status: { complete: true, stale: false } }));', error: /Invalid Wiki search response/u },
    { name: "nonzero exit", body: `process.stdout.end(JSON.stringify(${JSON.stringify(response)})); process.exitCode = 7;`, error: /unavailable/u },
  ];
  for (const candidate of cases) await t.test(candidate.name, async child => {
    const f = await fixture(child, candidate.body);
    await assert.rejects(within(createNativeKnowledgeSearch(f.extension, f.agentDir)(f.cwd, request, new AbortController().signal)), candidate.error);
  });
});

test("native search enforces its byte output budget and stops a still-running CLI", async t => {
  const f = await fixture(t, 'process.stdout.write("Ж".repeat(262_145)); setInterval(() => {}, 1_000);', true);
  await assert.rejects(within(createNativeKnowledgeSearch(f.extension, f.agentDir)(f.cwd, request, new AbortController().signal)), /output budget/u);
  await waitForExit(await waitForPid(f.pidFile));
});

test("native search cancellation rejects promptly before startup, immediately and during a live child", async t => {
  for (const timing of ["before", "immediate", "running"] as const) await t.test(timing, async child => {
    const f = await fixture(child, "setInterval(() => {}, 1_000);", true);
    const controller = new AbortController(), reason = new Error(`cancelled ${timing}`);
    // An already aborted request must win even over a nonexistent extension path.
    const extension = timing === "before" ? join(f.extension, "missing") : f.extension;
    if (timing === "before") controller.abort(reason);
    const pending = createNativeKnowledgeSearch(extension, f.agentDir)(f.cwd, request, controller.signal);
    void pending.catch(() => {});
    let pid: number | undefined;
    if (timing === "running") pid = await waitForPid(f.pidFile);
    if (timing !== "before") controller.abort(reason);
    await assert.rejects(within(pending), error => error === reason);
    if (pid !== undefined) await waitForExit(pid);
  });
});
