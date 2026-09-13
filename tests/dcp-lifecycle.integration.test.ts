import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openLazySessionManager } from "../src/app/session/lazy-session-manager.js";
import { formatDcpStatsToast } from "../src/app/rendering/dcp-stats.js";
import dcpModule from "../external/pi-tools-suite/src/dcp/index.js";
import { loadConfig } from "../external/pi-tools-suite/src/dcp/config.js";
import { createState } from "../external/pi-tools-suite/src/dcp/state.js";
import { collectDcpStatistics } from "../external/pi-tools-suite/src/dcp/statistics.js";

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp } as any);
const assistant = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], timestamp,
  provider: "fixture", model: "large", api: "openai-responses", stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);

async function runtime(manager: any) {
  const state = createState();
  const config = loadConfig({ homeDir: "/__dcp_full_branch_integration__" });
  config.debug = false;
  config.compress.minContextPercent = 0.99;
  config.compress.maxContextPercent = 0.995;
  config.compress.summaryBuffer = false;
  config.compress.autoCompress.enabled = false;
  config.compress.autoCandidates.enabled = false;
  config.compress.messageMode.enabled = false;
  const handlers = new Map<string, any[]>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const sent: any[] = [];
  const ctx: any = { sessionManager: manager, cwd: manager.getCwd(), hasUI: false,
    model: { provider: "fixture", id: "large", contextWindow: 1_000_000, maxTokens: 4_096 },
    getContextUsage: () => ({ tokens: 4_000, contextWindow: 1_000_000 }),
    ui: { notify() {} }, abort() { throw new Error("provider send aborted"); },
  };
  await dcpModule({ on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, command: any) { commands.set(name, command); },
    appendEntry(type: string, data: unknown) { ctx.sessionManager.appendCustomEntry(type, data); },
    sendMessage(message: unknown) { sent.push(message); },
  } as any, { state, config });
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const fn of handlers.get(name) ?? []) result = await fn({ type: name, ...event }, ctx);
    return result;
  };
  const project = () => emit("context", { messages: ctx.sessionManager.buildSessionContext().messages });
  const send = (p: any) => emit("before_provider_request", { payload: { messages: p.messages } });
  return { ctx, state, config, tools, commands, emit, project, send, sent };
}

test("DCP + actual lazy manager: resume and non-tip forks replay exactly their branch, not the UI cursor", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-lazy-integration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  const f = await runtime(manager);
  await f.emit("session_start", { reason: "new" });
  manager.appendMessage(user("Preserve the public API", 1));
  const sourceId = manager.appendMessage(assistant("Closed inspection log\n".repeat(500), 2));
  manager.appendMessage(user("Continue with verification", 3));
  await f.project();
  const beforeCompressionLeaf = manager.getLeafId()!;
  const messageId = f.state.messageIdsByStableId.get(`id:${sourceId}`);
  assert.ok(messageId);
  const args = { topic: "Closed inspection", messages: [{ messageId, summary: "Inspection completed; keep public API unchanged." }] };
  const commit = await f.tools.get("compress").execute("compress-1", args, undefined, undefined, f.ctx);
  assert.ok(commit.details.netGain > 0);
  // Idempotent tool retry must not create another measured gain.
  await f.tools.get("compress").execute("compress-1", args, undefined, undefined, f.ctx);
  for (let i = 0; i < 20; i++) manager.appendCustomEntry("presentation-padding", { i });
  const expected = await f.project();
  const parentFile = manager.getSessionFile()!;
  const parentText = readFileSync(parentFile, "utf8");
  const lazy = await openLazySessionManager(parentFile, { cwdOverride: dir, tailEntryCount: 4 });
  assert.equal(lazy.getBranch().length, 4);
  assert.equal(lazy.getBranch().some((e: any) => e.customType === "dcp-journal"), false);
  assert.equal(lazy.buildSessionContext().messages.length, manager.buildSessionContext().messages.length);
  const resumed = await runtime(lazy);
  await resumed.emit("session_start", { reason: "resume" });
  assert.deepEqual((await resumed.project()).messages, expected.messages);
  assert.equal(resumed.state.providerSeenToolIds.size, 0);
  await resumed.commands.get("dcp").handler("stats", resumed.ctx);
  const commandText = resumed.sent.at(-1)?.content;
  assert.match(commandText, /Blocks: 1 active/);
  assert.match(commandText, /1 measured commits/);
  assert.doesNotMatch(commandText, /Closed inspection log/);
  assert.equal(commandText, formatDcpStatsToast({ ...resumed.ctx, getContextUsage: resumed.ctx.getContextUsage } as any));

  // Fork before the compression journal operation cannot inherit its block or
  // its activity. Fork after it must preserve both, even outside the hot tail.
  for (const [leaf, expectedBlocks] of [[beforeCompressionLeaf, 0], [manager.getLeafId()!, 1]] as const) {
    const forker = SessionManager.open(parentFile, dir, dir);
    const forkFile = forker.createBranchedSession(leaf)!;
    const fork = await openLazySessionManager(forkFile, { cwdOverride: dir, tailEntryCount: 3 });
    const child = await runtime(fork);
    await child.emit("session_start", { reason: "fork" });
    const projection = await child.project();
    assert.equal(child.state.compressionBlocks.length, expectedBlocks);
    assert.equal(JSON.stringify(projection.messages).includes("Closed inspection log"), expectedBlocks === 0);
    assert.equal(child.state.providerSeenToolIds.size, 0);
    assert.equal(child.state.consecutiveIgnoredNudges, 0);
  }
  // Forking did not rewrite the parent archive (resume may have appended only diagnostics).
  assert.ok(readFileSync(parentFile, "utf8").startsWith(parentText));
});

test("model switch resets transient evidence and replaces stale SDK capacity before the next provider send", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-model-integration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  const f = await runtime(manager);
  await f.emit("session_start", { reason: "new" });
  manager.appendMessage(user("Keep this request exact", 1));
  const large = await f.project(); await f.send(large);
  f.state.providerSeenToolIds.add("old-provider-result");
  f.state.consecutiveIgnoredNudges = 9;
  f.ctx.model = { ...f.ctx.model, id: "small", contextWindow: 32_000 };
  await f.emit("model_select", { model: f.ctx.model });
  assert.equal(f.state.providerSeenToolIds.size, 0);
  assert.equal(f.state.consecutiveIgnoredNudges, 0);
  await assert.rejects(f.send(large), /aborted/);
  await f.send(await f.project());
  const report = collectDcpStatistics({ branch: manager.getBranch(), model: f.ctx.model });
  assert.equal(report.snapshot.contextWindow, 32_000);
  assert.equal(report.snapshot.inputCapacityTokens, 32_000 - 4_096);
  assert.equal(report.snapshot.model, "fixture/small");
});

test("full-reader failures, malformed results and partial cursors cannot expose a raw-history provider payload", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-read-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const read of [async () => { throw new Error("read failure"); }, async () => null, async () => [{ id: "tail", parentId: "missing" }]]) {
    const base = SessionManager.create(dir, dir);
    const f = await runtime(base); await f.emit("session_start", { reason: "new" });
    base.appendMessage(user("must not escape", 1));
    const previous = await f.project();
    f.ctx.sessionManager = new Proxy(base, { get(target, key) {
      if (key === "readFullBranchEntries") return read;
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await assert.rejects(f.project());
    await assert.rejects(f.send(previous), /aborted/);
    await f.emit("session_start", { reason: "resume" });
    await assert.rejects(f.project(), /journal is blocked/);
    await assert.rejects(f.send(previous), /journal is blocked/);
  }
});

test("obsolete async history read cannot publish after a model change", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-read-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = SessionManager.create(dir, dir), f = await runtime(base);
  await f.emit("session_start", { reason: "new" });
  base.appendMessage(user("unchanged objective", 1));
  let finish!: (value: any[]) => void;
  const pending = new Promise<any[]>((resolve) => { finish = resolve; });
  f.ctx.sessionManager = new Proxy(base, { get(target, key) {
    if (key === "readFullBranchEntries") return () => pending;
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const reading = f.project();
  const failure = assert.rejects(reading, /changed/);
  await f.emit("model_select"); finish(base.getBranch()); await failure;
  assert.equal(f.state.messageIdsByStableId.size, 0);
  await assert.rejects(f.send({ messages: [] }), /aborted/);
  f.ctx.sessionManager = base;
  await f.send(await f.project());
});

test("entry identity matching disambiguates same-role same-timestamp messages by content", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = SessionManager.create(dir, dir), f = await runtime(base);
  await f.emit("session_start", { reason: "new" });
  const first = base.appendMessage(assistant("excluded older response", 2));
  const kept = assistant("retained response", 2), second = base.appendMessage(kept);
  const tail = user("continue", 3); base.appendMessage(tail);
  await f.emit("context", { messages: [kept, tail] });
  assert.equal(f.state.messageIdsByStableId.has(`id:${first}`), false);
  assert.equal(f.state.messageIdsByStableId.has(`id:${second}`), true);
});

test("diagnostics count actual attempted and completed reminder opportunities, never context callbacks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-delivery-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir), f = await runtime(manager);
  f.config.compress.minContextPercent = 0.2;
  f.config.compress.nudgeFrequency = 1;
  Object.assign(f.config.compress.autoCandidates, { enabled: true, minContextPercent: 0.2, keepRecentTurns: 1, minMessages: 2, minTokens: 100 });
  f.ctx.getContextUsage = () => ({ tokens: 400_000, contextWindow: 1_000_000 });
  await f.emit("session_start", { reason: "new" });
  manager.appendMessage(user("Old request", 1));
  manager.appendMessage(assistant("Closed old inspection\n".repeat(500), 2));
  manager.appendMessage(user("Keep current intent", 3));
  let projected: any;
  for (let i = 0; i < 4; i++) projected = await f.project();
  const before = collectDcpStatistics({ branch: manager.getBranch(), model: f.ctx.model });
  assert.equal(before.projections, 4);
  assert.equal(before.attempts, 0);
  assert.equal(before.completed, 0);
  assert.equal(JSON.stringify(projected.messages).includes("dcp-diagnostic"), false);
  await f.send(projected); await f.send(projected);
  const message = assistant("Continuing", 4);
  await f.emit("message_end", { message });
  await f.emit("message_end", { message });
  const after = collectDcpStatistics({ branch: manager.getBranch(), model: f.ctx.model });
  assert.equal(after.attempts, 2);
  assert.equal(after.completed, 1);
  assert.equal(after.ignored, 1);
  assert.equal(after.snapshot.routineTokens, 200_000);
  assert.equal(after.snapshot.autoEnabled, false);
});

test("a late journal load from a previous session cannot overwrite the replacement session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dcp-journal-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = SessionManager.create(dir, dir), f = await runtime(a);
  await f.emit("session_start", { reason: "new" });
  a.appendMessage(user("Old session", 1));
  const oldBranch = a.getBranch();
  let finish!: (value: any[]) => void;
  f.ctx.sessionManager = new Proxy(a, { get(target, key) {
    if (key === "readFullBranchEntries") return () => new Promise<any[]>((resolve) => { finish = resolve; });
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const oldLoad = f.emit("session_start", { reason: "resume" });
  await assert.rejects(f.send({ messages: [] }), /journal is blocked/);
  const b = SessionManager.create(dir, dir);
  f.ctx.sessionManager = b;
  await f.emit("session_start", { reason: "new" });
  b.appendMessage(user("Replacement session", 5));
  finish(oldBranch); await oldLoad;
  const projected = await f.project(); await f.send(projected);
  assert.equal(JSON.stringify(projected.messages).includes("Old session"), false);
  assert.equal(JSON.stringify(projected.messages).includes("Replacement session"), true);
  assert.equal(collectDcpStatistics({ branch: b.getBranch(), model: f.ctx.model }).journal, "chain verified");
});
