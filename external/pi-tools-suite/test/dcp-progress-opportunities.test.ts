import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import dcpModule from "../src/dcp/index.js";
import { createState } from "../src/dcp/state.js";
import { resetCompressionProgress, settleCompressionProgress, trackCompressionProgress } from "../src/dcp/compression-progress.js";
import { providerPayloadIncludesReminder } from "../src/dcp/provider-tool-results.js";
import { decideAutoCompress } from "../src/dcp/auto-compress.js";

async function fixture(options: { auto?: boolean; tokens?: number; manual?: boolean } = {}) {
  const config = loadConfig({ homeDir: "/__dcp_progress_opportunities__" });
  config.debug = false;
  config.compress.minContextPercent = 0.25;
  config.compress.maxContextPercent = 0.46;
  config.compress.summaryBuffer = false;
  config.compress.nudgeFrequency = 1;
  config.compress.autoCandidates.minContextPercent = 0.25;
  config.compress.messageMode.minContextPercent = 0.25;
  config.compress.autoCompress = { enabled: options.auto ?? true, patience: 2, summarizerModel: [], timeoutMs: 5000 };
  config.manualMode.enabled = options.manual ?? false;
  const state = createState();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const warnings: string[] = [];
  const telemetry: any[] = [];
  const pi: any = {
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry(type: string, data: any) { telemetry.push({ type, ...data }); },
    sendMessage() {},
  };
  await dcpModule(pi, { config, state });
  const messages: any[] = [
    { id: "old-request", role: "user", timestamp: 1, content: "Investigate the old implementation." },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `history-${i}`, role: "assistant", timestamp: i + 2,
      content: `Decision ${i}: preserve the ownership checks.\n${"Investigation output with repeated details.\n".repeat(650)}`,
    })),
    { id: "current-request", role: "user", timestamp: 20, content: "Fix the issue without losing the ownership invariants." },
  ];
  let usageTokens = options.tokens ?? 73_900;
  const ctx: any = {
    cwd: "/__dcp_progress_opportunities__",
    model: { provider: "fixture", id: "model", contextWindow: 272_000, maxTokens: 4096 },
    sessionManager: { getBranch: () => [], getSessionId: () => "fixture" },
    getContextUsage: () => ({ tokens: usageTokens, contextWindow: 272_000, percent: usageTokens / 2720 }),
    ui: { notify(message: string) { warnings.push(message); } },
    abort() {},
  };
  async function emit(name: string, event: any = {}) {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
    return result;
  }
  const context = () => emit("context", { messages });
  const request = (projection: any) => emit("before_provider_request", { payload: { messages: projection.messages } });
  const complete = (content: any[] = [{ type: "text", text: "Continue working." }], stopReason = "stop") => emit("message_end", {
    message: { role: "assistant", provider: "fixture", model: "model", content, stopReason, timestamp: 30 },
  });
  return { config, state, messages, ctx, tools, warnings, telemetry, emit, context, request, complete,
    setUsage(tokens: number) { usageTokens = tokens; } };
}

describe("DCP bounded actionable opportunities", () => {
  test("routine pressure cannot spend 132 completed responses waiting for a new user turn", async () => {
    const f = await fixture();
    for (let response = 0; response < 3; response++) {
      const projected = await f.context();
      expect(f.state.compressionBlocks).toHaveLength(0);
      await f.request(projected);
      await f.complete();
      expect(f.state.consecutiveIgnoredNudges).toBe(response + 1);
      expect(f.state.consecutiveIgnoredStrongNudges).toBe(0);
    }
    const recovered = await f.context();
    expect(f.state.compressionBlocks.length).toBeGreaterThan(0);
    expect(f.state.consecutiveIgnoredNudges).toBe(0);
    expect(f.state.compressionProgress).toBeUndefined();
    expect(JSON.stringify(recovered.messages)).toContain("Fix the issue without losing");
    expect(f.warnings).toEqual([]);
  });

  test("repeated context callbacks, retries, failed streams and absent reminders do not invent opportunities", async () => {
    const f = await fixture({ auto: false });
    let projected: any;
    for (let i = 0; i < 12; i++) projected = await f.context();
    expect(f.state.consecutiveIgnoredNudges).toBe(0);
    await f.emit("before_provider_request", { payload: { messages: [{ role: "user", content: "No reminder was delivered." }] } });
    await f.complete();
    expect(f.state.consecutiveIgnoredNudges).toBe(0);
    projected = await f.context();
    await f.request(projected);
    await f.request(projected);
    await f.complete();
    await f.complete();
    expect(f.state.consecutiveIgnoredNudges).toBe(1);
    projected = await f.context();
    await f.request(projected);
    await f.complete([], "error");
    expect(f.state.consecutiveIgnoredNudges).toBe(1);
    projected = await f.context();
    await f.request(projected);
    await f.emit("model_select");
    await f.complete();
    expect(f.state.consecutiveIgnoredNudges).toBe(0);
  });

  test("a single long user turn does not rewrite its old user carrier under routine pressure", async () => {
    const f = await fixture();
    f.messages.splice(0, f.messages.length, { id: "only-user", role: "user", timestamp: 1, content: "ACTIVE_USER_REQUEST" });
    await f.context();
    for (let i = 0; i < 30; i++) {
      const content = [{ type: "text", text: "Completed read output with repeated diagnostics.\n".repeat(60) }];
      await f.emit("tool_call", { toolCallId: `read-${i}`, toolName: "read", input: { path: `file-${i}` } });
      await f.emit("tool_result", { toolCallId: `read-${i}`, toolName: "read", content, details: {}, isError: false });
      f.messages.push(
        { id: `call-${i}`, role: "assistant", timestamp: 2 + i * 2, content: [{ type: "toolCall", id: `read-${i}`, name: "read", arguments: { path: `file-${i}` } }] },
        { id: `result-${i}`, role: "toolResult", toolCallId: `read-${i}`, toolName: "read", timestamp: 3 + i * 2, content },
      );
    }
    // The first response establishes provider evidence; unseen outputs must
    // not be offered as a safe same-turn range merely to start a counter.
    await f.request(await f.context());
    await f.complete();
    expect(f.state.providerSeenToolIds.size).toBe(30);
    expect(f.state.consecutiveIgnoredNudges).toBe(0);
    for (let response = 0; response < 3; response++) {
      const projected = await f.context();
      expect(f.state.nudgeAnchors.length).toBe(0);
      await f.request(projected);
      await f.complete();
    }
    const result = await f.context();
    expect(f.state.compressionBlocks).toHaveLength(0);
    expect(f.state.consecutiveIgnoredNudges).toBe(0);
    expect(JSON.stringify(result.messages)).toContain("ACTIVE_USER_REQUEST");
    for (let i = 22; i < 30; i++) expect(result.messages.some((message: any) => message.toolCallId === `read-${i}`)).toBe(true);
  });

  test("failed compress calls still consume opportunities and cannot starve automatic recovery", async () => {
    const f = await fixture({ auto: false, tokens: 135_000 });
    for (let response = 0; response < 3; response++) {
      const projected = await f.context();
      await f.request(projected);
      const args = { topic: "Invalid attempt", ranges: [{ startId: "m999999", endId: "m999999", summary: "invalid" }] };
      await f.complete([{ type: "toolCall", id: `bad-${response}`, name: "compress", arguments: args }], "toolUse");
      await expect(f.tools.get("compress").execute(`bad-${response}`, args, undefined, undefined, f.ctx)).rejects.toThrow();
      expect(f.state.consecutiveIgnoredStrongNudges).toBe(response + 1);
      expect(f.state.consecutiveIgnoredNudges).toBe(response + 1);
      expect(f.state.compressionBlocks).toHaveLength(0);
    }
    f.config.compress.autoCompress.enabled = true;
    await f.context();
    expect(f.state.compressionBlocks.length).toBeGreaterThan(0);
    expect(f.state.consecutiveIgnoredStrongNudges).toBe(0);
    expect(f.state.consecutiveIgnoredNudges).toBe(0);
  });

  test("auto-disabled routine escalation is explicit, deduplicated and never overrides consent", async () => {
    const f = await fixture({ auto: false });
    for (let response = 0; response < 132; response++) {
      f.setUsage(73_900 + Math.floor(response * (109_600 - 73_900) / 131));
      const projected = await f.context();
      await f.request(projected);
      await f.complete();
    }
    expect(f.state.consecutiveIgnoredNudges).toBe(132);
    expect(f.state.consecutiveIgnoredStrongNudges).toBe(0);
    // The original carrier is immutable; escalation is diagnostic/automatic
    // policy state, not an in-place rewrite of previously delivered bytes.
    expect(f.state.nudgeAnchors[0]?.type).toBe("turn");
    expect(f.state.compressionBlocks).toHaveLength(0);
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("Automatic compression is disabled");
    expect(f.telemetry.filter((event) => event.event === "progress-blocked")).toHaveLength(1);
    expect(f.telemetry.find((event) => event.event === "progress-blocked")).toMatchObject({ reason: "auto-disabled" });
  });

  test("manual mode is not widened into autonomous summaries below emergency pressure", async () => {
    const f = await fixture({ manual: true });
    for (let i = 0; i < 6; i++) {
      await f.request(await f.context());
      await f.complete();
    }
    expect(f.state.consecutiveIgnoredNudges).toBe(0);
    expect(f.state.compressionBlocks).toHaveLength(0);
    expect(f.warnings).toEqual([]);
  });

  test("crossing emergency pressure does not grant fresh patience after routine opportunities", async () => {
    const f = await fixture();
    f.state.consecutiveIgnoredNudges = 3;
    f.state.consecutiveIgnoredStrongNudges = 0;
    const decision = decideAutoCompress(f.state, f.config, 0.50, 0.46, {
      startId: "m001", endId: "m005", messageCount: 5, estimatedTokens: 20_000,
      includedBlockIds: [], reason: "safe fixture",
    });
    expect(decision.shouldFire).toBe(true);
  });

  test("partial savings retain a stable remaining goal across callbacks", () => {
    const state = createState();
    state.consecutiveIgnoredNudges = 4;
    state.consecutiveIgnoredStrongNudges = 3;
    trackCompressionProgress(state, { projectedTokens: 100_000, contextWindow: 272_000, requiredTokens: 13_600, kind: "routine" });
    expect(settleCompressionProgress(state, 600, 99_400)).toBe(false);
    expect(state.consecutiveIgnoredNudges).toBe(4);
    for (let i = 0; i < 12; i++) {
      trackCompressionProgress(state, { projectedTokens: 99_400, contextWindow: 272_000, requiredTokens: 13_600, kind: "routine" });
    }
    expect(state.compressionProgress?.remainingTokens).toBe(13_000);
    expect(settleCompressionProgress(state, 13_000, 86_400)).toBe(true);
    expect(state.consecutiveIgnoredNudges).toBe(0);
    expect(state.consecutiveIgnoredStrongNudges).toBe(0);
    expect(state.compressionProgress).toBeUndefined();
    resetCompressionProgress(state);
    expect(state.compressionProgress).toBeUndefined();
  });

  test("reminder delivery detection covers provider text shapes and rejects unrelated payloads", () => {
    const reminder = "<dcp-system-reminder>\ncompress the closed range\n</dcp-system-reminder>";
    expect(providerPayloadIncludesReminder({ messages: [{ role: "user", content: reminder }] }, reminder)).toBe(true);
    expect(providerPayloadIncludesReminder({ input: [{ content: [{ type: "input_text", text: `request\n${reminder}` }] }] }, reminder)).toBe(true);
    expect(providerPayloadIncludesReminder({ messages: [{ content: "compress" }] }, reminder)).toBe(false);
    const cycle: any = {}; cycle.self = cycle;
    expect(providerPayloadIncludesReminder(cycle, reminder)).toBe(false);
  });

  test("an unchanged native usage sample cannot re-charge partial emergency savings", () => {
    const state = createState();
    state.consecutiveIgnoredNudges = 4;
    const input = { projectedTokens: 100_000, observedTokens: 135_000, targetHeadroomTokens: 125_000, contextWindow: 272_000, requiredTokens: 10_000, kind: "emergency" as const };
    trackCompressionProgress(state, input);
    expect(settleCompressionProgress(state, 1000, 99_000)).toBe(false);
    for (let i = 0; i < 12; i++) trackCompressionProgress(state, { ...input, projectedTokens: 99_000 });
    expect(state.compressionProgress?.remainingTokens).toBe(9000);
    trackCompressionProgress(state, { ...input, projectedTokens: 99_000, observedTokens: 138_000 });
    expect(state.compressionProgress?.remainingTokens).toBe(12_000);
    trackCompressionProgress(state, { ...input, projectedTokens: 99_000, observedTokens: 138_000, targetHeadroomTokens: 120_000 });
    expect(state.compressionProgress?.remainingTokens).toBe(17_000);
  });
});
