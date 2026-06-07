import { describe, expect, test } from "bun:test";
import {
  createState,
  restoreState,
  serializeState,
  compactifyToolRecord,
  hashSerializedState,
  PERSISTED_TOOL_CALLS_MAX_RECENT,
  type CompressionBlock,
  type CompactToolRecord,
  type ToolRecord,
  type SerializedDcpState,
} from "../src/dcp/state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolRecord(
  id: string,
  overrides: Partial<ToolRecord> = {},
): ToolRecord {
  return {
    toolCallId: id,
    toolName: overrides.toolName ?? "read",
    inputArgs: overrides.inputArgs ?? { file_path: `/src/${id}.ts` },
    inputFingerprint: overrides.inputFingerprint ?? `read::{"file_path":"/src/${id}.ts"}`,
    isError: overrides.isError ?? false,
    turnIndex: overrides.turnIndex ?? 0,
    timestamp: overrides.timestamp ?? Date.now(),
    tokenEstimate: overrides.tokenEstimate ?? 100,
    outputText: overrides.outputText,
    outputDetails: overrides.outputDetails,
  };
}

function makeBlock(
  id: number,
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    id,
    topic: overrides.topic ?? `block-${id}`,
    summary: overrides.summary ?? `Summary for block ${id}`,
    startTimestamp: overrides.startTimestamp ?? 1000,
    endTimestamp: overrides.endTimestamp ?? 2000,
    anchorTimestamp: overrides.anchorTimestamp ?? 2001,
    active: overrides.active ?? true,
    summaryTokenEstimate: overrides.summaryTokenEstimate ?? 50,
    createdAt: overrides.createdAt ?? Date.now(),
    createdByToolCallId: overrides.createdByToolCallId,
    startMessageId: overrides.startMessageId,
    endMessageId: overrides.endMessageId,
    anchorMessageId: overrides.anchorMessageId,
    coveredBlockIds: overrides.coveredBlockIds,
    mode: overrides.mode,
    deactivatedByUser: overrides.deactivatedByUser,
    deactivatedReason: overrides.deactivatedReason,
  };
}

// ---------------------------------------------------------------------------
// compactifyToolRecord
// ---------------------------------------------------------------------------

describe("compactifyToolRecord", () => {
  test("strips outputText, outputDetails, and full inputArgs", () => {
    const record = makeToolRecord("tc-1", {
      outputText: "x".repeat(10_000),
      outputDetails: { bigData: "y".repeat(5_000) },
      inputArgs: { file_path: "/src/foo.ts", content: "z".repeat(2_000) },
    });

    const compact = compactifyToolRecord(record);

    // Must not contain heavy fields
    expect(compact).not.toHaveProperty("outputText");
    expect(compact).not.toHaveProperty("outputDetails");
    expect(compact).not.toHaveProperty("inputArgs");

    // Must retain key fields
    expect(compact.toolCallId).toBe("tc-1");
    expect(compact.toolName).toBe("read");
    expect(compact.inputFingerprint).toBe(record.inputFingerprint);
    expect(compact.isError).toBe(false);
    expect(compact.turnIndex).toBe(0);
    expect(compact.timestamp).toBe(record.timestamp);
    expect(compact.tokenEstimate).toBe(100);

    // inputStringValues should contain extracted strings from inputArgs
    expect(compact.inputStringValues).toBeDefined();
    expect(compact.inputStringValues!.length).toBeGreaterThan(0);
    // Should include the file path
    expect(compact.inputStringValues).toContain("/src/foo.ts");
  });

  test("caps inputStringValues count and length", () => {
    // Create inputArgs with many long string values
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      args[`key${i}`] = "a".repeat(1_000);
    }
    const record = makeToolRecord("tc-big-args", { inputArgs: args });

    const compact = compactifyToolRecord(record);

    // Should be capped at 20 values
    expect(compact.inputStringValues!.length).toBeLessThanOrEqual(20);
    // Each value should be capped at 512 chars
    for (const val of compact.inputStringValues!) {
      expect(val.length).toBeLessThanOrEqual(512);
    }
  });

  test("omits inputStringValues when inputArgs has no string values", () => {
    const record = makeToolRecord("tc-no-strings", {
      inputArgs: { count: 5, flag: true },
    });
    const compact = compactifyToolRecord(record);
    expect(compact.inputStringValues).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// serializeState — compact output
// ---------------------------------------------------------------------------

describe("serializeState", () => {
  test("serialized state does not include outputText, outputDetails, or full inputArgs", () => {
    const state = createState();

    // Add records with large output
    for (let i = 0; i < 5; i++) {
      const record = makeToolRecord(`tc-${i}`, {
        outputText: "huge output ".repeat(1_000),
        outputDetails: { data: "x".repeat(5_000) },
        inputArgs: { file_path: `/src/file${i}.ts`, code: "c".repeat(3_000) },
      });
      state.toolCalls.set(record.toolCallId, record);
    }

    const serialized = serializeState(state);

    // Should use compact format
    expect(serialized.compactToolCalls).toBeDefined();
    expect(serialized.toolCalls).toBeUndefined();

    // Verify no compact record has the heavy fields
    for (const compact of serialized.compactToolCalls!) {
      expect(compact).not.toHaveProperty("outputText");
      expect(compact).not.toHaveProperty("outputDetails");
      expect(compact).not.toHaveProperty("inputArgs");
    }
  });

  test("serialized state size remains bounded for many tool calls with large outputs", () => {
    const state = createState();

    // Simulate 500 tool calls with large outputs (would produce ~100+ MB
    // in the old full-snapshot approach)
    for (let i = 0; i < 500; i++) {
      const record = makeToolRecord(`tc-${i}`, {
        timestamp: 1000 + i,
        outputText: "x".repeat(50_000), // 50 KB per record
        outputDetails: { nested: { data: "y".repeat(10_000) } },
        inputArgs: { file_path: `/src/file${i}.ts` },
      });
      state.toolCalls.set(record.toolCallId, record);
    }

    const serialized = serializeState(state);
    const json = JSON.stringify(serialized);

    // With 500 records and 50KB output each, old format would be ~30MB+.
    // Compact format should be well under 1MB.
    expect(json.length).toBeLessThan(1_000_000); // < 1 MB

    // Should retain at most PERSISTED_TOOL_CALLS_MAX_RECENT records
    expect(serialized.compactToolCalls!.length).toBeLessThanOrEqual(
      PERSISTED_TOOL_CALLS_MAX_RECENT,
    );

    // totalToolCallCount should reflect the true count
    expect(serialized.totalToolCallCount).toBe(500);
  });

  test("retains referenced tool records beyond the recent limit", () => {
    const state = createState();

    // Create old records referenced by active compression blocks / pruned IDs.
    // Add enough referenced records (10) that combined with the recent limit
    // they push total above PERSISTED_TOOL_CALLS_MAX_RECENT.
    const referencedCount = 10;
    for (let i = 0; i < referencedCount; i++) {
      const record = makeToolRecord(`tc-ref-${i}`, {
        timestamp: i + 1, // very old
      });
      state.toolCalls.set(record.toolCallId, record);
      state.prunedToolIds.add(record.toolCallId);
      state.prunedToolReasons.set(record.toolCallId, "stale");
    }

    // Add an old record referenced by an active compression block
    const blockRef = makeToolRecord("tc-block-ref", { timestamp: 0 });
    state.toolCalls.set(blockRef.toolCallId, blockRef);
    state.compressionBlocks.push(
      makeBlock(1, { active: true, createdByToolCallId: "tc-block-ref" }),
    );

    // Fill with enough recent records to hit the limit by themselves
    for (let i = 0; i < PERSISTED_TOOL_CALLS_MAX_RECENT + 50; i++) {
      const record = makeToolRecord(`tc-recent-${i}`, {
        timestamp: 1000 + i,
      });
      state.toolCalls.set(record.toolCallId, record);
    }

    const serialized = serializeState(state);
    const ids = serialized.compactToolCalls!.map((r) => r.toolCallId);

    // All referenced records must be included even though recent records
    // already fill the PERSISTED_TOOL_CALLS_MAX_RECENT limit
    expect(ids).toContain("tc-block-ref");
    for (let i = 0; i < referencedCount; i++) {
      expect(ids).toContain(`tc-ref-${i}`);
    }

    // Total must be at least referenced + recent limit since referenced
    // records are added in the first pass before the limit applies
    expect(serialized.compactToolCalls!.length).toBeGreaterThanOrEqual(
      PERSISTED_TOOL_CALLS_MAX_RECENT,
    );

    // But some very old non-referenced records should be trimmed
    expect(serialized.compactToolCalls!.length).toBeLessThan(
      state.toolCalls.size,
    );
  });

  test("preserves totalToolCallCount", () => {
    const state = createState();
    state.totalToolCallCount = 1234;
    for (let i = 0; i < 3; i++) {
      state.toolCalls.set(`tc-${i}`, makeToolRecord(`tc-${i}`));
    }
    const serialized = serializeState(state);
    // totalToolCallCount in serialized should equal number of records in the
    // map, not the state's totalToolCallCount. The field captures the map
    // size at serialization time.
    expect(serialized.totalToolCallCount).toBe(3);
  });

  test("persists all critical state fields", () => {
    const state = createState();
    state.manualMode = true;
    state.currentTurn = 42;
    state.nudgeCounter = 7;
    state.lastNudgeTurn = 38;
    state.tokensSaved = 5000;
    state.totalPruneCount = 12;
    state.nextBlockId = 5;
    state.nudgeAnchors = [
      {
        id: 1,
        type: "compress-range" as any,
        anchorTimestamp: 100,
        anchorRole: "assistant",
        turnIndex: 3,
        createdAt: 200,
        updatedAt: 200,
      },
    ];
    state.lastNudge = {
      type: "compress-range" as any,
      anchorId: 1,
      anchorTimestamp: 100,
      createdAt: 300,
    };

    const serialized = serializeState(state);

    expect(serialized.manualMode).toBe(true);
    expect(serialized.currentTurn).toBe(42);
    expect(serialized.nudgeCounter).toBe(7);
    expect(serialized.lastNudgeTurn).toBe(38);
    expect(serialized.tokensSaved).toBe(5000);
    expect(serialized.totalPruneCount).toBe(12);
    expect(serialized.nextBlockId).toBe(5);
    expect(serialized.nudgeAnchors).toHaveLength(1);
    expect(serialized.lastNudge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// restoreState — backward compatibility
// ---------------------------------------------------------------------------

describe("restoreState", () => {
  test("restores from new compact format", () => {
    const state = createState();
    const compact: CompactToolRecord[] = [
      {
        toolCallId: "tc-1",
        toolName: "read",
        inputFingerprint: 'read::{"file_path":"/src/foo.ts"}',
        isError: false,
        turnIndex: 2,
        timestamp: 1000,
        tokenEstimate: 200,
        inputStringValues: ["/src/foo.ts"],
      },
    ];

    restoreState(state, {
      compressionBlocks: [],
      nextBlockId: 1,
      prunedToolIds: [],
      prunedToolReasons: [],
      compactToolCalls: compact,
      totalToolCallCount: 42,
      tokensSaved: 100,
      totalPruneCount: 3,
      accountedCompressionBlockIds: [],
      compressionTokenSavings: [],
      accountedPrunedToolIds: [],
      manualMode: false,
    } satisfies SerializedDcpState);

    // Tool record should be restored
    expect(state.toolCalls.size).toBe(1);
    const restored = state.toolCalls.get("tc-1")!;
    expect(restored.toolCallId).toBe("tc-1");
    expect(restored.toolName).toBe("read");
    expect(restored.inputFingerprint).toBe('read::{"file_path":"/src/foo.ts"}');
    expect(restored.isError).toBe(false);
    expect(restored.turnIndex).toBe(2);
    expect(restored.timestamp).toBe(1000);
    expect(restored.tokenEstimate).toBe(200);

    // inputArgs should be synthetic with restored values
    expect(restored.inputArgs).toEqual({ _restoredValues: ["/src/foo.ts"] });

    // outputText and outputDetails should not be restored
    expect(restored.outputText).toBeUndefined();
    expect(restored.outputDetails).toBeUndefined();

    // totalToolCallCount should use persisted value
    expect(state.totalToolCallCount).toBe(42);
  });

  test("restores from legacy full format (backward compat)", () => {
    const state = createState();
    const legacyRecords: ToolRecord[] = [
      {
        toolCallId: "tc-legacy",
        toolName: "edit",
        inputArgs: { file_path: "/src/bar.ts", old_string: "a", new_string: "b" },
        inputFingerprint: 'edit::{"file_path":"/src/bar.ts","new_string":"b","old_string":"a"}',
        isError: false,
        turnIndex: 1,
        timestamp: 500,
        tokenEstimate: 50,
        outputText: "Edit applied",
        outputDetails: { status: "ok" },
      },
    ];

    restoreState(state, {
      compressionBlocks: [],
      nextBlockId: 1,
      prunedToolIds: [],
      prunedToolReasons: [],
      toolCalls: legacyRecords,
      tokensSaved: 0,
      totalPruneCount: 0,
      accountedCompressionBlockIds: [],
      compressionTokenSavings: [],
      accountedPrunedToolIds: [],
      manualMode: false,
    });

    expect(state.toolCalls.size).toBe(1);
    const restored = state.toolCalls.get("tc-legacy")!;

    // Legacy format preserves full inputArgs, outputText, outputDetails
    expect(restored.inputArgs).toEqual({
      file_path: "/src/bar.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(restored.outputText).toBe("Edit applied");
    expect(restored.outputDetails).toEqual({ status: "ok" });

    // totalToolCallCount should fall back to toolCalls.size
    expect(state.totalToolCallCount).toBe(1);
  });

  test("restores compression blocks, pruned IDs, manual mode, and nudges", () => {
    const state = createState();
    const block = makeBlock(3, {
      active: true,
      createdByToolCallId: "tc-compress",
    });

    restoreState(state, {
      compressionBlocks: [block],
      nextBlockId: 4,
      prunedToolIds: ["tc-pruned-1", "tc-pruned-2"],
      prunedToolReasons: [
        ["tc-pruned-1", "duplicate"],
        ["tc-pruned-2", "stale"],
      ],
      compactToolCalls: [],
      totalToolCallCount: 10,
      tokensSaved: 3000,
      totalPruneCount: 5,
      accountedCompressionBlockIds: [3],
      compressionTokenSavings: [[3, 500]],
      accountedPrunedToolIds: ["tc-pruned-1", "tc-pruned-2"],
      manualMode: true,
      nudgeAnchors: [
        {
          id: 1,
          type: "compress-range" as any,
          anchorTimestamp: 100,
          anchorRole: "assistant",
          turnIndex: 3,
          createdAt: 200,
          updatedAt: 200,
        },
      ],
      nextNudgeAnchorId: 2,
      lastNudge: {
        type: "compress-range" as any,
        anchorId: 1,
        anchorTimestamp: 100,
        createdAt: 300,
      },
      currentTurn: 15,
      nudgeCounter: 4,
      lastNudgeTurn: 12,
    } satisfies SerializedDcpState);

    // Compression blocks
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0].id).toBe(3);
    expect(state.compressionBlocks[0].active).toBe(true);
    expect(state.nextBlockId).toBe(4);

    // Pruned IDs
    expect(state.prunedToolIds.size).toBe(2);
    expect(state.prunedToolIds.has("tc-pruned-1")).toBe(true);
    expect(state.prunedToolReasons.get("tc-pruned-1")).toBe("duplicate");

    // Manual mode
    expect(state.manualMode).toBe(true);

    // Nudges
    expect(state.nudgeAnchors).toHaveLength(1);
    expect(state.nextNudgeAnchorId).toBe(2);
    expect(state.lastNudge).toBeDefined();
    expect(state.lastNudge!.anchorId).toBe(1);

    // Counters
    expect(state.currentTurn).toBe(15);
    expect(state.nudgeCounter).toBe(4);
    expect(state.lastNudgeTurn).toBe(12);
    expect(state.tokensSaved).toBe(3000);
    expect(state.totalPruneCount).toBe(5);
  });

  test("handles missing/empty data gracefully", () => {
    const state = createState();
    // Should not throw
    restoreState(state, null);
    restoreState(state, undefined);
    restoreState(state, {});
    restoreState(state, { toolCalls: "not-an-array" });

    // State should remain at defaults
    expect(state.toolCalls.size).toBe(0);
    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.manualMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: serialize → restore
// ---------------------------------------------------------------------------

describe("serialize → restore round trip", () => {
  test("round-trip preserves all critical state", () => {
    const original = createState();

    // Populate with realistic data
    for (let i = 0; i < 10; i++) {
      original.toolCalls.set(`tc-${i}`, makeToolRecord(`tc-${i}`, {
        timestamp: 1000 + i,
        outputText: `output for ${i}`,
        inputArgs: { file_path: `/src/file${i}.ts` },
      }));
    }
    original.prunedToolIds.add("tc-0");
    original.prunedToolReasons.set("tc-0", "stale");
    original.accountedPrunedToolIds.add("tc-0");
    original.compressionBlocks.push(makeBlock(1, { active: true }));
    original.nextBlockId = 2;
    original.manualMode = true;
    original.tokensSaved = 500;
    original.totalPruneCount = 3;
    original.currentTurn = 8;
    original.nudgeCounter = 2;
    original.lastNudgeTurn = 6;
    original.totalToolCallCount = 10;

    const serialized = serializeState(original);
    const restored = createState();
    restoreState(restored, serialized);

    // Critical fields must survive
    expect(restored.compressionBlocks).toEqual(original.compressionBlocks);
    expect(restored.nextBlockId).toBe(2);
    expect(restored.prunedToolIds).toEqual(original.prunedToolIds);
    expect(restored.prunedToolReasons).toEqual(original.prunedToolReasons);
    expect(restored.manualMode).toBe(true);
    expect(restored.tokensSaved).toBe(500);
    expect(restored.totalPruneCount).toBe(3);
    expect(restored.currentTurn).toBe(8);
    expect(restored.nudgeCounter).toBe(2);
    expect(restored.lastNudgeTurn).toBe(6);

    // Tool records survive but without heavy fields
    expect(restored.toolCalls.size).toBe(10);
    for (const [id, record] of restored.toolCalls) {
      expect(record.toolCallId).toBe(id);
      expect(record.toolName).toBe("read");
      expect(record.outputText).toBeUndefined();
      expect(record.outputDetails).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// hashSerializedState — dedup
// ---------------------------------------------------------------------------

describe("hashSerializedState", () => {
  test("produces the same hash for identical state", () => {
    const state = createState();
    state.toolCalls.set("tc-1", makeToolRecord("tc-1"));
    const s1 = serializeState(state);
    const s2 = serializeState(state);
    expect(hashSerializedState(s1)).toBe(hashSerializedState(s2));
  });

  test("produces different hash when state changes", () => {
    const state = createState();
    state.toolCalls.set("tc-1", makeToolRecord("tc-1"));
    const h1 = hashSerializedState(serializeState(state));

    state.toolCalls.set("tc-2", makeToolRecord("tc-2", { timestamp: 999 }));
    const h2 = hashSerializedState(serializeState(state));

    expect(h1).not.toBe(h2);
  });

  test("hash changes when pruning state changes", () => {
    const state = createState();
    state.toolCalls.set("tc-1", makeToolRecord("tc-1"));
    const h1 = hashSerializedState(serializeState(state));

    state.prunedToolIds.add("tc-1");
    state.prunedToolReasons.set("tc-1", "stale");
    const h2 = hashSerializedState(serializeState(state));

    expect(h1).not.toBe(h2);
  });
});
