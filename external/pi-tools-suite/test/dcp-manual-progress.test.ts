import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import { registerCompressTool, type CompressToolDependencies } from "../src/dcp/compress-tool.js";
import { applyPruning, upsertNudgeAnchor } from "../src/dcp/pruner.js";
import { estimateMessageTokens } from "../src/dcp/pruner-metadata.js";
import { createState, serializeState } from "../src/dcp/state.js";

function fixture(options: { text?: string; protectUser?: boolean; protectTags?: boolean; dependencies?: CompressToolDependencies } = {}) {
  const config = loadConfig({ homeDir: "/__dcp_manual_progress_fixture__" });
  config.debug = false;
  config.strategies.autoToolPruning.enabled = false;
  config.strategies.deduplication.enabled = false;
  config.strategies.purgeErrors.enabled = false;
  config.compress.protectUserMessages = options.protectUser ?? false;
  config.compress.protectTags = options.protectTags ?? false;
  const state = createState();
  const messages: any[] = [
    { id: "old-user", role: "user", timestamp: 1, content: "Investigate. <protect>MUST_KEEP_EXACT</protect>" },
    { id: "old-assistant", role: "assistant", timestamp: 2, content: options.text ?? "Decision: preserve ownership.\nRepeated diagnostic details.\n".repeat(500) },
    { id: "current-user", role: "user", timestamp: 20, content: "CURRENT_REQUEST_MUST_SURVIVE" },
  ];
  let tool: any;
  const telemetry: any[] = [];
  registerCompressTool({
    registerTool(value: any) { tool = value; },
    appendEntry(_type: string, value: any) { telemetry.push(value); },
  } as any, state, config, options.dependencies);
  const ctx = { sessionManager: {}, ui: { notify() {} } };
  const context = () => applyPruning(messages, state, config);
  const visibleId = (id: string) => {
    const entry = [...state.messageMetaSnapshot].find(([, meta]) => meta.stableId === `id:${id}`);
    if (!entry) throw new Error(`Missing fixture ID ${id}`);
    return entry[0];
  };
  let calls = 0;
  const execute = (args: any) => tool.execute(`manual-${++calls}`, args, undefined, undefined, ctx);
  context();
  return { config, state, messages, context, visibleId, execute, telemetry };
}

const stateBytes = (state: ReturnType<typeof createState>) => JSON.stringify(serializeState(state));

describe("DCP manual compression progress", () => {
  test("modern rollup replaces old summary prose while retaining protected fragments exactly once", async () => {
    const f = fixture({ protectTags: true });
    const oldSummary = "OLD_SUMMARY_DETAIL ".repeat(300);
    await f.execute({ topic: "First", ranges: [{ startId: f.visibleId("old-user"), endId: f.visibleId("old-assistant"), summary: oldSummary }] });
    f.context();
    const requested = "Decision: keep ownership checks and continue verification.";
    const result = await f.execute({ topic: "Rollup", ranges: [{ startId: "b1", endId: "b1", summary: requested }] });
    const rolled = f.state.compressionBlocks.find((block) => block.id === 2)!;
    expect(rolled.summary).toContain(requested);
    expect(rolled.summary).not.toContain("OLD_SUMMARY_DETAIL");
    expect(rolled.summary.match(/MUST_KEEP_EXACT/g)).toHaveLength(1);
    expect(rolled.protectedFragments).toHaveLength(1);
    expect(rolled.coveredBlockIds).toEqual([1]);
    expect(result.details.netGain).toBeGreaterThan(500);
    expect(result.details.projectedAfterTokens).toBeLessThan(result.details.projectedBeforeTokens);
    expect(JSON.stringify(f.context())).toContain("CURRENT_REQUEST_MUST_SURVIVE");
  });

  test("explicit modern block references expand once and unknown references fail atomically", async () => {
    const f = fixture();
    const oldSummary = "KNOWN_OLD_SUMMARY ".repeat(50);
    await f.execute({ topic: "First", ranges: [{ startId: f.visibleId("old-user"), endId: f.visibleId("old-assistant"), summary: oldSummary }] });
    f.messages.splice(2, 0, { id: "extra", role: "assistant", timestamp: 3, content: "More repetitive work.\n".repeat(1000) });
    f.context();
    const before = stateBytes(f.state);
    await expect(f.execute({ topic: "Bad", ranges: [{ startId: "b1", endId: f.visibleId("extra"), summary: "Keep (b999999)" }] })).rejects.toThrow(/unverifiable block/);
    expect(stateBytes(f.state)).toBe(before);
    await f.execute({ topic: "Explicit", ranges: [{ startId: "b1", endId: f.visibleId("extra"), summary: "Retain (b1); duplicate reference (b1). Extra work is complete." }] });
    const summary = f.state.compressionBlocks.at(-1)!.summary;
    expect(summary.split(oldSummary)).toHaveLength(2);
    expect(summary).not.toContain("(b1)");
  });

  test("legacy rollup retains old summary instead of silently losing it", async () => {
    const f = fixture();
    const oldSummary = "LEGACY_FACTS_MUST_SURVIVE ".repeat(40);
    await f.execute({ topic: "Legacy", ranges: [{ startId: f.visibleId("old-user"), endId: f.visibleId("old-assistant"), summary: oldSummary }] });
    delete f.state.compressionBlocks[0]!.protectedFragments;
    f.messages.splice(2, 0, { id: "extra", role: "assistant", timestamp: 3, content: "Uncompressed work to summarize.\n".repeat(1000) });
    f.context();
    const result = await f.execute({ topic: "Safe legacy rollup", ranges: [{ startId: "b1", endId: f.visibleId("extra"), summary: "Extra work is complete." }] });
    expect(f.state.compressionBlocks.at(-1)!.summary).toContain(oldSummary);
    expect(result.details.netGain).toBeGreaterThan(0);
  });

  test("a longer summary cannot publish state, clear reminders or erase patience", async () => {
    let writes = 0;
    const f = fixture({ text: "tiny source", dependencies: {
      capturePersistenceTarget: () => ({ statePath: "/never-written", sessionId: "fixture" }),
      saveStateToTarget: async () => { writes++; },
    } });
    f.state.consecutiveIgnoredNudges = 4;
    f.state.consecutiveIgnoredStrongNudges = 3;
    upsertNudgeAnchor(f.context(), f.state, "iteration", { renderedReminder: "keep nudging" });
    const before = stateBytes(f.state);
    await expect(f.execute({ topic: "Expansion", messages: [{ messageId: f.visibleId("old-assistant"), summary: "Much larger summary.\n".repeat(1000) }] })).rejects.toThrow(/non-positive full-projection gain/);
    expect(writes).toBe(0);
    expect(stateBytes(f.state)).toBe(before);
    expect(f.state.consecutiveIgnoredNudges).toBe(4);
    expect(f.telemetry).toEqual([]);
  });

  test("wrapper and ID-carrier overhead can reject a nominally shorter summary", async () => {
    const f = fixture({ text: "x".repeat(120) });
    const before = stateBytes(f.state);
    await expect(f.execute({ topic: "Wrapper overhead", messages: [{ messageId: f.visibleId("old-assistant"), summary: "y".repeat(100) }] })).rejects.toThrow(/non-positive full-projection gain/);
    expect(stateBytes(f.state)).toBe(before);
  });

  test("protected-fragment expansion participates in the gain proof", async () => {
    const f = fixture({ protectUser: true, text: "untouched" });
    const before = stateBytes(f.state);
    await expect(f.execute({ topic: "Protected", ranges: [{ startId: f.visibleId("old-user"), endId: f.visibleId("old-user"), summary: "tiny" }] })).rejects.toThrow(/non-positive full-projection gain/);
    expect(stateBytes(f.state)).toBe(before);
  });

  test("overlapping mixed selections and a net-negative batch leave no partial commit", async () => {
    const f = fixture();
    const first = f.visibleId("old-user"), last = f.visibleId("old-assistant");
    const before = stateBytes(f.state);
    await expect(f.execute({ topic: "Overlap", ranges: [{ startId: first, endId: last, summary: "short" }], messages: [{ messageId: last, summary: "also short" }] })).rejects.toThrow(/Overlapping compression selections/);
    expect(stateBytes(f.state)).toBe(before);
    await expect(f.execute({ topic: "Bad batch", messages: [
      { messageId: last, summary: "short valid summary" },
      { messageId: first, summary: "long invalid summary\n".repeat(5000) },
    ] })).rejects.toThrow(/non-positive full-projection gain/);
    expect(stateBytes(f.state)).toBe(before);
  });

  test("a missing runtime projection is not replaced by a guessed metadata estimate", async () => {
    const f = fixture();
    f.state.conversationIndexSnapshot = structuredClone(f.state.conversationIndexSnapshot);
    const before = stateBytes(f.state);
    await expect(f.execute({ topic: "No snapshot", messages: [{ messageId: f.visibleId("old-assistant"), summary: "short" }] })).rejects.toThrow(/verifiable provider projection/);
    expect(stateBytes(f.state)).toBe(before);
  });

  test("partial positive savings keep debt and patience until a sufficient commit", async () => {
    const f = fixture();
    const projection = f.context();
    const tokens = projection.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    f.state.consecutiveIgnoredNudges = 4;
    f.state.consecutiveIgnoredStrongNudges = 3;
    f.state.compressionProgress = { remainingTokens: 4000, projectedTokens: tokens, contextWindow: 272_000, kind: "routine" };
    upsertNudgeAnchor(projection, f.state, "iteration", { renderedReminder: "keep nudging" });
    const partialSummary = String(f.messages[1].content).slice(0, -2000);
    const partial = await f.execute({ topic: "Partial", messages: [{ messageId: f.visibleId("old-assistant"), summary: partialSummary }] });
    expect(partial.details.netGain).toBeGreaterThan(0);
    expect(partial.details.netGain).toBeLessThan(4000);
    expect(partial.details.pressureRelieved).toBe(false);
    expect(f.state.compressionProgress?.remainingTokens).toBe(4000 - partial.details.netGain);
    expect(f.state.consecutiveIgnoredNudges).toBe(4);
    expect(f.state.consecutiveIgnoredStrongNudges).toBe(3);
    expect(f.telemetry.at(-1)).toMatchObject({ reason: "compress-partial", pressureRelieved: false });
    f.context();
    const done = await f.execute({ topic: "Enough", ranges: [{ startId: "b1", endId: "b1", summary: "Ownership checks must remain; diagnostics are complete." }] });
    expect(done.details.pressureRelieved).toBe(true);
    expect(f.state.consecutiveIgnoredNudges).toBe(0);
    expect(f.state.consecutiveIgnoredStrongNudges).toBe(0);
    expect(f.state.compressionProgress).toBeUndefined();
  });

  test("persistence failure rolls back a positive preparation including progress state", async () => {
    const f = fixture({ dependencies: {
      capturePersistenceTarget: () => ({ statePath: "/never-written", sessionId: "fixture" }),
      saveStateToTarget: async () => { throw new Error("fixture persistence failure"); },
    } });
    f.state.consecutiveIgnoredNudges = 4;
    f.state.compressionProgress = { remainingTokens: 4000, projectedTokens: 10_000, contextWindow: 272_000, kind: "routine" };
    const before = stateBytes(f.state);
    await expect(f.execute({ topic: "Must rollback", messages: [{ messageId: f.visibleId("old-assistant"), summary: "Ownership checks remain." }] })).rejects.toThrow("fixture persistence failure");
    expect(stateBytes(f.state)).toBe(before);
    expect(f.telemetry).toEqual([]);
  });

  test("unselected signed assistant and parallel tool results remain byte-stable", async () => {
    const f = fixture();
    const signed = { id: "signed", role: "assistant", timestamp: 21, content: [
      { type: "thinking", thinking: "opaque reasoning", thinkingSignature: "signature" },
      { type: "toolCall", id: "left", name: "read", arguments: { path: "left" } },
      { type: "toolCall", id: "right", name: "read", arguments: { path: "right" } },
    ] };
    f.messages.push(signed,
      { id: "left-result", role: "toolResult", toolCallId: "left", toolName: "read", timestamp: 22, content: [{ type: "text", text: "LEFT_RESULT" }] },
      { id: "right-result", role: "toolResult", toolCallId: "right", toolName: "read", timestamp: 23, content: [{ type: "text", text: "RIGHT_RESULT" }] });
    const beforeProjection = f.context();
    const protectedBefore = beforeProjection.filter((message) => message.id === "signed" || message.toolCallId);
    await f.execute({ topic: "Old work", messages: [{ messageId: f.visibleId("old-assistant"), summary: "Ownership checks remain." }] });
    const afterProjection = f.context();
    expect(afterProjection.filter((message) => message.id === "signed" || message.toolCallId)).toEqual(protectedBefore);
    expect(signed.content[0]).toEqual({ type: "thinking", thinking: "opaque reasoning", thinkingSignature: "signature" });
  });
});
