import { describe, expect, test } from "bun:test";
import {
  applyCompressionBlocks,
  reconcileInheritedCompressionBlocks,
} from "../src/dcp/pruner-compression-blocks.js";
import { createState, type CompressionBlock } from "../src/dcp/state.js";

function message(entryId: string, timestamp: number, text: string): any {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
    _dcpEntryId: entryId,
  };
}

function block(
  id: number,
  startMessageId: string,
  endMessageId: string,
  startTimestamp: number,
  endTimestamp: number,
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    id,
    topic: `Block ${id}`,
    summary: `Summary ${id}`,
    startTimestamp,
    endTimestamp,
    startMessageId,
    endMessageId,
    anchorTimestamp: endTimestamp + 1,
    summaryTokenEstimate: 10,
    createdAt: 1,
    active: true,
    mode: "range",
    ...overrides,
  };
}

describe("fork compression-block reconciliation", () => {
  test("reactivates the deepest fitting ancestor when the newest roll-up crosses the fork", () => {
    const state = createState();
    state.compressionBlocks = [
      block(1, "id:a", "id:b", 10, 20, { active: false }),
      block(2, "id:a", "id:d", 10, 40, { coveredBlockIds: [1] }),
      block(3, "id:e", "id:e", 50, 50),
    ];
    const messages = [message("a", 10, "first"), message("b", 20, "second")];

    const result = reconcileInheritedCompressionBlocks(messages, state);

    expect(result.fittingBlockIds).toEqual([1]);
    expect(result.activatedBlockIds).toEqual([1]);
    expect(result.deactivatedBlockIds).toEqual([2, 3]);
    expect(state.compressionBlocks.map((item) => item.active)).toEqual([true, false, false]);

    const output = applyCompressionBlocks([...messages], state);
    expect(output).toHaveLength(1);
    expect(JSON.stringify(output[0]?.content)).toContain("Summary 1");
  });

  test("keeps the widest fitting roll-up active when both boundaries exist", () => {
    const state = createState();
    state.compressionBlocks = [
      block(1, "id:a", "id:b", 10, 20, { active: false }),
      block(2, "id:a", "id:d", 10, 40, { coveredBlockIds: [1] }),
    ];
    const messages = [
      message("a", 10, "first"),
      message("b", 20, "second"),
      message("d", 40, "fourth"),
    ];

    const result = reconcileInheritedCompressionBlocks(messages, state);

    expect(result.fittingBlockIds).toEqual([1, 2]);
    expect(result.activatedBlockIds).toEqual([]);
    expect(result.deactivatedBlockIds).toEqual([]);
    expect(state.compressionBlocks.map((item) => item.active)).toEqual([false, true]);
  });

  test("preserves explicit decompression for a roll-up and its descendants", () => {
    const state = createState();
    state.compressionBlocks = [
      block(1, "id:a", "id:b", 10, 20, { active: false }),
      block(2, "id:a", "id:d", 10, 40, {
        active: false,
        coveredBlockIds: [1],
        deactivatedByUser: true,
        deactivatedReason: "user",
      }),
    ];
    const messages = [
      message("a", 10, "first"),
      message("b", 20, "second"),
      message("d", 40, "fourth"),
    ];

    const result = reconcileInheritedCompressionBlocks(messages, state);

    expect(result.fittingBlockIds).toEqual([1, 2]);
    expect(result.activatedBlockIds).toEqual([]);
    expect(state.compressionBlocks.map((item) => item.active)).toEqual([false, false]);
    expect(state.compressionBlocks[1]?.deactivatedReason).toBe("user");
  });

  test("keeps separate fitting blocks active", () => {
    const state = createState();
    state.compressionBlocks = [
      block(1, "id:a", "id:b", 10, 20, { active: false }),
      block(2, "id:c", "id:d", 30, 40),
    ];
    const messages = [
      message("a", 10, "first"),
      message("b", 20, "second"),
      message("c", 30, "third"),
      message("d", 40, "fourth"),
    ];

    const result = reconcileInheritedCompressionBlocks(messages, state);

    expect(result.activatedBlockIds).toEqual([1]);
    expect(state.compressionBlocks.map((item) => item.active)).toEqual([true, true]);
  });
});
