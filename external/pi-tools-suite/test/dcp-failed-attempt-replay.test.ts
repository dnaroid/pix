import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import { canonicalMessageHash } from "../src/dcp/conversation-index.js";
import { applyPruning, detectCompressionCandidate } from "../src/dcp/pruner.js";
import { stableMessageKeys } from "../src/dcp/pruner-message-ids.js";
import { createState, type CompressionBlock } from "../src/dcp/state.js";

const message = (id: string, timestamp: number, role = "assistant", stopReason = "stop"): any => ({
  id, timestamp, role, stopReason, content: [{ type: "text", text: `${id} raw detail\n`.repeat(100) }],
});
const failure = (stopReason = "error") => ({ ...message("failed", 2, "assistant", stopReason),
  errorMessage: "WebSocket closed 1006",
  content: [{ type: "thinking", thinking: "partial", thinkingSignature: "fixture-signature" }],
});

/** Immutable journal-shaped v2 block, including old blocks that recorded failures. */
function fixture(source = [message("a", 1), message("b", 3)]) {
  const state = createState();
  const config = loadConfig({ homeDir: "/__dcp_failed_replay_no_config__" });
  config.debug = false;
  config.compress.autoCandidates.minMessages = 1;
  config.compress.autoCandidates.minTokens = 1;
  const keys = stableMessageKeys(source);
  const members = source.map((m, i) => ({ stableId: keys[i]!, hash: canonicalMessageHash(m) }));
  const block: CompressionBlock = {
    id: 1, topic: "Closed work", summary: "Work completed.", active: true,
    startTimestamp: source[0].timestamp, endTimestamp: source.at(-1).timestamp,
    startMessageId: keys[0], endMessageId: keys.at(-1), anchorTimestamp: 4,
    createdAt: 5, summaryTokenEstimate: 4, coveredBlockIds: [],
    mode: "range", version: 2, replacementMode: "range", protectedFragments: [],
    sourceMembers: structuredClone(members), mutationMembers: structuredClone(members),
  };
  state.compressionBlocks.push(block);
  state.nextBlockId = 2;
  return { source, state, config, block };
}

describe("DCP failed-attempt replay normalization", () => {
  for (const stopReason of ["error", "aborted"]) {
    test(`restored unrecorded ${stopReason} does not break exact block replay or raw-tail candidates`, () => {
      const { source, state, config, block } = fixture();
      const before = applyPruning(source, state, config);
      const raw = [source[0], failure(stopReason), source[1]];
      const bytes = JSON.stringify(raw);
      expect(applyPruning(raw, state, config)).toEqual(before);
      expect(JSON.stringify(raw)).toBe(bytes);
      expect(block.active).toBe(true);
      expect(state.messageIdsByStableId.has("id:failed")).toBe(false);
      const continued = applyPruning([...raw, message("next", 6), message("user", 7, "user")], state, config);
      const candidate = detectCompressionCandidate(continued, state, config, 0.99, { allowCompressionBlocks: false });
      expect(candidate?.startId).toBe(state.messageIdsByStableId.get("id:next"));
      expect(candidate?.includedBlockIds).toEqual([]);
    });

    test(`old blocks that explicitly included ${stopReason} still require all recorded hashes`, () => {
      const source = [message("a", 1), failure(stopReason), message("b", 3)];
      const good = fixture(source);
      const originalMembers = structuredClone(good.block.mutationMembers);
      expect(applyPruning(source, good.state, good.config).filter((m) => m._dcpBlockId === 1)).toHaveLength(1);
      expect(good.block.mutationMembers).toEqual(originalMembers);

      const bad = fixture(source);
      const changed = structuredClone(source);
      changed[1].content[0].thinkingSignature = "different-signature";
      const projection = applyPruning(changed, bad.state, bad.config);
      expect(projection.some((m) => m._dcpBlockId === 1)).toBe(false);
      expect(bad.block.active).toBe(false);
      expect(bad.block.deactivatedReason).toBe("exact-membership-mismatch");
      expect(JSON.stringify(projection)).toContain("a raw detail");
      expect(bad.block.mutationMembers).toEqual(originalMembers);
    });
  }

  for (const [name, inserted] of [
    ["successful assistant", message("inserted", 2)],
    ["length-limited assistant", message("inserted", 2, "assistant", "length")],
    ["user", message("inserted", 2, "user")],
    ["failed tool result", { ...message("inserted", 2, "toolResult", "error"), isError: true, toolCallId: "call", toolName: "read" }],
  ] as const) {
    test(`never treats an extra ${name} as an ignorable retry attempt`, () => {
      const { source, state, config } = fixture();
      const projection = applyPruning([source[0], inserted, source[1]], state, config);
      expect(projection.some((m) => m._dcpBlockId === 1)).toBe(false);
      expect(projection.some((m) => m.id === "inserted")).toBe(true);
      expect(JSON.stringify(projection)).toContain("a raw detail");
    });
  }

  test("missing, reordered, changed or duplicated real members never gain replay authority", () => {
    for (const kind of ["missing", "reordered", "changed", "duplicate"]) {
      const { source, state, config } = fixture();
      let raw = [source[0], failure(), source[1]];
      if (kind === "missing") raw.pop();
      if (kind === "reordered") raw = [source[1], failure(), source[0]];
      if (kind === "changed") raw[2] = { ...source[1], content: [{ type: "text", text: "Changed raw content" }] };
      if (kind === "duplicate") raw.splice(1, 0, structuredClone(source[0]));
      const projection = applyPruning(raw, state, config);
      expect(projection.some((m) => m._dcpBlockId === 1)).toBe(false);
      expect(projection.length).toBeGreaterThan(0);
    }
  });

  test("without blocks, only failed/aborted assistants are omitted; tool results and signed valid items remain", () => {
    const { state, config } = fixture();
    state.compressionBlocks = [];
    const signed = { ...message("valid", 1), content: [{ type: "thinking", thinking: "valid", thinkingSignature: "untouched" }] };
    const partial = { ...failure(), content: [{ type: "toolCall", id: "partial", name: "read", arguments: {} }] };
    const result = { ...message("result", 3, "toolResult"), toolCallId: "partial", toolName: "read", isError: true };
    const raw = [signed, partial, failure("aborted"), result, message("length", 4, "assistant", "length")];
    const bytes = JSON.stringify(raw);
    const projection = applyPruning(raw, state, config);
    expect(projection.map((m) => m.id)).toEqual(["valid", "result", "length"]);
    expect(projection[0]).toEqual(signed);
    expect(projection[1].toolCallId).toBe("partial");
    expect(projection[1].isError).toBe(true);
    expect(JSON.stringify(raw)).toBe(bytes);
    expect(state.conversationIndexSnapshot).toHaveLength(3);
  });

  test("old failed-attempt IDs stay durable and are never reused for the next tail", () => {
    const { source, state, config } = fixture();
    state.messageIdsByStableId.set("id:failed", "m041");
    state.nextMessageId = 42;
    const raw = [source[0], failure(), source[1], message("user", 6, "user")];
    const projection = applyPruning(raw, state, config);
    const assignments = new Map(state.messageIdsByStableId);
    const nextId = state.nextMessageId;
    expect(state.messageIdsByStableId.get("id:failed")).toBe("m041");
    expect(state.messageMetaSnapshot.has("m041")).toBe(false);
    expect(state.messageIdsByStableId.get("id:user")).not.toBe("m041");
    expect(applyPruning(raw, state, config)).toEqual(projection);
    expect(state.messageIdsByStableId).toEqual(assignments);
    expect(state.nextMessageId).toBe(nextId);
  });
});
