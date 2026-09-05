import { describe, expect, test } from "bun:test";
import { closeConversationRange, detectToolGroupSpans } from "../src/dcp/conversation-index.js";
import type { ConversationIndexEntry } from "../src/dcp/state.js";

interface RefGroup {
  startIndex: number;
  endIndex: number;
  toolCallIds: string[];
  complete: boolean;
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function int(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1));
}

function refGroups(entries: ConversationIndexEntry[]): RefGroup[] {
  const groups: RefGroup[] = [];
  for (let i = 0; i < entries.length; i++) {
    const assistant = entries[i]!;
    if (assistant.role !== "assistant" || !assistant.toolCallIds?.length) continue;
    const pending = new Set(assistant.toolCallIds);
    let endIndex = i;
    let j = i + 1;
    while (j < entries.length && pending.size > 0) {
      const current = entries[j]!;
      if (current.passthrough) {
        endIndex = j++;
        continue;
      }
      if (
        (current.role === "toolResult" || current.role === "bashExecution") &&
        current.toolCallId &&
        pending.has(current.toolCallId)
      ) {
        pending.delete(current.toolCallId);
        endIndex = j++;
        continue;
      }
      break;
    }
    groups.push({ startIndex: i, endIndex, toolCallIds: [...assistant.toolCallIds], complete: pending.size === 0 });
  }
  return groups;
}

function refClose(entries: ConversationIndexEntry[], start: number, end: number) {
  const requestedStartIndex = Math.min(start, end);
  const requestedEndIndex = Math.max(start, end);
  let startIndex = requestedStartIndex;
  let endIndex = requestedEndIndex;
  let incompleteToolGroup = false;
  const groups = refGroups(entries);

  for (;;) {
    let changed = false;
    for (const group of groups) {
      if (group.startIndex > endIndex || group.endIndex < startIndex) continue;
      if (!group.complete) incompleteToolGroup = true;
      if (group.startIndex < startIndex) {
        startIndex = group.startIndex;
        changed = true;
      }
      if (group.endIndex > endIndex) {
        endIndex = group.endIndex;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return {
    requestedStartIndex,
    requestedEndIndex,
    startIndex,
    endIndex,
    startId: entries[startIndex]?.visibleId,
    endId: entries[endIndex]?.visibleId,
    expanded: startIndex !== requestedStartIndex || endIndex !== requestedEndIndex,
    incompleteToolGroup,
  };
}

function generateTrace(seed: number): ConversationIndexEntry[] {
  const next = rng(seed);
  const entries: ConversationIndexEntry[] = [];
  let toolSequence = 0;
  let timestamp = int(next, 1, 4);

  const push = (entry: Omit<ConversationIndexEntry, "index" | "stableId" | "visibleId" | "timestamp" | "origin">) => {
    const index = entries.length;
    // Deliberately collide timestamps often; ordering must come from branch index.
    if (next() > 0.55) timestamp += int(next, 0, 1);
    entries.push({
      index,
      stableId: `stable-${seed}-${index}`,
      visibleId: `m${String(index + 1).padStart(3, "0")}`,
      timestamp,
      origin: "raw",
      ...entry,
    });
  };

  const units = int(next, 5, 24);
  for (let unit = 0; unit < units; unit++) {
    const kind = next();
    if (kind < 0.30) {
      push({ role: next() < 0.5 ? "user" : "assistant", passthrough: false, signedAssistant: false });
      continue;
    }

    const callCount = int(next, 1, 3);
    const ids = Array.from({ length: callCount }, () => `call-${seed}-${toolSequence++}`);
    push({ role: "assistant", toolCallIds: ids, passthrough: false, signedAssistant: next() < 0.15 });

    const resultCount = next() < 0.20 ? int(next, 0, Math.max(0, callCount - 1)) : callCount;
    for (let result = 0; result < resultCount; result++) {
      if (next() < 0.35) {
        push({
          role: ["compaction", "branch_summary", "custom_message"][int(next, 0, 2)]!,
          passthrough: true,
          signedAssistant: false,
        });
      }
      push({
        role: next() < 0.12 ? "bashExecution" : "toolResult",
        toolCallId: ids[result],
        passthrough: false,
        signedAssistant: false,
      });
    }
    // Occasionally place an unrelated non-passthrough message immediately
    // after an incomplete group to prove it cannot be absorbed as a result.
    if (resultCount < callCount && next() < 0.7) {
      push({ role: "assistant", passthrough: false, signedAssistant: false });
    }
  }
  return entries;
}

describe("DCP seeded conversation-index properties", () => {
  test("tool-group detection and range closure match an independent reference", () => {
    const seeds = [1, 7, 42, 99, 31337, 0x5eedc0de];
    for (const seed of seeds) {
      for (let trace = 0; trace < 120; trace++) {
        const traceSeed = (seed + Math.imul(trace + 1, 0x9e3779b1)) >>> 0;
        const entries = generateTrace(traceSeed);
        const snapshot = JSON.stringify(entries);
        const expectedGroups = refGroups(entries);
        const actualGroups = detectToolGroupSpans(entries);
        expect(actualGroups, `group mismatch seed=${traceSeed}`).toEqual(expectedGroups);

        const next = rng(traceSeed ^ 0xa5a5a5a5);
        for (let pick = 0; pick < 6; pick++) {
          const a = int(next, 0, entries.length - 1);
          const b = int(next, 0, entries.length - 1);
          const actual = closeConversationRange(entries, entries[a]!.visibleId!, entries[b]!.visibleId!);
          const expected = refClose(entries, a, b);
          expect(actual, `closure mismatch seed=${traceSeed} a=${a} b=${b}`).toEqual(expected);

          if (actual) {
            for (const group of actualGroups) {
              const overlaps = group.startIndex <= actual.endIndex && group.endIndex >= actual.startIndex;
              if (!overlaps) continue;
              expect(actual.startIndex, `partial start seed=${traceSeed}`).toBeLessThanOrEqual(group.startIndex);
              expect(actual.endIndex, `partial end seed=${traceSeed}`).toBeGreaterThanOrEqual(group.endIndex);
              if (!group.complete) expect(actual.incompleteToolGroup, `missing incomplete flag seed=${traceSeed}`).toBe(true);
            }
          }
        }
        expect(JSON.stringify(entries), `planner mutated input seed=${traceSeed}`).toBe(snapshot);
      }
    }
  });
});
