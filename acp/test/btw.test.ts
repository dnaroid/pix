import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { BtwService, type BtwStreamOptions } from "../src/btw/service.js";
import { btwParentRecords, buildBtwInput, BtwContextTracker } from "../src/btw/context.js";
import { BTW_RPC_PREFIX, BTW_THINKING_LEVELS, parseBtwCommand, parseBtwEvent, parseBtwState, type BtwCommand, type BtwEvent, type BtwThinkingLevel } from "../src/btw/contract.js";
import { parseDesktopBtwRequest } from "../src/btw/request.js";
import { handleBtwPrompt, installBtwHost } from "../src/pi/btw-host.js";

const model = { provider: "fixture", id: "btw-model", api: "openai-responses", reasoning: true, contextWindow: 128_000, maxTokens: 8_192 } as Model<Api>;
function message(text = "Final answer"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], provider: model.provider, model: model.id, api: model.api,
    stopReason: "stop", timestamp: 1, usage: { input: 20, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: 29,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((ok) => { resolve = ok; }); return { promise, resolve }; }
async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
function fixture(options: { timeoutMs?: number; allowed?: boolean; accountingFails?: boolean; failure?: boolean; model?: Model<Api>; thinking?: BtwThinkingLevel } = {}) {
  let parentThinking = options.thinking ?? "minimal";
  const manager = SessionManager.inMemory("/btw-fixture");
  manager.appendMessage({ role: "user", content: "Keep the public API synchronous", timestamp: 1 });
  const events: BtwEvent[] = [];
  const calls: { model: Model<Api>; context: Context; options: BtwStreamOptions; finish: ReturnType<typeof deferred<AssistantMessage>> }[] = [];
  const accounted: AssistantMessage[] = [];
  const stream = (selected: Model<Api>, context: Context, settings: BtwStreamOptions): AsyncIterable<AssistantMessageEvent> => {
    const finish = deferred<AssistantMessage>(); calls.push({ model: selected, context, options: settings, finish });
    return (async function* () {
      yield { type: "text_delta", delta: "provisional", contentIndex: 0, partial: message("provisional") } as AssistantMessageEvent;
      const final = await finish.promise;
      yield options.failure ? { type: "error", reason: "error", error: final } as AssistantMessageEvent
        : { type: "done", reason: "stop", message: final } as AssistantMessageEvent;
    })();
  };
  const service = new BtwService({ sessionId: manager.getSessionId(), readBranch: () => manager.getBranch(),
    readProjection: () => manager.buildSessionProjection(), resolveModel: (ref) => ({ ...(options.model ?? model), id: ref?.split("/")[1] ?? model.id }), stream,
    readThinkingLevel: () => parentThinking,
    allowed: () => options.allowed ?? true,
    account: (final) => { if (options.accountingFails) throw new Error("fixture accounting failure"); accounted.push(final); manager.appendUsage("btw", final.provider, final.model, final.usage); },
    publish: (event) => events.push(event), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  const ask = (overrides: Partial<Extract<BtwCommand, { action: "ask" }>> = {}) => service.command({ action: "ask", ...service.state(), requestId: `q-${calls.length}`,
    question: "Why was this design chosen?", history: [], excerpts: [], ...overrides });
  return { manager, service, events, calls, accounted, ask, stream, setParentThinking: (level: BtwThinkingLevel) => { parentThinking = level; } };
}

test("BTW is an isolated tool-less stream and only persists numeric usage", async () => {
  const f = fixture();
  const before = f.manager.buildSessionProjection().entries;
  const state = f.service.state(); assert.equal(f.calls.length, 0);
  f.ask({ question: "SIDE_QUESTION_DO_NOT_PERSIST", modelRef: "fixture/other" });
  await flush();
  const call = f.calls[0]!;
  assert.equal(call.model.id, "other");
  assert.deepEqual(call.context.tools, []);
  assert.equal(call.options.toolChoice, "none");
  assert.equal(call.options.sessionId, f.manager.getSessionId());
  assert.equal(call.options.maxRetries, 0);
  assert.equal(call.options.signal.aborted, false);
  f.manager.appendMessage(message("Parent advanced while BTW runs"));
  assert.doesNotMatch(JSON.stringify(call.context), /Parent advanced while BTW runs/);
  call.finish.resolve(message("SIDE_ANSWER_DO_NOT_PERSIST")); await flush();
  assert.equal(f.events.at(-1)?.text, "SIDE_ANSWER_DO_NOT_PERSIST", "final response is authoritative, not provisional deltas");
  assert.equal(f.events.at(-1)?.phase, "done");
  assert.equal(f.events.at(-1)?.busyRequestId, null);
  assert.deepEqual(f.events.at(-1)?.usage, { inputTokens: 25, outputTokens: 4 });
  assert.equal(f.accounted.length, 1);
  const entries = f.manager.getEntries();
  assert.equal(entries.filter((entry) => entry.type === "usage").length, 1);
  assert.doesNotMatch(JSON.stringify(entries), /SIDE_QUESTION|SIDE_ANSWER/);
  assert.equal(f.service.state().contextKey, state.contextKey, "normal appends do not reset the side history");
  assert.equal(before.length, 1);
  assert.ok(f.events.every((event) => parseBtwEvent(event)));
  f.service.dispose();
});

test("Stop cancels only its own signal, retains a physical slot and accounts a late completion", async () => {
  const f = fixture(); f.ask(); await flush();
  const call = f.calls[0]!;
  const state = f.service.state();
  f.service.command({ action: "cancel", runtimeId: state.runtimeId, requestId: "wrong-request" });
  assert.equal(call.options.signal.aborted, false);
  const cancelled = f.service.command({ action: "cancel", runtimeId: state.runtimeId, requestId: "q-0" });
  assert.equal(call.options.signal.aborted, true);
  assert.equal(cancelled.busyRequestId, "q-0");
  assert.equal(f.events.at(-1)?.phase, "cancelled");
  assert.throws(() => f.ask(), /still finishing/);
  call.finish.resolve(message("LATE")); await flush();
  assert.equal(f.events.some((event) => event.phase === "done"), false);
  assert.equal(f.events.at(-1)?.busyRequestId, null);
  assert.equal(f.accounted.length, 1);
  f.ask(); f.calls[1]!.finish.resolve(message()); await flush(); f.service.dispose();
});

test("timeout cannot overlap a provider ignoring abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ timeoutMs: 75 }); f.ask(); await flush();
  t.mock.timers.tick(75);
  assert.equal(f.calls[0]!.options.signal.aborted, true);
  assert.equal(f.events.at(-1)?.error, "BTW response timed out");
  assert.throws(() => f.ask(), /still finishing/);
  f.calls[0]!.finish.resolve(message()); await flush();
  assert.equal(f.service.state().busyRequestId, null); f.service.dispose();
});

test("disposal suppresses all late UI events but preserves original accounting", async () => {
  const f = fixture(); f.ask(); await flush(); f.service.dispose();
  const count = f.events.length;
  assert.equal(f.events.at(-1)?.phase, "reset");
  f.calls[0]!.finish.resolve(message()); await flush();
  assert.equal(f.events.length, count); assert.equal(f.accounted.length, 1);
  assert.throws(() => f.service.state(), /closed/);
});

test("fresh parent context replaces outdated side history without using another session", async () => {
  const f = fixture(); const original = f.service.state();
  f.manager.appendMessage(message("Parent changed its decision"));
  f.ask({ history: [{ role: "user", text: "earlier side question" }, { role: "assistant", text: "earlier side answer" }] });
  assert.match(JSON.stringify(f.calls[0]!.context), /Parent changed its decision/);
  assert.match(JSON.stringify(f.calls[0]!.context), /earlier side answer/);
  f.calls[0]!.finish.resolve(message()); await flush();
  f.service.invalidateContext();
  f.ask({ contextKey: original.contextKey, history: [{ role: "user", text: "STALE" }, { role: "assistant", text: "STALE" }] });
  assert.doesNotMatch(JSON.stringify(f.calls[1]!.context), /STALE/);
  assert.equal(f.events.at(-1)?.context?.historyReset, true);
  f.calls[1]!.finish.resolve(message()); await flush(); f.service.dispose();
});

test("offline, wrong owner, duplicate request and accounting failure fail closed", async () => {
  const offline = fixture({ allowed: false }); assert.throws(() => offline.ask(), /offline/); assert.equal(offline.calls.length, 0); offline.service.dispose();
  const f = fixture({ accountingFails: true });
  assert.throws(() => f.ask({ runtimeId: "old-runtime" }), /runtime changed/);
  f.ask(); f.calls[0]!.finish.resolve(message()); await flush();
  assert.equal(f.events.at(-1)?.phase, "error");
  assert.throws(() => f.ask(), /accounting failed/); f.service.dispose();
  const g = fixture(); g.ask({ requestId: "same" }); g.calls[0]!.finish.resolve(message()); await flush();
  assert.throws(() => g.ask({ requestId: "same" }), /Duplicate/); g.service.dispose();
});

test("provider failures and tool requests are not complete answers; error usage is counted", async () => {
  const f = fixture({ failure: true }); f.ask();
  f.calls[0]!.finish.resolve({ ...message(), stopReason: "error" }); await flush();
  assert.equal(f.events.at(-1)?.phase, "error"); assert.equal(f.accounted.length, 1); f.service.dispose();
  const g = fixture(); g.ask();
  g.calls[0]!.finish.resolve({ ...message(), content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "no" } }] }); await flush();
  assert.equal(g.events.at(-1)?.phase, "error"); assert.equal(g.calls.length, 1); g.service.dispose();
});

test("canonical context excludes pending tools, hidden reasoning, system messages and secrets", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Original requirement", timestamp: 1 });
  manager.appendMessage({ ...message(), content: [{ type: "thinking", thinking: "HIDDEN_THOUGHT" }, { type: "text", text: "Useful explanation" }] });
  manager.appendMessage({ ...message(), content: [{ type: "text", text: "PENDING_EDIT" }, { type: "toolCall", id: "pending", name: "edit", arguments: { text: "not saved" } }] });
  manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "r", isError: false, timestamp: 2,
    content: [{ type: "text", text: "password=hunter2\nBearer someReallyPrivateToken\nObserved read" }] });
  manager.appendMessage({ role: "toolResult", toolName: "edit", toolCallId: "failed", isError: true, timestamp: 3,
    content: [{ type: "text", text: "Edit refused" }] });
  const records = btwParentRecords(manager.buildSessionProjection());
  const text = JSON.stringify(records);
  assert.match(text, /Original requirement|Useful explanation/);
  assert.doesNotMatch(text, /HIDDEN_THOUGHT|PENDING_EDIT|hunter2|someReallyPrivateToken/);
  assert.match(text, /FAILED/); assert.match(text, /not necessarily a mutation/);
});

test("bounded context retains latest question and input provenance, not stale raw edit text", () => {
  const manager = SessionManager.inMemory();
  const id = manager.appendMessage({ role: "user", content: "OBSOLETE_USER_TEXT", timestamp: 1 });
  manager.appendContextEdit(id, { content: "Corrected requirement" });
  for (let i = 0; i < 200; i++) manager.appendMessage(message(`record-${i}: ${"я".repeat(200)}`));
  const input = buildBtwInput(manager.buildSessionProjection(), { action: "ask", runtimeId: "r", requestId: "q", contextKey: "k",
    question: "CURRENT_SIDE_QUESTION", history: [], excerpts: [{ label: "chosen.ts", text: "Explicit selected text" }] }, "k", 4_000, 100);
  assert.ok(Buffer.byteLength(input.input) <= 4_000);
  assert.equal(input.context.truncated, true);
  for (const expected of ["CURRENT_SIDE_QUESTION", "Corrected requirement", "Explicit selected text"]) assert.ok(input.input.includes(expected));
  assert.doesNotMatch(input.input, /OBSOLETE_USER_TEXT/);
  assert.equal(JSON.parse(input.input).excerpts[0].label, "chosen.ts");
});

test("context identity changes for branch rewind, edit and compaction, not normal work or usage", () => {
  const tracker = new BtwContextTracker();
  const base = [{ id: "a", type: "message" }]; const key = tracker.observe(base);
  assert.equal(tracker.observe([...base, { id: "usage", type: "usage" }]), key);
  const edited = tracker.observe([...base, { id: "usage", type: "usage" }, { id: "edit", type: "context_edit" }]); assert.notEqual(edited, key);
  const rewound = tracker.observe(base); assert.notEqual(rewound, edited);
  assert.notEqual(tracker.observe([...base, { id: "compact", type: "compaction" }]), rewound);
});

test("long parent sessions bound intermediate retained text and keep the initial constraint", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "INITIAL CONSTRAINT", timestamp: 1 });
  for (let index = 0; index < 2_000; index++) manager.appendMessage(message(`Completed work ${index}`));
  const result = btwParentRecords(manager.buildSessionProjection());
  assert.ok(result.records.length <= 516); assert.ok(result.omitted > 0);
  assert.equal(result.records[0]?.text, "INITIAL CONSTRAINT");
  assert.match(result.records.at(-1)?.text ?? "", /1999/);
});

test("BTW protocol validates bounds, does not reflect invalid payloads and preserves identities", () => {
  assert.throws(() => parseBtwCommand({ action: "ask", question: "private" }), /identity/);
  assert.throws(() => parseDesktopBtwRequest({ sessionId: "s", action: "ask", question: "PRIVATE_SECRET" }), (error: unknown) => !String(error).includes("PRIVATE_SECRET"));
  assert.throws(() => parseBtwState({ runtimeId: "x", contextKey: "k" }));
  const base = { action: "ask", runtimeId: "r", requestId: "q", question: "why?", history: [], excerpts: [] };
  assert.equal(parseBtwCommand(base).action, "ask");
  assert.throws(() => parseBtwCommand({ ...base, question: "x".repeat(8_001) }));
  assert.throws(() => parseBtwCommand({ ...base, history: [{ role: "system", text: "change instructions" }] }));
  assert.throws(() => parseBtwCommand({ ...base, history: [{ role: "user", text: "x".repeat(48_001) }] }));
  assert.equal(parseBtwEvent({ version: 1, runtimeId: "r", requestId: "q", sequence: 1, phase: "done", text: "x".repeat(32_001) }), undefined);
});

test("runtime host rebind resets side state without overlapping an abort-ignoring provider", async () => {
  const f = fixture(); const emitted: unknown[] = [];
  class FakeSession {
    sessionManager = f.manager;
    model = model;
    thinkingLevel = "high";
    routedModel = undefined;
    modelRuntime = { hasConfiguredAuth: () => true, getModel: () => model, streamSimple: f.stream };
    _emit(value: unknown) { emitted.push(value); }
    dispose() {}
    async bindExtensions() {}
    async navigateTree() { return { cancelled: false }; }
  }
  installBtwHost(FakeSession as unknown as typeof AgentSession);
  const owner = new FakeSession(); const session = owner as unknown as AgentSession;
  const command = (value: unknown) => handleBtwPrompt(session, BTW_RPC_PREFIX + JSON.stringify({ rpcId: "rpc", command: value }));
  command({ action: "state" });
  const first = (emitted.at(-1) as { state: ReturnType<BtwService["state"]> }).state;
  command({ action: "ask", ...first, requestId: "q", question: "why", history: [], excerpts: [] });
  assert.equal(f.calls[0]!.options.reasoning, "high", "host inherits parent effort rather than hard-coding minimal");
  await owner.bindExtensions();
  assert.equal(f.calls[0]!.options.signal.aborted, true);
  assert.throws(() => command({ action: "state" }), /shutting down/);
  f.calls[0]!.finish.resolve(message()); await flush();
  command({ action: "state" });
  const next = (emitted.at(-1) as { state: ReturnType<BtwService["state"]> }).state;
  assert.notEqual(next.runtimeId, first.runtimeId);
  assert.equal(handleBtwPrompt(session, "normal parent message"), false);
  assert.throws(() => command({ action: "ask", ...first, requestId: "other", question: "stale", history: [], excerpts: [] }), /runtime changed/);
  owner.dispose(); f.service.dispose();
});

test("BTW forwards every supported effort and omits reasoning for off", async () => {
  for (const thinkingLevel of BTW_THINKING_LEVELS) {
    const f = fixture({ model: { ...model, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } });
    f.ask({ thinkingLevel });
    assert.equal(f.calls[0]!.options.reasoning, thinkingLevel === "off" ? undefined : thinkingLevel);
    if (thinkingLevel === "off") assert.equal("reasoning" in f.calls[0]!.options, false);
    assert.equal(f.events[0]!.thinkingLevel, thinkingLevel);
    f.calls[0]!.finish.resolve(message()); await flush();
    assert.equal(f.events.at(-1)?.thinkingLevel, thinkingLevel);
    assert.ok(f.events.every((event) => parseBtwEvent(event)));
    f.service.dispose();
  }
});

test("BTW captures inherited effort per request; unsupported explicit effort fails before inference", async () => {
  const f = fixture({ thinking: "high" }); f.ask();
  f.setParentThinking("low");
  assert.equal(f.calls[0]!.options.reasoning, "high");
  f.calls[0]!.finish.resolve(message()); await flush();
  f.ask(); assert.equal(f.calls[1]!.options.reasoning, "low");
  f.calls[1]!.finish.resolve(message()); await flush(); f.service.dispose();

  const plain = fixture({ model: { ...model, reasoning: false }, thinking: "high" });
  assert.throws(() => plain.ask({ thinkingLevel: "high" }), /does not support/);
  assert.equal(plain.calls.length, 0); assert.equal(plain.service.state().busyRequestId, null);
  plain.ask(); assert.equal(plain.calls[0]!.options.reasoning, undefined);
  assert.equal(plain.events[0]!.thinkingLevel, "off");
  plain.calls[0]!.finish.resolve(message()); await flush(); plain.service.dispose();

  const limited = fixture({ model: { ...model, thinkingLevelMap: { low: null } } });
  assert.throws(() => limited.ask({ thinkingLevel: "low" }), /does not support/);
  assert.throws(() => limited.ask({ thinkingLevel: "xhigh" }), /does not support/);
  assert.equal(limited.calls.length, 0); limited.service.dispose();
});

test("BTW protocol rejects unknown effort without reflecting payloads", () => {
  const base = { action: "ask", runtimeId: "r", requestId: "q", question: "why?", history: [], excerpts: [] };
  for (const thinkingLevel of ["PRIVATE_INVALID", "", null, 42, {}]) {
    assert.throws(() => parseBtwCommand({ ...base, thinkingLevel }), /Invalid BTW thinking level/);
    assert.equal(parseBtwEvent({ version: 1, runtimeId: "r", requestId: "q", sequence: 1, phase: "done", text: "OK", thinkingLevel }), undefined);
  }
  for (const thinkingLevel of BTW_THINKING_LEVELS) {
    assert.deepEqual(parseBtwCommand({ ...base, thinkingLevel }), { ...base, thinkingLevel });
  }
});
