import { describe, expect, test } from "bun:test";
import dcpModule from "../src/dcp/index.js";
import { loadConfig } from "../src/dcp/config.js";
import { createState } from "../src/dcp/state.js";
import { estimateMessageTokens } from "../src/dcp/pruner-metadata.js";
import { prepareRequestWithLimits } from "../src/claude-code-provider/src/context-serializer.js";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const countTokens = (messages: any[]) => messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

/** Real DCP hooks/tool, with a scripted provider usage sample (no Gateway). */
async function fixture(overhead = 14_000) {
  const config = loadConfig({ homeDir: "/__dcp_post_compress_usage__" });
  config.debug = false;
  config.compress.minContextPercent = 0.30;
  config.compress.maxContextPercent = 0.70;
  config.compress.summaryBuffer = false;
  config.compress.nudgeFrequency = 1;
  config.compress.autoCompress.enabled = false;
  config.compress.autoCandidates.minContextPercent = 0.30;
  config.compress.autoCandidates.minTokens = 100;
  config.compress.autoCandidates.minMessages = 2;
  config.compress.messageMode.minContextPercent = 0.30;
  const state = createState();
  const handlers = new Map<string, any[]>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const messages: any[] = [];
  let nativeTokens = 1_000;
  let time = 0;
  let aborts = 0;
  const ctx: any = {
    cwd: "/__dcp_post_compress_usage__",
    model: { provider: "fixture", id: "model", contextWindow: 100_000, maxTokens: 1_000 },
    sessionManager: { getBranch: () => [], getSessionId: () => "post-compress-usage" },
    getContextUsage: () => ({ tokens: nativeTokens, contextWindow: ctx.model.contextWindow }),
    ui: { notify() {} },
    abort() { aborts++; },
  };
  await dcpModule({
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {}, sendMessage() {},
    appendEntry(type: string, data: any) { entries.push({ type, data }); },
  } as any, { config, state });
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
    return result;
  };
  const append = (message: any) => {
    message.timestamp = ++time;
    message.id = `entry-${time}`;
    messages.push(message);
    return message;
  };
  const project = () => emit("context", { messages });
  const send = (projection: any) => emit("before_provider_request", { payload: { messages: projection.messages } });
  const pair = async (id: string, output: string, live = false) => {
    const input = { path: `${id}.ts` };
    append({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: input }] });
    if (live) await emit("tool_call", { toolCallId: id, toolName: "read", input });
    const result = append({ role: "toolResult", toolCallId: id, toolName: "read",
      content: [{ type: "text", text: output }], isError: false });
    if (live) await emit("tool_result", result);
  };
  await emit("session_start", { reason: "new" });
  append({ role: "user", content: "Investigate the old code; preserve the API." });
  for (let i = 0; i < 10; i++) await pair(`old-${i}`, `Decision: inspection ${i} complete.\n${"completed diagnostic detail\n".repeat(600)}`);
  append({ role: "user", content: "Implement the agreed change, then run tests." });
  await pair("current", "Ready to implement.", true);
  nativeTokens = countTokens(messages) + overhead;
  const before = await project();
  await send(before);
  const last = state.conversationIndexSnapshot.find((entry) => entry.toolCallId === "old-7" && entry.role === "toolResult")!;
  const args = { topic: "Completed inspection", ranges: [{ startId: "m001", endId: last.visibleId!,
    summary: "Inspection complete. Preserve the public API. The remaining user request is implementation and tests." }] };
  const assistant = append({ role: "assistant", provider: "fixture", model: "model", stopReason: "toolUse",
    content: [{ type: "toolCall", id: "compress-1", name: "compress", arguments: args }],
    usage: { input: countTokens(before.messages) + overhead, output: 100, cacheRead: 0, cacheWrite: 0,
      totalTokens: countTokens(before.messages) + overhead + 100 } });
  await emit("message_end", { message: assistant });
  await emit("tool_call", { toolCallId: "compress-1", toolName: "compress", input: args });
  const compressed = await tools.get("compress").execute("compress-1", args, undefined, undefined, ctx);
  const result = append({ role: "toolResult", toolCallId: "compress-1", toolName: "compress", ...compressed, isError: false });
  await emit("tool_result", result);
  // Like SDK usage: the last successful assistant's measured total plus raw tail.
  nativeTokens = assistant.usage.totalTokens + estimateMessageTokens(result);
  return { state, config, entries, messages, ctx, compressed, before, project, send, emit, append, pair,
    get aborts() { return aborts; },
    get nativeTokens() { return nativeTokens; }, setNative(value: number) { nativeTokens = value; } };
}

const emittedNudges = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.entries.filter((entry) => entry.type === "dcp-nudge" && entry.data.event === "emitted");

describe("DCP post-compression provider usage", () => {
  test("Claude serialization changes at compression, then preserves the new prefix across appends", async () => {
    const f = await fixture();
    const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(join(artifacts, "dcp-cache-serialization-"));
    const prepare = (messages: any[]) => prepareRequestWithLimits({ systemPrompt: "fixed system", messages,
      tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }] } as any, {}, root);
    try {
      const before = await prepare(f.before.messages);
      const rewritten = await prepare((await f.project()).messages);
      expect(rewritten.transcriptBytes).toBeLessThan(before.transcriptBytes);
      expect(rewritten.transcriptBlocks[0]).toBe(before.transcriptBlocks[0]);
      expect(rewritten.transcriptBlocks[1]).not.toBe(before.transcriptBlocks[1]);
      expect(await readFile(rewritten.systemPromptPath, "utf8")).toBe(await readFile(before.systemPromptPath, "utf8"));
      expect(await readFile(rewritten.catalogPath!, "utf8")).toBe(await readFile(before.catalogPath!, "utf8"));
      // A repeated projection and two ordinary continuations must not rebuild
      // older bytes. This proves request shape only, not a server cache hit.
      expect((await prepare((await f.project()).messages)).transcriptBlocks).toEqual(rewritten.transcriptBlocks);
      let previous = rewritten;
      for (const content of ["Continue implementation.", "Then verify the result."]) {
        f.append({ role: "user", content });
        const next = await prepare((await f.project()).messages);
        expect(next.transcriptBlocks.slice(0, previous.transcriptBlocks.length)).toEqual(previous.transcriptBlocks);
        previous = next;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("plain final responses emit correlated usage even without a delivery commit", async () => {
    const f = await fixture();
    await f.send(await f.project());
    const message = f.append({ role: "assistant", provider: "fixture", model: "model", stopReason: "stop",
      content: [{ type: "text", text: "Done." }], usage: { input: 2, output: 10, cacheRead: 100, cacheWrite: 20 } });
    await f.emit("message_end", { message });
    // All prior result IDs are now seen. A further plain final completion has
    // no new evidence to commit, but still needs an observational usage record.
    await f.send(await f.project());
    const commits = f.entries.filter(e => e.type === "dcp-diagnostic" && e.data.event === "completion").length;
    await f.emit("message_end", { message: { ...message, timestamp: message.timestamp + 1 } });
    expect(f.entries.filter(e => e.type === "dcp-diagnostic" && e.data.event === "completion")).toHaveLength(commits);
    const request = f.entries.filter(e => e.type === "dcp-diagnostic" && e.data.event === "request").at(-1)!.data;
    expect(typeof request.contentRevision).toBe("string");
    expect(request).toMatchObject({ attempts: 1, ambiguous: false });
    const observed = f.entries.filter(e => e.type === "dcp-diagnostic" && e.data.event === "usage").at(-1)!.data;
    expect(observed).toMatchObject({ scope: "assistant-message-reported", correlation: "promote",
      lastRequestId: request.id, cacheRead: 100, cacheWrite: 20, attempts: 1 });
    await f.emit("message_end", { message: { ...message, stopReason: "error" } });
    expect(f.entries.at(-1)!.data).toMatchObject({ event: "usage", correlation: "refused", lastRequestId: null });
  });

  test("does not issue another routine nudge for the pre-compression usage sample", async () => {
    const f = await fixture();
    expect(f.compressed.details.pressureRelieved).toBe(true);
    expect(f.nativeTokens).toBeGreaterThan(30_000);
    const nudgesBefore = emittedNudges(f).length;
    const after = await f.project();
    expect(countTokens(after.messages) + 14_000).toBeLessThan(30_000);
    expect(emittedNudges(f).length).toBe(nudgesBefore);
    // Repeated projections/retries must not repeatedly subtract the same gain.
    expect((await f.project()).messages).toEqual(after.messages);
  });

  test("retains provider overhead rather than trusting the small local history alone", async () => {
    const f = await fixture(35_000);
    const nudgesBefore = emittedNudges(f).length;
    const after = await f.project();
    expect(countTokens(after.messages)).toBeLessThan(30_000);
    expect(emittedNudges(f).length).toBeGreaterThan(nudgesBefore);
  });

  test("new tool output can immediately restore routine pressure", async () => {
    const f = await fixture();
    await f.project();
    const nudgesBefore = emittedNudges(f).length;
    await f.pair("new-large", "new diagnostic detail\n".repeat(5_000), true);
    f.setNative(f.nativeTokens + 25_000);
    await f.project();
    expect(emittedNudges(f).length).toBeGreaterThan(nudgesBefore);
  });

  test("model changes invalidate any correction from the previous model", async () => {
    const f = await fixture();
    await f.project();
    f.ctx.model.id = "other-model";
    await f.emit("model_select");
    await f.pair("new-model", "New model continues the task.", true);
    await f.send(await f.project());
    const snapshot = f.entries.filter((entry) => entry.type === "dcp-diagnostic" && entry.data.event === "request").at(-1)!.data.snapshot;
    // Model switches also clear provider-seen evidence; an eligible nudge
    // candidate is not guaranteed, but pressure must remain uncorrected.
    expect(snapshot.routineUsageAdjustmentTokens).toBe(0);
    expect(snapshot.routineProjectedTokens).toBeGreaterThan(30_000);
    expect(snapshot.pressure).toBe("routine");
  });

  test("the existing automatic hard recovery still blocks an oversized protected task", async () => {
    const f = await fixture();
    await f.project();
    // Exercise the existing automatic safety path, as in the user config.
    f.config.compress.autoCompress.enabled = true;
    f.config.compress.autoCompress.summarizerModel = [];
    f.config.compress.autoCompress.summarizerFallbackModels = [];
    f.ctx.model.maxTokens = 95_000;
    await f.emit("model_select");
    f.append({ role: "user", content: "Required current task detail.\n".repeat(4_000) });
    await f.project();
    expect(f.aborts).toBeGreaterThan(0);
  });

  test("a fresh correlated provider sample retires the old compression adjustment", async () => {
    const f = await fixture();
    const after = await f.project();
    await f.send(after);
    const message = f.append({ role: "assistant", provider: "fixture", model: "model", stopReason: "stop",
      content: [{ type: "text", text: "Continue with the current plan." }],
      usage: { input: 45_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 45_100 } });
    await f.emit("message_end", { message });
    f.setNative(45_100);
    await f.pair("fresh-result", "Next step needs context.", true);
    const nudgesBefore = emittedNudges(f).length;
    await f.send(await f.project());
    expect(emittedNudges(f).length).toBeGreaterThan(nudgesBefore);
    const snapshot = f.entries.filter((entry) => entry.type === "dcp-diagnostic" && entry.data.event === "request").at(-1)!.data.snapshot;
    expect(snapshot.routineUsageAdjustmentTokens).toBe(0);
  });
});
