import { describe, expect, test } from "bun:test";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import dcpModule from "../src/dcp/index.js";
import { loadConfig } from "../src/dcp/config.js";
import { createState } from "../src/dcp/state.js";
import { FreshToolResultTracker } from "../src/dcp/fresh-tool-results.js";
import { applyAnchoredNudges, hasCacheSafeNudgeCarrier, upsertNudgeAnchor } from "../src/dcp/pruner-nudge.js";

const text = (message: any) => typeof message.content === "string"
  ? message.content : message.content.map((part: any) => part.text ?? "").join("");
const reminder = "<dcp-system-reminder>compress the closed slice</dcp-system-reminder>";

async function runtime() {
  const config = loadConfig({ homeDir: "/__dcp_fresh_nudge__" });
  config.debug = false;
  config.compress.minContextPercent = 0.25;
  config.compress.maxContextPercent = 0.65;
  config.compress.summaryBuffer = false;
  config.compress.nudgeFrequency = 1;
  config.compress.iterationNudgeThreshold = 4;
  config.compress.autoCandidates.minMessages = 2;
  config.compress.autoCandidates.minTokens = 100;
  config.compress.autoCompress.enabled = false;
  config.strategies.emergencyCurrentTurnPruning.keepRecentToolPairs = 2;
  const state = createState();
  const handlers = new Map<string, any[]>();
  const entries: any[] = [];
  const messages: any[] = [{ id: "user", role: "user", timestamp: 1, content: "Keep API stable; investigate." }];
  let tokens = 1_000;
  let counter = 0;
  const ctx: any = {
    cwd: "/__dcp_fresh_nudge__",
    model: { provider: "fixture", id: "model", contextWindow: 100_000, maxTokens: 1_000 },
    sessionManager: { getBranch: () => [], getSessionId: () => "fresh-nudge" },
    getContextUsage: () => ({ tokens, contextWindow: 100_000 }),
    ui: { notify() {} },
    abort() { throw new Error("Unexpected abort"); },
  };
  await dcpModule({
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool() {}, registerCommand() {}, sendMessage() {},
    appendEntry(type: string, data: any) { entries.push({ type, data }); },
  } as any, { config, state });
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
    return result;
  };
  const project = () => emit("context", { messages });
  const send = (projection: any) => emit("before_provider_request", { payload: { messages: projection.messages } });
  const complete = (stopReason = "toolUse") => emit("message_end", {
    message: { role: "assistant", provider: "fixture", model: "model", stopReason, content: [] },
  });
  const pair = async (live = false, timestamp?: number) => {
    const id = `call-${++counter}`;
    const time = timestamp ?? counter * 2;
    const call = { toolCallId: id, toolName: "read", input: { path: `file-${counter}.ts` } };
    messages.push({ id: `a-${counter}`, role: "assistant", timestamp: time, content: [
      { type: "toolCall", id, name: "read", arguments: call.input },
    ] });
    if (live) await emit("tool_call", call);
    const result = { id: `t-${counter}`, role: "toolResult", toolCallId: id, toolName: "read", timestamp: time + 1,
      content: [{ type: "text", text: `Decision: keep API ${counter}.\n${"diagnostic\n".repeat(250)}` }], isError: false };
    messages.push(result);
    if (live) await emit("tool_result", result);
    return result;
  };
  await emit("session_start", { reason: "new" });
  for (let index = 0; index < 5; index++) await pair();
  await send(await project());
  await complete();
  return { state, config, messages, entries, emit, project, send, complete, pair, pressure(value = 40_000) { tokens = value; } };
}

describe("DCP fresh tool-result reminders", () => {
  test("single-user turn delivers a concrete reminder on the fresh tool tail without changing the sent prefix", async () => {
    const f = await runtime();
    const before = await f.project();
    await f.send(before);
    await f.complete();
    const raw = await f.pair(true);
    f.pressure();
    const projected = await f.project();
    expect(projected.messages.slice(0, before.messages.length)).toEqual(before.messages);
    const model = { id: "fixture", provider: "openai-codex", api: "openai-codex-responses", input: ["text"], reasoning: true, compat: {} } as any;
    const serialize = (messages: any[]) => convertResponsesMessages(model, { systemPrompt: "", messages, tools: [] } as any, new Set(["openai-codex"]));
    const previousPayload = serialize(before.messages);
    const nextPayload = serialize(projected.messages);
    expect(nextPayload.slice(0, previousPayload.length)).toEqual(previousPayload);
    expect(JSON.stringify(nextPayload.at(-1))).toContain("<dcp-system-reminder>");
    expect(text(projected.messages.at(-1))).toContain("CONCRETE NEXT ACTION");
    expect(text(projected.messages.at(-1))).toContain("Recommended range candidate:");
    expect(text(raw)).not.toContain("<dcp-system-reminder>");
    expect(f.state.nudgeAnchors[0]?.anchorRole).toBe("toolResult");
    expect(f.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(f.state.compressionBlocks).toHaveLength(0);
    await f.send(projected);
    await f.complete();
    expect(f.state.consecutiveIgnoredNudges).toBe(1);
    const retry = await f.project();
    expect(retry.messages).toEqual(projected.messages);
    expect(serialize(retry.messages)).toEqual(nextPayload);
    f.pressure(70_000);
    expect((await f.project()).messages).toEqual(projected.messages);
  });

  test("failed or omitted-result sends consume freshness; duplicate result events cannot revive it", async () => {
    const f = await runtime();
    const result = await f.pair(true);
    const quiet = await f.project();
    // Even an ambiguous payload consumes grants; missing successful evidence
    // does not prove that the earlier result was never sent.
    await f.send({ messages: [] });
    await f.emit("after_provider_response", { status: 500, headers: {} });
    await f.complete("error");
    await f.emit("tool_result", result);
    f.pressure();
    expect(f.state.providerSeenToolIds.has(result.toolCallId)).toBe(false);
    expect((await f.project()).messages).toEqual(quiet.messages);
    expect(f.state.nudgeAnchors).toHaveLength(0);
    await f.pair(true);
    expect(text((await f.project()).messages.at(-1))).toContain("<dcp-system-reminder>");
  });

  test.each(["session_start", "model_select", "session_tree", "session_compact"])(
    "%s invalidates local grants and late results, but allows a new post-send local result", async (event: string) => {
      const f = await runtime();
      const result = await f.pair(true);
      await f.emit("tool_call", { toolCallId: "late-call", toolName: "read", input: {} });
      await f.emit(event, { reason: "startup" });
      await f.emit("tool_result", { ...result, toolCallId: "late-call" });
      f.pressure();
      const projected = await f.project();
      expect(f.state.nudgeAnchors).toHaveLength(0);
      expect(projected.messages.some((message: any) => text(message).includes("<dcp-system-reminder>"))).toBe(false);
      await f.send(projected);
      await f.complete();
      await f.pair(true);
      expect(text((await f.project()).messages.at(-1))).toContain("<dcp-system-reminder>");
    },
  );

  test("parallel equal-timestamp results anchor only the last fresh member, and never rebind by timestamp", async () => {
    const state = createState();
    const results = ["one", "two"].map((id) => ({ id, role: "toolResult", toolName: "read", toolCallId: id,
      timestamp: 10, content: [{ type: "text", text: id }] }));
    const anchor = upsertNudgeAnchor(results, state, "iteration", {
      renderedReminder: reminder, freshToolResultIds: new Set(["one", "two"]),
    }).anchor;
    expect(anchor?.anchorStableId).toBe("id:two");
    applyAnchoredNudges(results, state, () => { throw new Error("Frozen text must be reused"); });
    expect(text(results[0])).toBe("one");
    expect(text(results[1])).toContain(reminder);
    const wrong = [{ ...results[0] }];
    expect(hasCacheSafeNudgeCarrier(results, undefined, state.nudgeAnchors)).toBe(true);
    expect(hasCacheSafeNudgeCarrier(wrong, undefined, state.nudgeAnchors)).toBe(false);
    expect(applyAnchoredNudges(wrong, state, () => reminder).rendered).toBe(false);
    expect(text(wrong[0])).toBe("one");
  });

  test("missing local lifecycle, reused IDs, and duplicate tail results never establish freshness", () => {
    const tracker = new FreshToolResultTracker();
    tracker.toolCall("old", "read", false);
    tracker.toolResult("old", "read");
    expect(tracker.eligibleIds.size).toBe(0);
    tracker.beforeProviderRequest();
    tracker.toolResult("old", "read");
    tracker.toolCall("old", "read", true);
    tracker.toolResult("old", "read");
    expect(tracker.eligibleIds.size).toBe(0);
    tracker.toolCall("new", "read", false);
    tracker.toolResult("new", "read");
    const result = { id: "new", role: "toolResult", toolCallId: "new", timestamp: 1, content: "body" };
    expect(upsertNudgeAnchor([result, { ...result, id: "duplicate" }], createState(), "iteration", {
      freshToolResultIds: tracker.eligibleIds, renderedReminder: reminder,
    }).anchor).toBeNull();
    tracker.reset();
    expect(tracker.eligibleIds.size).toBe(0);
  });

  test("a lower usage sample does not erase a published tool reminder from the prefix", async () => {
    const f = await runtime();
    await f.pair(true);
    f.pressure();
    const projected = await f.project();
    await f.send(projected);
    await f.complete();
    f.pressure(1_000);
    expect((await f.project()).messages).toEqual(projected.messages);
  });

  test("retry with a frozen tool reminder does not bypass automatic-compression patience", async () => {
    const f = await runtime();
    f.config.compress.autoCompress.enabled = true;
    f.config.compress.autoCompress.patience = 2;
    f.config.compress.autoCompress.summarizerModel = [];
    f.config.compress.autoCompress.summarizerFallbackModels = [];
    await f.pair(true);
    f.pressure(70_000); // Above soft pressure, below the hard safety boundary.
    const projected = await f.project();
    expect(text(projected.messages.at(-1))).toContain("<dcp-system-reminder>");
    expect(f.state.compressionBlocks).toHaveLength(0);
    await f.send(projected);
    await f.complete("error");
    expect(f.state.consecutiveIgnoredNudges).toBe(0);

    // The result is no longer fresh, but the journaled reminder is still a
    // safe, unchanged delivery. Retrying must not pretend delivery is impossible
    // and bypass patience via cache-safe-reminder-unavailable.
    const retry = await f.project();
    expect(f.state.compressionBlocks).toHaveLength(0);
    expect(retry.messages).toEqual(projected.messages);
    await f.send(retry);
    await f.complete();
    expect(f.state.consecutiveIgnoredNudges).toBe(1);
    expect((await f.project()).messages).toEqual(projected.messages);
    expect(f.state.compressionBlocks).toHaveLength(0);

    // Retaining the reminder must not disable the fallback either: after the
    // configured number of real completed opportunities it still compresses.
    for (let ignored = 2; ignored <= 3; ignored++) {
      await f.send(await f.project());
      await f.complete();
      expect(f.state.consecutiveIgnoredNudges).toBe(ignored);
    }
    await f.project();
    expect(f.state.compressionBlocks.length).toBeGreaterThan(0);
  });
});
