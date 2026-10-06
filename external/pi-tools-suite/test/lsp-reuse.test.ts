import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LspManager } from "../src/lsp/manager";
import type { LspServerConfig } from "../src/lsp/_shared/types";
import { LSP_IDLE_TIMEOUT_MS, type IdleCleanupOptions } from "../src/lsp/idle-cleanup";
import { ManualLspClock } from "./helpers/manual-lsp-clock";

const managers = new Set<LspManager>();
const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
fs.mkdirSync(artifacts, { recursive: true });
const run = fs.realpathSync(fs.mkdtempSync(path.join(artifacts, "lsp-reuse-tests-")));
let sequence = 0;
const serverCode = String.raw`
const fs = require('node:fs');
fs.appendFileSync(process.argv[2], process.pid+'\n');
let buffer=Buffer.alloc(0);
function send(message) {
  const body=JSON.stringify(message);
  process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body);
}
function handle(m) {
  if(m.method==='initialize') return send({jsonrpc:'2.0',id:m.id,result:{capabilities:{textDocumentSync:{openClose:true,change:1}}}});
  if(m.method==='textDocument/didOpen'||m.method==='textDocument/didChange') {
    return send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:m.params.textDocument.uri,version:m.params.textDocument.version,diagnostics:[]}});
  }
  if(m.method==='exit') process.exit(0);
  if(m.id!==undefined) send({jsonrpc:'2.0',id:m.id,result:null});
}
process.stdin.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  for(;;) {
    const end=buffer.indexOf('\r\n\r\n'); if(end<0)return;
    const size=Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0,end).toString())[1]);
    if(buffer.length<end+4+size)return;
    const m=JSON.parse(buffer.subarray(end+4,end+4+size));buffer=buffer.subarray(end+4+size);handle(m);
  }
});
`;

function fixture(ids = ["new-language-server"], rootMarkers: string[] = [".git"], idleOptions: IdleCleanupOptions = {}) {
  const dir = path.join(run, String(++sequence));
  const project = path.join(dir, "project");
  const alias = path.join(dir, "alias");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  const script = path.join(dir, "server.cjs");
  fs.writeFileSync(script, serverCode);
  const servers: LspServerConfig[] = ids.map((id, i) => ({
    id, bin: "node", args: [script, path.join(dir, `${i}.pids`)], rootMarkers,
    include: [`**/*.lang${i}`], pullDiagnostics: false, waitForPublishDiagnostics: false,
  }));
  const manager = new LspManager(async () => ({ items: servers, workspace: project, warnings: [] }), idleOptions);
  managers.add(manager);
  const pids = (i = 0) => {
    const log = path.join(dir, `${i}.pids`);
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split(/\s+/).map(Number) : [];
  };
  const ctx = (cwd = project, signal?: AbortSignal) => ({ cwd, signal }) as ExtensionContext;
  const file = path.join(project, "a.lang0");
  fs.writeFileSync(file, "a");
  return { project, alias, manager, servers, pids, ctx, file };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("LSP lifecycle condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function gateFailedClient(manager: LspManager) {
  const client = (manager as any).clients.values().next().value;
  const originalShutdown = client.shutdown.bind(client);
  const entered = deferred();
  const gate = deferred();
  client.unavailableReason = "simulated transport failure with a live process";
  client.initialized = false;
  client.shutdown = async () => { entered.resolve(); await gate.promise; await originalShutdown(); };
  return { client, entered, gate, originalShutdown };
}

afterEach(async () => {
  for (const manager of managers) {
    await manager.shutdownAll();
    manager.shutdownAllSync();
  }
  managers.clear();
});

describe.serial("generic LSP process reuse", () => {
  for (const markers of [[".git"], []]) {
    test(`all configured IDs share parallel acquisition through physical and alias paths (${markers.join() || "cwd fallback"})`, async () => {
      const ids = ["typescript", "svelte", "python", "rust", "future-custom-language"];
      const { project, alias, manager, servers, pids, ctx } = fixture(ids, markers);
      const files: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        const file = path.join(project, `a.lang${i}`);
        const second = path.join(project, `b.lang${i}`);
        fs.writeFileSync(file, "a"); fs.writeFileSync(second, "b");
        files.push(file, second);
      }
      await Promise.all(files.flatMap((file) => [
        manager.updateDiagnosticsForFile(ctx(), file),
        manager.updateDiagnosticsForFile(ctx(alias), path.join(alias, path.basename(file))),
      ]));
      expect(manager.runtimeSnapshot()).toHaveLength(ids.length);
      for (let i = 0; i < ids.length; i++) {
        expect(pids(i)).toHaveLength(1);
        expect(manager.runtimeSnapshot()).toContainEqual({ id: ids[i], root: project, state: "running", pid: pids(i)[0] });
      }
      const document = await manager.ensureDocumentForTool(ctx(alias), "a.lang0");
      expect(document?.file).toBe(path.join(project, "a.lang0"));
      expect(document?.match.root).toBe(project);
      await manager.startServer(servers[0], alias, alias);
      expect(pids()).toHaveLength(1);
      await manager.stopServer(ids[0], alias);
      expect(manager.runtimeSnapshot().find((row) => row.id === ids[0])?.state).toBe("stopped");
    });
  }

  test("different package workspaces retain their own process and each reuses it", async () => {
    const { project, alias, manager, pids, ctx } = fixture(["future-custom-language"], ["package.json"]);
    const roots = ["one", "two"].map((name) => path.join(project, name));
    for (const root of roots) {
      fs.mkdirSync(root); fs.writeFileSync(path.join(root, "package.json"), "{}");
      fs.writeFileSync(path.join(root, "a.lang0"), "a");
    }
    await Promise.all(roots.flatMap((root) => [
      manager.updateDiagnosticsForFile(ctx(), path.join(root, "a.lang0")),
      manager.updateDiagnosticsForFile(ctx(alias), path.join(alias, path.basename(root), "a.lang0")),
    ]));
    expect(pids()).toHaveLength(2);
    expect(manager.runtimeSnapshot().map((row) => row.root).sort()).toEqual(roots.sort());
  });

  test("parallel retries wait for a failed client's teardown before replacing its process", async () => {
    const { project, manager, servers, pids, ctx, file } = fixture();
    await manager.updateDiagnosticsForFile(ctx(), file);
    const { client, entered, gate, originalShutdown } = gateFailedClient(manager);
    const retries = [manager.startServer(servers[0], project, project), manager.startServer(servers[0], project, project)];
    try {
      await Promise.race([entered.promise, Promise.all(retries).then(() => { throw new Error("replacement skipped prior teardown"); })]);
      expect(pids()).toHaveLength(1);
      gate.resolve();
      await Promise.all(retries);
      expect(pids()).toHaveLength(2);
      expect(isAlive(pids()[0])).toBe(false);
      expect(manager.runtimeSnapshot()).toEqual([{ id: servers[0].id, root: project, state: "running", pid: pids()[1] }]);
    } finally {
      gate.resolve(); await Promise.allSettled(retries); client.shutdown = originalShutdown; await originalShutdown();
    }
  });

  test("cancelling one replacement waiter does not cancel another or create a duplicate", async () => {
    const { project, manager, servers, pids, ctx, file } = fixture();
    await manager.updateDiagnosticsForFile(ctx(), file);
    const { client, entered, gate, originalShutdown } = gateFailedClient(manager);
    const abort = new AbortController();
    const cancelled = manager.startServer(servers[0], project, project, manager.ownerGeneration, abort.signal).catch((error) => error.message);
    const survivor = manager.startServer(servers[0], project, project);
    try {
      await Promise.race([entered.promise, survivor.then(() => { throw new Error("replacement skipped prior teardown"); })]); abort.abort();
      expect(await cancelled).toBe("aborted");
      expect(pids()).toHaveLength(1);
      gate.resolve(); await survivor;
      expect(pids()).toHaveLength(2);
      expect(isAlive(pids()[0])).toBe(false);
    } finally {
      gate.resolve(); await Promise.allSettled([cancelled, survivor]); client.shutdown = originalShutdown; await originalShutdown();
    }
  });

  test("owner shutdown fences a replacement awaiting failed-client teardown", async () => {
    const { project, manager, servers, pids, ctx, file } = fixture();
    await manager.updateDiagnosticsForFile(ctx(), file);
    const { client, entered, gate, originalShutdown } = gateFailedClient(manager);
    const retry = manager.startServer(servers[0], project, project).catch((error) => error.message);
    let shutdown: Promise<void> | undefined;
    try {
      await Promise.race([entered.promise, retry.then(() => { throw new Error("replacement skipped prior teardown"); })]); shutdown = manager.shutdownAll();
      gate.resolve(); await shutdown;
      expect(await retry).toBe("LSP owner stopped");
      expect(pids()).toHaveLength(1);
      expect(manager.runtimeSnapshot()).toEqual([]);
    } finally {
      gate.resolve(); await Promise.allSettled([retry, shutdown]); client.shutdown = originalShutdown; await originalShutdown();
    }
  });
});

describe("LSP idle process lifecycle without a monitor", () => {
  test("fifteen-minute expiry kills the process and concurrent edits lazily recreate one PID", async () => {
    const clock = new ManualLspClock();
    const { manager, pids, ctx, file } = fixture(undefined, undefined, { schedule: clock.schedule });
    await manager.updateDiagnosticsForFile(ctx(), file);
    expect(clock.pending).toBe(1);
    clock.advance(LSP_IDLE_TIMEOUT_MS - 1);
    for (let i = 0; i < 5; i++) expect(manager.runtimeSnapshot()[0].pid).toBe(pids()[0]);
    expect(isAlive(pids()[0])).toBe(true);
    clock.advance(1);
    await eventually(() => manager.runtimeSnapshot().length === 0);
    expect(isAlive(pids()[0])).toBe(false);
    await Promise.all(Array.from({ length: 8 }, () => manager.updateDiagnosticsForFile(ctx(), file)));
    expect(pids()).toHaveLength(2);
    expect(isAlive(pids()[1])).toBe(true);
    expect(clock.pending).toBe(1);
  });

  test("new activity resets expiry and overlapping requests cannot be stopped mid-flight", async () => {
    const clock = new ManualLspClock();
    const { manager, pids, ctx, file } = fixture(undefined, undefined, { schedule: clock.schedule });
    await manager.updateDiagnosticsForFile(ctx(), file);
    clock.advance(LSP_IDLE_TIMEOUT_MS - 1);
    await manager.updateDiagnosticsForFile(ctx(), file);
    clock.advance(1);
    expect(isAlive(pids()[0])).toBe(true);
    const client = (await manager.ensureDocumentForTool(ctx(), file))!.client;
    const connection = (client as any).connection;
    const originalRequest = connection.sendRequest;
    const first = deferred(), second = deferred();
    let requests = 0;
    connection.sendRequest = () => (++requests === 1 ? first.promise : second.promise);
    const a = client.hover(file, 0, 0), b = client.symbols(file);
    try {
      expect(clock.pending).toBe(0);
      clock.advance(LSP_IDLE_TIMEOUT_MS * 2);
      first.resolve(); await a;
      expect(clock.pending).toBe(0);
      expect(isAlive(pids()[0])).toBe(true);
      second.resolve(); await b;
      expect(clock.pending).toBe(1);
    } finally {
      first.resolve(); second.resolve(); await Promise.allSettled([a, b]); connection.sendRequest = originalRequest;
    }
    clock.advance(LSP_IDLE_TIMEOUT_MS);
    await eventually(() => manager.runtimeSnapshot().length === 0);
    expect(isAlive(pids()[0])).toBe(false);
  });

  test("idle retirement fences replacement until old teardown finishes", async () => {
    const clock = new ManualLspClock();
    const { project, manager, servers, pids, ctx, file } = fixture(undefined, undefined, { schedule: clock.schedule });
    await manager.updateDiagnosticsForFile(ctx(), file);
    const client = (manager as any).clients.values().next().value;
    const originalShutdown = client.shutdown.bind(client);
    const gate = deferred();
    client.shutdown = () => { const stopping = originalShutdown(); return gate.promise.then(() => stopping); };
    clock.advance(LSP_IDLE_TIMEOUT_MS);
    const retries = Array.from({ length: 6 }, () => manager.startServer(servers[0], project, project));
    try {
      await eventually(() => !isAlive(pids()[0]));
      expect(pids()).toHaveLength(1);
      gate.resolve(); await Promise.all(retries);
      expect(pids()).toHaveLength(2);
      expect(isAlive(pids()[0])).toBe(false);
    } finally {
      gate.resolve(); await Promise.allSettled(retries); client.shutdown = originalShutdown;
    }
  });

  test("owner shutdown clears timers and stale callbacks cannot resurrect a process", async () => {
    const clock = new ManualLspClock();
    const { manager, pids, ctx, file } = fixture(undefined, undefined, { schedule: clock.schedule });
    await manager.updateDiagnosticsForFile(ctx(), file);
    const queued = clock.tasks[clock.tasks.length - 1];
    await manager.shutdownAll();
    expect(clock.pending).toBe(0);
    queued.callback();
    clock.advance(LSP_IDLE_TIMEOUT_MS);
    expect(manager.runtimeSnapshot()).toEqual([]);
    expect(pids()).toHaveLength(1);
    // A SIGKILLed child can briefly linger as an unreaped zombie that still
    // answers signal 0 under CI load; poll for death instead of asserting the
    // synchronous kill landed already. A resurrected process would time out.
    await eventually(() => !isAlive(pids()[0]));
  });
});
