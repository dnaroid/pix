import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { lspBrokerEndpoint, lspProjectIdentity } from "../src/lsp/broker-identity";
import { LSP_RPC_MAX_BYTES } from "../src/lsp/broker-wire";

const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
fs.mkdirSync(artifacts, { recursive: true });
const root = fs.mkdtempSync(path.join(artifacts, "lsp-broker-tests-"));
const actors = new Set<Actor>();
let counter = 0;
const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(predicate: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 25));
  return predicate();
}
async function waitForAsync(predicate: () => Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

const actorCode = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
const sdk = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const jiti = sdk('jiti').createJiti(path.join(process.cwd(),'actor.cjs'));
const source = process.argv[1];
const modules = Promise.all(['runtime-control.ts','shared-manager.ts'].map(file => jiti.import(path.join(source,file))));
const ctx = { cwd: process.argv[2], hasUI: false, sessionManager: {} };
let approve;
let startup;
process.on('message', async ({id, op, targetId, root, file, cwd}) => {
  try {
    const [control, shared] = await modules;
    let result;
    if (op === 'switch') { ctx.cwd=cwd; result=await (await shared.attachSharedLsp(ctx)).rpc({op:'inspect'}); }
    else if (op === 'approve') { approve('Trust once'); result = true; }
    else if (op === 'abort-start') { startup.abort(); result = true; }
    else if (op === 'raw-start') {
      startup=new AbortController();
      const connection=await shared.attachSharedLsp(ctx);
      const stamp=await connection.rpc({op:'inspect',targetId,root});
      const config=await shared.approvedLspConfig(ctx);
      const pending=connection.rpc({op:'start',cwd:ctx.cwd,targetId,root,stamp,config},startup.signal);
      await connection.rpc({op:'inspect'});
      process.send({dispatched:true});
      result=await pending;
    }
    else if (op === 'wait-start' || op === 'wait-restart') {
      const interactive = {...ctx, hasUI:true, ui:{select:()=>new Promise(resolve=>{approve=resolve;process.send({prompt:true});})}};
      result=await control.controlLsp(interactive,op.slice(5),targetId,root);
    }
    else if (op === 'attach') result = await (await shared.attachSharedLsp(ctx)).rpc({op:'inspect'});
    else if (op === 'close') { await shared.releaseSharedLsp(ctx); result = true; }
    else if (op === 'diagnostics') result = await shared.sharedDiagnosticsForFile(ctx, file);
    else result = await control.controlLsp(ctx,op,targetId,root);
    process.send({id,result});
  } catch (error) { process.send({id,error:String(error.message || error)}); }
});
`;
const serverCode = String.raw`
const fs = require('node:fs');
const {spawn} = require('node:child_process');
fs.appendFileSync(process.argv[2], process.pid+'\n');
fs.writeFileSync(process.argv[2]+'.guardian',String(process.ppid));
if (process.argv[3] === 'descendant') {
  const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
  fs.appendFileSync(process.argv[2],c.pid+'\n');
}
let buffer=Buffer.alloc(0);
function send(data) { const text=JSON.stringify(data); process.stdout.write('Content-Length: '+Buffer.byteLength(text)+'\r\n\r\n'+text); }
function handle(m) {
  if(m.method==='initialize') {
    if(process.argv[3]==='hang') return;
    if(process.argv[3]==='gate') {
      const timer=setInterval(()=>{
        if(!fs.existsSync(process.argv[2]+'.gate')) return;
        clearInterval(timer);send({jsonrpc:'2.0',id:m.id,result:{capabilities:{textDocumentSync:{openClose:true,change:1,save:{}}}}});
      },10);
      return;
    }
    return send({jsonrpc:'2.0',id:m.id,result:{capabilities:{textDocumentSync:{openClose:true,change:1,save:{}}}}});
  }
  if(m.method==='textDocument/didOpen'||m.method==='textDocument/didChange') {
    const d=m.params.textDocument;
    setTimeout(()=>send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:d.uri,version:d.version,diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:1}},severity:1,message:'shared issue'}]}}),50);
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

class Actor {
  readonly child: ChildProcess;
  prompts = 0;
  dispatched = 0;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly project: string, home: string) {
    this.child = spawn("node", ["--input-type=module", "-e", actorCode, fileURLToPath(new URL("../src/lsp/", import.meta.url)), project], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, HOME: home, PI_CONFIG_DIR: home, PI_AGENT_DIR: home }, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    actors.add(this);
    this.child.on("message", (message: any) => {
      if (message.prompt) { this.prompts++; return; }
      if (message.dispatched) { this.dispatched++; return; }
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    this.child.on("exit", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Actor exited")); }
      this.pending.clear(); actors.delete(this);
    });
  }
  request(op: string, extra: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Actor ${op} timed out`)); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, op, ...extra });
    });
  }
  control(op: string, id = "fake", root = this.project) { return this.request(op, { targetId: id, root }); }
  async kill(signal: NodeJS.Signals = "SIGKILL") {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill(signal); await exited;
  }
}

function setup(mode = "basic") {
  const dir = path.join(root, String(++counter)); fs.mkdirSync(dir);
  const home = path.join(dir, "home"); const project = path.join(dir, "project");
  fs.mkdirSync(home); fs.mkdirSync(project); fs.mkdirSync(path.join(project, ".git"));
  const log = path.join(dir, "pids.txt"); const script = path.join(dir, "fake.cjs");
  fs.writeFileSync(script, serverCode); fs.writeFileSync(path.join(project, "a.ts"), "const x = 1;");
  fs.writeFileSync(path.join(home, "pi-tools-suite.jsonc"), JSON.stringify({ lsp: { servers: [{ id: "fake", bin: "node", args: [script, log, mode], rootMarkers: [], pullDiagnostics: false, diagnosticsWaitMs: 1_000, startupTimeoutMs: 10_000 }] } }));
  const pids = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split(/\s+/).map(Number) : [];
  return { home, project, pids, gate: () => fs.writeFileSync(log + ".gate", "go"), guardian: () => Number(fs.readFileSync(log + ".guardian", "utf8")), actor: () => new Actor(project, home) };
}

afterEach(async () => {
  await Promise.all([...actors].map(async (actor) => { try { await actor.request("close"); } catch {} await actor.kill(); }));
});

const describeBroker = process.platform === "win32" ? describe.skip : describe.serial;
describeBroker("independent-process shared LSP broker", () => {
  test("arbitrary server IDs reuse one process per package workspace across independent owners and aliases", async () => {
    const f = setup();
    const ids = ["typescript", "svelte", "python", "rust", "future-custom-language"];
    const project = fs.realpathSync(f.project);
    const dir = path.dirname(project);
    const alias = path.join(dir, "alias");
    fs.symlinkSync(project, alias);
    const roots = ["one", "two"].map((name) => path.join(project, name));
    for (const root of roots) {
      fs.mkdirSync(root); fs.writeFileSync(path.join(root, "package.json"), "{}");
      ids.forEach((_, i) => fs.writeFileSync(path.join(root, `a.lang${i}`), "a"));
    }
    const logs = ids.map((_, i) => path.join(dir, `${i}.pids`));
    fs.writeFileSync(path.join(f.home, "pi-tools-suite.jsonc"), JSON.stringify({ lsp: { servers: ids.map((id, i) => ({
      id, bin: "node", args: [path.join(dir, "fake.cjs"), logs[i], "basic"],
      include: [`**/*.lang${i}`], rootMarkers: ["package.json"],
      pullDiagnostics: false, waitForPublishDiagnostics: false, startupTimeoutMs: 10_000,
    })) } }));
    const a = f.actor(), b = f.actor();
    await Promise.all([a.request("attach"), b.request("attach")]);
    await Promise.all(roots.flatMap((root) => ids.flatMap((_, i) => [
      a.request("diagnostics", { file: path.join(root, `a.lang${i}`) }),
      b.request("diagnostics", { file: path.join(alias, path.basename(root), `a.lang${i}`) }),
    ])));
    const snapshot = await a.control("status");
    expect(snapshot.servers).toHaveLength(ids.length * roots.length);
    const pids: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      const started = fs.readFileSync(logs[i], "utf8").trim().split(/\s+/).map(Number);
      expect(started).toHaveLength(roots.length);
      pids.push(...started);
      const rows = snapshot.servers.filter((row: any) => row.id === ids[i]);
      expect(rows.map((row: any) => row.root).sort()).toEqual(roots.slice().sort());
      expect(rows.every((row: any) => row.state === "running" && started.includes(row.pid))).toBe(true);
    }
    await a.request("close"); await a.kill();
    expect((await b.control("status")).servers).toEqual(snapshot.servers);
    await b.request("close"); await b.kill();
    expect(await waitFor(() => pids.every((pid) => !exists(pid)))).toBe(true);
  }, 40_000);

  test("simultaneous attach/start owns one PID, Stop suppresses both, original client close preserves other", async () => {
    const { actor, project, pids } = setup(); const a = actor(); const b = actor();
    const [first, second] = await Promise.all([a.request("attach"), b.request("attach")]);
    expect(first.brokerPid).toBe(second.brokerPid); expect(pids()).toEqual([]);
    const [startedA, startedB] = await Promise.all([a.control("start"), b.control("start")]);
    const pid = startedA.servers[0].pid;
    expect(startedB.servers[0].pid).toBe(pid); expect(pids()).toEqual([pid]);
    const diagnostics = await Promise.all([a.request("diagnostics", { file: path.join(project, "a.ts") }), b.request("diagnostics", { file: path.join(project, "a.ts") })]);
    expect(diagnostics.every((text) => text.includes("shared issue") && !text.includes("timed out"))).toBe(true);
    await b.control("stop"); expect(await waitFor(() => !exists(pid))).toBe(true);
    expect((await a.control("status")).servers[0].state).toBe("stopped");
    await a.request("diagnostics", { file: path.join(project, "a.ts") }); expect(pids()).toEqual([pid]);
    await a.control("start"); const next = pids()[1];
    await a.request("close"); await a.kill();
    expect((await b.control("status")).servers[0].pid).toBe(next);
    expect(await b.request("diagnostics", { file: path.join(project, "a.ts") })).toContain("shared issue");
    await b.request("close"); await b.kill();
    expect(await waitFor(() => !exists(first.brokerPid) && !exists(next))).toBe(true);
  }, 40_000);

  test("last SIGKILL cleans broker and owned descendants; reconnect is fresh", async () => {
    const { actor, pids, project } = setup("descendant"); const a = actor();
    const { brokerPid } = await a.request("attach"); await a.control("start");
    expect(pids()).toHaveLength(2); const owned = pids();
    await a.kill();
    expect(await waitFor(() => !exists(brokerPid) && owned.every((pid) => !exists(pid)))).toBe(true);
    const b = actor(); const next = await b.request("attach");
    expect(next.brokerPid).not.toBe(brokerPid); expect(next.servers).toEqual([]);
    const endpoint = lspBrokerEndpoint(lspProjectIdentity(project));
    expect(fs.statSync(endpoint).mode & 0o077).toBe(0);
    await b.control("start"); expect(pids()).toHaveLength(4);
  }, 40_000);

  test("replacement waits for the retiring broker's ownership lock and preserves its endpoint", async () => {
    const { actor, project, pids, guardian } = setup(); const a = actor();
    const { brokerPid } = await a.request("attach"); await a.control("start");
    const endpoint = lspBrokerEndpoint(lspProjectIdentity(project));
    const lock = endpoint + ".lock";
    expect(fs.readFileSync(lock, "utf8")).toBe(String(brokerPid));
    // Hold the real shutdown grace window open while the next session attaches.
    process.kill(guardian(), "SIGSTOP");
    await a.request("close");
    expect(exists(brokerPid)).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toBe(String(brokerPid));
    const b = actor(); const next = await b.request("attach");
    expect(next.brokerPid).not.toBe(brokerPid);
    expect(exists(brokerPid)).toBe(false);
    expect(fs.readFileSync(lock, "utf8")).toBe(String(next.brokerPid));
    const started = await b.control("start");
    expect(started.servers[0].pid).toBe(pids()[1]);
    expect((await b.control("status")).servers[0].pid).toBe(pids()[1]);
    expect(fs.existsSync(endpoint)).toBe(true);
    expect(exists(pids()[1])).toBe(true);
  }, 40_000);

  test("cross-process Stop wins over slow Start and Restart trust decisions", async () => {
    const { actor, project, home, pids } = setup(); const a = actor(); const b = actor();
    await Promise.all([a.request("attach"), b.request("attach")]);
    await a.control("start"); const original = pids()[0];
    fs.mkdirSync(path.join(project, ".pi"));
    const config = JSON.parse(fs.readFileSync(path.join(home, "pi-tools-suite.jsonc"), "utf8"));
    const projectConfig = path.join(project, ".pi", "pi-tools-suite.jsonc");
    fs.writeFileSync(projectConfig, JSON.stringify(config));
    // Adding a config at the already-canonical project root does not change identity.
    for (const operation of ["start", "restart"]) {
      config.lsp.servers[0].initializationOptions = { operation };
      fs.writeFileSync(projectConfig, JSON.stringify(config));
      const pending = a.control(`wait-${operation}`).then(() => "started", (error) => String(error.message));
      expect(await waitFor(() => a.prompts === (operation === "start" ? 1 : 2))).toBe(true);
      await b.control("stop"); await a.request("approve");
      expect(await pending).toContain("cancelled by Stop");
      expect((await a.control("status")).servers[0].state).toBe("stopped");
      expect(pids()).toEqual([original]);
    }
    expect(await waitFor(() => !exists(original))).toBe(true);
  }, 40_000);

  test("Stop during another process's initialize cancels startup and Restart recovers", async () => {
    const { actor, home, pids } = setup("hang"); const a = actor(); const b = actor();
    await Promise.all([a.request("attach"), b.request("attach")]);
    const pending = a.control("start").then(() => "started", (error) => String(error.message));
    expect(await waitFor(() => pids().length === 1)).toBe(true);
    await b.control("stop"); expect(await pending).not.toBe("started");
    expect(await waitFor(() => pids().every((pid) => !exists(pid)))).toBe(true);
    const file = path.join(home, "pi-tools-suite.jsonc"); const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.lsp.servers[0].args[2] = "basic"; fs.writeFileSync(file, JSON.stringify(config));
    expect((await b.control("restart")).servers[0].state).toBe("running");
    expect((await a.control("status")).servers[0].pid).toBe(pids()[1]);
  }, 40_000);

  test("a later cross-process Stop wins while Restart awaits real process shutdown", async () => {
    const { actor, pids, guardian } = setup(); const a = actor(); const b = actor();
    await Promise.all([a.request("attach"), b.request("attach")]); await a.control("start");
    // Pause only this test's owned supervisor to hold the bounded TERM grace
    // window open, without injecting a broker-only test hook.
    process.kill(guardian(), "SIGSTOP");
    const restarting = a.control("restart").then(() => "started", (error) => String(error.message));
    expect(await waitForAsync(async () => (await b.request("attach")).servers[0]?.state === "stopping")).toBe(true);
    await b.control("stop");
    expect(await restarting).toContain("restart cancelled by Stop");
    expect((await a.control("status")).servers[0].state).toBe("stopped");
    expect(pids()).toHaveLength(1);
    expect(await waitFor(() => pids().every((pid) => !exists(pid)))).toBe(true);
  }, 40_000);

  test("one caller's cancellation cannot kill another caller's shared startup", async () => {
    const { actor, pids, gate } = setup("gate"); const a = actor(); const b = actor();
    await Promise.all([a.request("attach"), b.request("attach")]);
    const startingA = a.control("raw-start").then(() => "started", (error) => String(error.message));
    expect(await waitFor(() => a.dispatched === 1 && pids().length === 1)).toBe(true);
    const startingB = b.control("raw-start");
    expect(await waitFor(() => b.dispatched === 1)).toBe(true);
    await a.request("abort-start"); expect(await startingA).toContain("aborted");
    expect(exists(pids()[0])).toBe(true); gate();
    expect((await startingB).servers[0].state).toBe("running");
    expect(pids()).toHaveLength(1);
  }, 40_000);

  test("broker hard kill sweeps owned groups and reconnect recovers a stale socket", async () => {
    const { actor, project, pids } = setup("descendant"); const a = actor(); const b = actor();
    const first = await a.request("attach"); await b.request("attach"); await a.control("start"); const owned = pids();
    process.kill(first.brokerPid, "SIGKILL");
    expect(await waitFor(() => owned.every((pid) => !exists(pid)))).toBe(true);
    const endpoint = lspBrokerEndpoint(lspProjectIdentity(project)); expect(fs.existsSync(endpoint)).toBe(true);
    // Recover a dead startup lease as well as the killed broker's stale socket.
    fs.writeFileSync(endpoint + ".lock", String(first.brokerPid), { mode: 0o600 });
    const [second, third] = await Promise.all([a.request("attach"), b.request("attach")]);
    expect(second.brokerPid).not.toBe(first.brokerPid); expect(third.brokerPid).toBe(second.brokerPid);
    const [startedA, startedB] = await Promise.all([a.control("start"), b.control("start")]);
    expect(startedA.servers[0].pid).toBe(startedB.servers[0].pid); expect(pids()).toHaveLength(4);
  }, 40_000);

  test("session project switching releases the old attachment without stopping another tab", async () => {
    const one = setup(); const two = setup(); const a = one.actor(); const b = one.actor();
    const original = await a.request("attach"); await b.request("attach"); await a.control("start");
    const next = await a.request("switch", { cwd: two.project });
    expect(next.brokerPid).not.toBe(original.brokerPid); expect(next.servers).toEqual([]);
    expect((await b.control("status")).servers[0].pid).toBe(one.pids()[0]);
    await b.request("close");
    expect(await waitFor(() => !exists(original.brokerPid) && one.pids().every((pid) => !exists(pid)))).toBe(true);
    expect(exists(next.brokerPid)).toBe(true);
  }, 40_000);

  test("Stop is config-free after removal and never kills an unrelated process", async () => {
    const { actor, home, pids } = setup(); const a = actor(); const b = actor();
    const unrelated = spawn("node", ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      await Promise.all([a.request("attach"), b.request("attach")]); await a.control("start");
      fs.unlinkSync(path.join(home, "pi-tools-suite.jsonc"));
      const snapshot = await b.control("stop"); expect(snapshot.servers[0].state).toBe("stopped");
      expect(await waitFor(() => pids().every((pid) => !exists(pid)))).toBe(true);
      expect(exists(unrelated.pid!)).toBe(true);
      await expect(b.request("stop")).rejects.toThrow("requires server id and root");
      await a.request("close"); await b.request("close"); expect(exists(unrelated.pid!)).toBe(true);
    } finally {
      const exited = new Promise<void>((resolve) => unrelated.once("exit", () => resolve()));
      unrelated.kill("SIGKILL"); await exited;
    }
  }, 40_000);

  test("oversized unauthenticated IPC frames are bounded without disturbing an attached tab", async () => {
    const { actor, project, pids } = setup(); const a = actor(); const before = await a.request("attach");
    const endpoint = lspBrokerEndpoint(lspProjectIdentity(project));
    const socket = net.createConnection(endpoint); socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(Buffer.alloc(LSP_RPC_MAX_BYTES + 1, 120)); await closed;
    expect((await a.request("attach")).brokerPid).toBe(before.brokerPid); expect(pids()).toEqual([]);
  }, 40_000);

  test("project isolation, canonical aliases, and untrusted status/mutations do not spawn", async () => {
    const one = setup(); const two = setup();
    const a = one.actor(); const b = two.actor();
    const [first, second] = await Promise.all([a.request("attach"), b.request("attach")]);
    expect(first.brokerPid).not.toBe(second.brokerPid);
    await a.control("stop"); expect((await b.control("start")).servers[0].state).toBe("running");
    expect(one.pids()).toEqual([]); expect(two.pids()).toHaveLength(1);
    const alias = path.join(path.dirname(one.project), "alias"); fs.symlinkSync(one.project, alias);
    const aliasActor = new Actor(alias, one.home);
    expect((await aliasActor.request("attach")).brokerPid).toBe(first.brokerPid);
    await a.control("start");
    expect((await aliasActor.control("start")).servers.find((server: any) => server.id === "fake").pid).toBe(one.pids()[0]);
    await aliasActor.request("diagnostics", { file: path.join(alias, "a.ts") });
    expect(one.pids()).toHaveLength(1);
    await a.control("stop");
    const config = JSON.parse(fs.readFileSync(path.join(one.home, "pi-tools-suite.jsonc"), "utf8"));
    config.lsp.servers[0].id = "untrusted";
    fs.mkdirSync(path.join(one.project, ".pi")); fs.writeFileSync(path.join(one.project, ".pi", "pi-tools-suite.jsonc"), JSON.stringify(config));
    fs.writeFileSync(path.join(one.home, "pi-tools-suite.jsonc"), "{}");
    expect((await a.control("status")).servers.some((server: any) => server.id === "untrusted")).toBe(false);
    expect(a.prompts).toBe(0);
    await expect(a.control("start", "untrusted")).rejects.toThrow("trusted workspace");
    await a.request("diagnostics", { file: path.join(one.project, "a.ts") });
    expect(one.pids()).toHaveLength(1);
  }, 40_000);

  test("a trusted ancestor root remains restartable after lazy discovery and Stop", async () => {
    const { actor, project, home, pids } = setup();
    const markerRoot = path.dirname(project);
    fs.writeFileSync(path.join(markerRoot, "workspace.marker"), "");
    const configPath = path.join(home, "pi-tools-suite.jsonc");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.lsp.servers[0].rootMarkers = ["workspace.marker"];
    fs.writeFileSync(configPath, JSON.stringify(config));
    const a = actor();
    expect(await a.request("diagnostics", { file: path.join(project, "a.ts") })).toContain("shared issue");
    expect(pids()).toHaveLength(1);
    await a.control("stop", "fake", markerRoot);
    expect((await a.control("start", "fake", markerRoot)).servers.find((server: any) => server.id === "fake").state).toBe("running");
    expect(pids()).toHaveLength(2);
  }, 40_000);
});
