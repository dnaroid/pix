import { describe, expect, test } from "bun:test";
import { canonicalMessageHash } from "../src/dcp/conversation-index.js";
import { captureDcpContextTokenEstimates, projectDcpContextMapTelemetry } from "../src/dcp/context-map-telemetry.js";
import { applyPruning } from "../src/dcp/pruner.js";
import { loadConfig } from "../src/dcp/config.js";
import dcpModule from "../src/dcp/index.js";
import { createState, type ConversationIndexEntry } from "../src/dcp/state.js";

function entriesFor(messages: any[], extras: Partial<ConversationIndexEntry>[] = []): ConversationIndexEntry[] {
  return messages.map((message, index) => ({
    index, stableId: `entry-${index}`, contentHash: canonicalMessageHash(message), visibleId: `m${index + 1}`,
    role: message.role, passthrough: false, origin: "raw", signedAssistant: false, ...extras[index],
  }));
}

describe("cached DCP projection token map", () => {
  test("partitions overlapping classifications by policy priority and preserves token mass", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "a" }, { type: "toolCall", id: "b" }] },
      { role: "toolResult", toolCallId: "a", content: "partial result" },
      { role: "user", content: "selected" },
      { role: "user", content: "short summary" },
      { role: "custom", content: "dcp control" },
      { role: "user", content: "keep" },
    ];
    const entries = entriesFor(messages, [
      { toolCallIds: ["a", "b"] }, { toolCallId: "a" }, {},
      { origin: "block", blockId: 7 }, { origin: "dcp-control" }, {},
    ]);
    const map = projectDcpContextMapTelemetry(entries, {
      startId: "m1", endId: "m3", messageCount: 3, estimatedTokens: 60, includedBlockIds: [], reason: "fixture",
    }, [10, 20, 30, 4, 5, 6], 1, 0, 10);
    expect(map).toEqual({
      revision: 1, sessionEpoch: 0, generatedAt: 10,
      tokenEstimates: { protected: 30, candidate: 30, compressed: 4, retained: 11 },
    });
    expect(Object.values(map!.tokenEstimates).reduce((sum, tokens) => sum + tokens, 0)).toBe(75);
  });

  test("uses the projected summary body estimate, not a block's original range", () => {
    const messages = [{ role: "user", content: "tiny summary" }];
    const map = projectDcpContextMapTelemetry(
      entriesFor(messages, [{ origin: "block", blockId: 1 }]), null, [3], 2, 3, 4,
    );
    expect(map?.tokenEstimates).toEqual({ candidate: 0, protected: 0, compressed: 3, retained: 0 });
  });

  test("fails unavailable for empty, invalid, and mismatched projections", () => {
    const messages = [{ role: "user", content: "body" }];
    const entries = entriesFor(messages);
    expect(projectDcpContextMapTelemetry([], null, [], 1, 0, 1)).toBeUndefined();
    expect(projectDcpContextMapTelemetry(entries, null, [1], -1, 0, 1)).toBeUndefined();
    expect(projectDcpContextMapTelemetry(entries, null, [1], 0, 0, 1)).toBeUndefined();
    expect(projectDcpContextMapTelemetry(entries, null, [1], 1, 0, Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(projectDcpContextMapTelemetry(entries, null, undefined, 1, 0, 1)).toBeUndefined();
    expect(captureDcpContextTokenEstimates(entries, [{ role: "assistant", content: "body" }], new Map())).toBeUndefined();
    const twoMessages = [...messages, { role: "user", content: "more" }];
    expect(projectDcpContextMapTelemetry(entriesFor(twoMessages), null,
      [Number.MAX_SAFE_INTEGER, 1], 1, 0, 1)).toBeUndefined();
    expect(projectDcpContextMapTelemetry(entriesFor([{ role: "user", content: "" }]), null, [0], 1, 0, 1)).toBeUndefined();
  });

  test("captures cached current-body estimates without rehashing or reading cached bodies", () => {
    const state = createState();
    const config = loadConfig({ homeDir: "/__dcp_token_cache__" });
    const messages = applyPruning([{ role: "user", content: "hello world", id: "a", timestamp: 1 }], state, config);
    const expected = [...state.messageMetaSnapshot.values()][0]!.tokenEstimate!;
    Object.defineProperty(messages[0], "content", { get() { throw new Error("must reuse cache"); } });
    const tokens = captureDcpContextTokenEstimates(state.conversationIndexSnapshot, messages, state.messageMetaSnapshot);
    expect(tokens).toEqual([expected]);
    state.messageMetaSnapshot.clear();
    expect(projectDcpContextMapTelemetry(state.conversationIndexSnapshot, null, tokens, 1, 0, 1)?.tokenEstimates.retained).toBe(expected);
  });

  test("never classifies DCP control carriers as candidates", () => {
    const messages = [{ role: "user", content: "a" }, { role: "custom", content: "control" }, { role: "user", content: "b" }];
    const entries = entriesFor(messages, [{}, { origin: "dcp-control" }, {}]);
    const map = projectDcpContextMapTelemetry(entries, {
      startId: "m1", endId: "m3", messageCount: 3, estimatedTokens: 10, includedBlockIds: [], reason: "fixture",
    }, [2, 5, 3], 1, 0, 1);
    expect(map?.tokenEstimates).toEqual({ candidate: 5, protected: 0, compressed: 0, retained: 5 });
  });

  test("real context hook publishes cached token maps and invalidates stale owners", async () => {
    const config = loadConfig({ homeDir: "/__dcp_map_lifecycle__" });
    config.debug = false;
    const state = createState();
    const handlers = new Map<string, any[]>();
    let reads = 0;
    let pendingRead: Promise<unknown[]> | undefined;
    const ctx: any = { cwd: "/__dcp_map_lifecycle__", model: { provider: "fixture", id: "model", contextWindow: 100_000 },
      sessionManager: { getBranch: () => [], getSessionId: () => "map-test",
        readFullBranchEntries: () => { reads++; return pendingRead ?? Promise.resolve([]); } },
      getContextUsage: () => ({ tokens: 10, contextWindow: 100_000 }), ui: { notify() {} } };
    await dcpModule({ on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerTool() {}, registerCommand() {}, sendMessage() {}, appendEntry() {} } as any, { config, state });
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
    };
    const getter = (globalThis as any)[Symbol.for("pix.dcp.runtime-stats")];
    await emit("session_start");
    const sessionSymbol = Symbol.for("pix.dcp.session-runtime-stats");
    const sessionGetter = ctx.sessionManager[sessionSymbol];
    expect(typeof sessionGetter).toBe("function");
    const messages = [{ role: "user", content: "hello", id: "e1", timestamp: 1 }];
    await emit("context", { messages });
    const first = getter().contextMap;
    expect(first?.tokenEstimates.retained).toBeGreaterThan(0);
    expect(sessionGetter().contextMap).toBe(first);
    const before = reads;
    expect(getter().contextMap).toBe(first);
    expect(reads).toBe(before);
    await emit("context", { messages });
    expect(getter().contextMap.revision).toBeGreaterThan(first.revision);
    let release!: (entries: unknown[]) => void;
    pendingRead = new Promise((resolve) => { release = resolve; });
    const stale = emit("context", { messages });
    await emit("model_select");
    expect(getter().contextMap).toBeUndefined();
    release([]);
    await expect(stale).rejects.toThrow();
    expect(getter().contextMap).toBeUndefined();
    pendingRead = undefined;
    await emit("context", { messages });
    expect(getter().contextMap).toBeDefined();
    pendingRead = new Promise((resolve) => { release = resolve; });
    const shuttingDown = emit("context", { messages });
    await emit("session_shutdown");
    release([]);
    await shuttingDown.catch(() => {});
    expect(getter().contextMap).toBeUndefined();
    expect(ctx.sessionManager[sessionSymbol]).toBeUndefined();
  });
});
