import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  appendDcpJournalOperation,
  buildDcpJournalDelta,
  createDcpJournalInit,
  createDcpJournalMirror,
  DCP_JOURNAL_CUSTOM_TYPE,
  DcpJournalError,
  replayDcpJournal,
  validateDcpJournalOperation,
} from "../src/dcp/journal.js";
import { createState, type CompressionBlock } from "../src/dcp/state.js";

function entry(data: unknown, id = Math.random().toString(16).slice(2)) {
  return { type: "custom", customType: DCP_JOURNAL_CUSTOM_TYPE, id, parentId: null, data };
}

function exactBlock(id = 1): CompressionBlock {
  return {
    id,
    topic: "Closed work",
    summary: "Implementation completed; continue with verification.",
    startTimestamp: 1,
    endTimestamp: 2,
    startMessageId: "id:u1",
    endMessageId: "tool:r1",
    anchorTimestamp: 3,
    anchorMessageId: "id:u2",
    active: true,
    summaryTokenEstimate: 12,
    createdAt: 10,
    version: 2,
    replacementMode: "range",
    sourceMembers: [
      { stableId: "id:u1", hash: "hash-u1" },
      { stableId: "tool:r1", hash: "hash-r1" },
    ],
    mutationMembers: [
      { stableId: "id:u1", hash: "raw-u1" },
      { stableId: "tool:r1", hash: "raw-r1" },
    ],
    protectedFragments: [],
  };
}

describe("DCP session journal", () => {
  test("replays init plus projection deltas without transient provider/tool state", () => {
    const init = createDcpJournalInit("init-operation", 1);
    const source = createState();
    const mirror = createDcpJournalMirror(source, init.operationId);
    source.messageIdsByStableId.set("id:u1", "m001");
    source.nextMessageId = 2;
    source.compressionBlocks.push(exactBlock());
    source.nextBlockId = 2;
    source.prunedToolIds.add("call-old");
    source.prunedToolReasons.set("call-old", "manual-sweep");
    source.toolCalls.set("call-old", {
      toolCallId: "call-old",
      toolName: "read",
      inputArgs: { path: "src/a.ts" },
      inputFingerprint: "fp",
      isError: false,
      turnIndex: 0,
      timestamp: 2,
      tokenEstimate: 700,
      outputText: "RAW_OUTPUT_MUST_NOT_BE_PERSISTED",
    });
    source.providerSeenToolIds.add("call-old");
    source.manualMode = true;

    const delta = buildDcpJournalDelta(source, mirror, "delta-operation", 2)!;
    expect(JSON.stringify(delta)).not.toContain("RAW_OUTPUT_MUST_NOT_BE_PERSISTED");
    expect(JSON.stringify(delta)).not.toContain("providerSeenToolIds");

    const restored = createState();
    const replay = replayDcpJournal([entry(init, "j1"), entry(delta, "j2")], restored);
    expect(replay).toEqual({ initialized: true, lastOperationId: "delta-operation", operationCount: 2 });
    expect(restored.messageIdsByStableId.get("id:u1")).toBe("m001");
    expect(restored.compressionBlocks).toHaveLength(1);
    expect(restored.compressionBlocks[0]?.version).toBe(2);
    expect(restored.prunedToolReasons.get("call-old")).toBe("manual-sweep");
    expect(restored.tokensSaved).toBe(700);
    expect(restored.manualMode).toBe(true);
    expect(restored.providerSeenToolIds.size).toBe(0);
    expect(restored.toolCalls.size).toBe(0);
  });

  test("emits no delta for an unchanged durable state", () => {
    const state = createState();
    const mirror = createDcpJournalMirror(state, "init-operation");
    expect(buildDcpJournalDelta(state, mirror)).toBeUndefined();
  });

  test("allows block active-state changes but rejects immutable block rewrites", () => {
    const state = createState();
    state.compressionBlocks.push(exactBlock());
    const mirror = createDcpJournalMirror(state, "init-operation");
    state.compressionBlocks[0]!.active = false;
    state.compressionBlocks[0]!.deactivatedReason = "superseded";
    const delta = buildDcpJournalDelta(state, mirror, "state-update", 2)!;
    expect(delta.blocks).toBeUndefined();
    expect(delta.blockStates).toEqual([{ id: 1, active: false, deactivatedReason: "superseded" }]);

    const nextMirror = createDcpJournalMirror(state, delta.operationId);
    state.compressionBlocks[0]!.summary = "rewritten summary";
    expect(() => buildDcpJournalDelta(state, nextMirror, "bad-update", 3)).toThrow(DcpJournalError);
  });

  test("rejects removal, reassignment, unpruning, and reactivation of published decisions", () => {
    const state = createState();
    state.messageIdsByStableId.set("id:u1", "m001");
    state.compressionBlocks.push(exactBlock());
    state.prunedToolIds.add("call-old");
    state.prunedToolReasons.set("call-old", "manual-sweep");
    const mirror = createDcpJournalMirror(state, "published-state");

    state.messageIdsByStableId.delete("id:u1");
    expect(() => buildDcpJournalDelta(state, mirror)).toThrow(/assignment.*removed/i);
    state.messageIdsByStableId.set("id:u1", "m002");
    expect(() => buildDcpJournalDelta(state, mirror)).toThrow(/assignment.*reassigned/i);
    state.messageIdsByStableId.set("id:u1", "m001");

    state.prunedToolIds.delete("call-old");
    expect(() => buildDcpJournalDelta(state, mirror)).toThrow(/pruned tool.*restored/i);
    state.prunedToolIds.add("call-old");

    state.compressionBlocks = [];
    expect(() => buildDcpJournalDelta(state, mirror)).toThrow(/block b1.*removed/i);

    state.compressionBlocks = [exactBlock()];
    state.compressionBlocks[0]!.active = false;
    const retiredMirror = createDcpJournalMirror(state, "retired-state");
    state.compressionBlocks[0]!.active = true;
    expect(() => buildDcpJournalDelta(state, retiredMirror)).toThrow(/reactivated/i);
  });

  test("rejects broken predecessor chains and conflicting duplicate operation ids", () => {
    const init = createDcpJournalInit("init-operation", 1);
    const good = {
      schemaVersion: 1,
      kind: "delta",
      operationId: "same-operation",
      previousOperationId: "init-operation",
      createdAt: 2,
      manualMode: true,
    } as const;
    const broken = { ...good, operationId: "broken-operation", previousOperationId: "missing-operation" };
    expect(() => replayDcpJournal([entry(init), entry(broken)], createState())).toThrow(/predecessor/i);

    const conflicting = { ...good, manualMode: false };
    expect(() => replayDcpJournal([entry(init), entry(good), entry(conflicting)], createState())).toThrow(/conflicts/i);
    expect(() => replayDcpJournal([entry(init), entry(good), entry(good)], createState())).not.toThrow();
  });

  test("rejects unknown schema and incomplete compression blocks", () => {
    expect(() => validateDcpJournalOperation({
      schemaVersion: 2,
      kind: "init",
      operationId: "init-operation",
      previousOperationId: null,
      createdAt: 1,
    })).toThrow(/schema/i);

    const init = createDcpJournalInit("init-operation", 1);
    const invalid = { ...exactBlock(), version: undefined, sourceMembers: undefined, mutationMembers: undefined, protectedFragments: undefined };
    expect(() => validateDcpJournalOperation({
      schemaVersion: 1,
      kind: "delta",
      operationId: "legacy-block",
      previousOperationId: init.operationId,
      createdAt: 2,
      blocks: [invalid],
    })).toThrow(/v2 exact/i);
  });

  test("treats a confirmed durable append as committed when a post-append notification throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcp-journal-post-append-"));
    try {
      const manager = SessionManager.create(dir, dir, { id: "journal-post-append" });
      manager.appendMessage({ role: "user", content: "seed", timestamp: 1 } as any);
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ready" }], timestamp: 2 } as any);
      const operation = createDcpJournalInit("durable-operation", 3);
      const ctx = { sessionManager: manager } as any;
      const pi = {
        appendEntry(customType: string, data: unknown) {
          manager.appendCustomEntry(customType, data);
          throw new Error("simulated entry_appended listener failure");
        },
      } as any;

      expect(() => appendDcpJournalOperation(pi, ctx, operation)).not.toThrow();
      expect(manager.getBranch().some((candidate: any) => candidate.data?.operationId === operation.operationId)).toBe(true);
      expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain(operation.operationId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rolls the active leaf back when append mutated memory but no durable record exists", () => {
    const base = { type: "custom", customType: "fixture", id: "base-entry", parentId: null, data: {} };
    let leafId = base.id;
    let phantom: any;
    const manager = {
      getLeafId: () => leafId,
      getSessionFile: () => "/definitely/not/a/session-file.jsonl",
      getBranch: () => phantom && leafId === phantom.id ? [base, phantom] : [base],
      branch(id: string) { leafId = id; },
      resetLeaf() { leafId = ""; },
    };
    const operation = createDcpJournalInit("failed-operation", 3);
    const pi = {
      appendEntry(customType: string, data: unknown) {
        phantom = { type: "custom", customType, id: "phantom-entry", parentId: leafId, data };
        leafId = phantom.id;
        throw new Error("simulated write failure");
      },
    } as any;

    expect(() => appendDcpJournalOperation(pi, { sessionManager: manager } as any, operation)).toThrow(/failed to append/i);
    expect(leafId).toBe(base.id);
    expect(manager.getBranch().some((candidate: any) => candidate.data?.operationId === operation.operationId)).toBe(false);
  });

});
