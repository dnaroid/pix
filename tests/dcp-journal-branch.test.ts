import assert from "node:assert/strict";
import { test } from "node:test";
import { DcpJournalError, readDcpJournalBranch } from "../external/pi-tools-suite/src/dcp/journal.js";

type Link = { id: string; parentId: string | null };
const root: Link = { id: "root", parentId: null };
const old: Link = { id: "old", parentId: root.id };
const next: Link = { id: "next", parentId: old.id };
const side: Link = { id: "side", parentId: old.id };

// These fixtures deliberately separate full lineage from the unordered,
// potentially partial presentation entries. A linear-tail mock misses the
// regression. Real JSONL + lazy manager + DCP hooks live in the integration test.
test("journal retry proves parent links, not positions or membership in a lazy tail", async (t) => {
  const cases: Array<{ name: string; snapshot: Link[]; tail: Link[]; allowed: boolean }> = [
    { name: "old snapshot with off-branch entries between ancestors",
      snapshot: [root, old], tail: [root, side, old, next], allowed: true },
    { name: "new snapshot with a side branch between the old and new tip",
      snapshot: [root, old, next], tail: [root, old, side, next], allowed: true },
    { name: "partial tail has no root",
      snapshot: [root, old], tail: [old, side, next], allowed: true },
    { name: "evicted old ancestors are supplied only by the full read",
      snapshot: [root, old], tail: [next], allowed: true },
    { name: "active tip need not be the last presentation entry",
      snapshot: [root, old, next], tail: [old, next, side], allowed: true },
    { name: "fork read tip in the tail is not on the current parent chain",
      snapshot: [root, old, side], tail: [root, old, side, next], allowed: false },
    { name: "old leaf in the tail is not an ancestor of the new leaf",
      snapshot: [root, old], tail: [root, old, { ...next, parentId: root.id }], allowed: false },
    { name: "overlapping identity cannot be reparented",
      snapshot: [root, old], tail: [root, { ...old, parentId: side.id }, side, next], allowed: false },
    { name: "missing descendant link cannot be invented from the snapshot",
      snapshot: [root, old], tail: [{ ...next, parentId: "missing" }], allowed: false },
    { name: "cyclic current parent links fail closed",
      snapshot: [root, old], tail: [old, { ...next, parentId: side.id }, { ...side, parentId: next.id }], allowed: false },
    { name: "duplicate current identities are ambiguous",
      snapshot: [root, old], tail: [old, next, { ...next, parentId: root.id }], allowed: false },
    { name: "malformed full read parent links fail closed",
      snapshot: [root, { ...old, parentId: "missing" }], tail: [root, old, next], allowed: false },
    { name: "duplicate full read identities fail closed",
      snapshot: [root, old, old], tail: [root, old, next], allowed: false },
    { name: "an incomplete full read is never treated as recovery history",
      snapshot: [old], tail: [root, old, next], allowed: false },
  ];
  for (const { name, snapshot, tail, allowed } of cases) {
    await t.test(name, async () => {
      let leaf = old.id, reads = 0;
      const stable = [root, old, next];
      const manager = {
        getSessionId: () => "branch-links",
        getLeafId: () => leaf,
        getBranch: () => tail,
        getEntry() { throw new Error("must not trigger synchronous lazy hydration"); },
        readFullBranchEntriesSync() { throw new Error("must not use a sync full-reader fallback"); },
        readFullBranchEntries: async () => {
          leaf = next.id;
          return ++reads === 1 ? snapshot : stable;
        },
      };
      const reading = readDcpJournalBranch({ sessionManager: manager } as any);
      if (allowed) {
        assert.equal(await reading, stable, "only the stable re-read may be returned, never a merged tail");
        assert.equal(reads, 2);
      } else {
        await assert.rejects(reading, DcpJournalError);
        assert.equal(reads, 1);
      }
    });
  }
});

test("same-branch retry is bounded even when every full read races with an append", async () => {
  const entries = [root, old];
  let reads = 0;
  const manager = {
    getSessionId: () => "moving-tip",
    getLeafId: () => entries.at(-1)!.id,
    getBranch: () => [...entries],
    readFullBranchEntries: async () => {
      const snapshot = [...entries];
      entries.push({ id: `append-${++reads}`, parentId: entries.at(-1)!.id });
      return snapshot;
    },
  };
  await assert.rejects(readDcpJournalBranch({ sessionManager: manager } as any), /branch changed/);
  assert.equal(reads, 3);
});

test("stable leaf identity cannot accept a snapshot read from a transient fork", async () => {
  const manager = {
    getSessionId: () => "fork-back",
    getLeafId: () => old.id,
    getBranch: () => [root, old, side],
    readFullBranchEntries: async () => [root, old, side],
  };
  await assert.rejects(readDcpJournalBranch({ sessionManager: manager } as any), /branch changed/);
});

test("owner replacement and session identity change never authorize a retry", async (t) => {
  for (const change of ["manager", "session-id"] as const) {
    await t.test(change, async () => {
      let reads = 0, sessionId = "original";
      const manager = {
        getSessionId: () => sessionId,
        getLeafId: () => old.id,
        getBranch: () => [root, old],
        readFullBranchEntries: async () => {
          reads++;
          if (change === "manager") ctx.sessionManager = { ...manager };
          else sessionId = "replacement";
          return [root, old];
        },
      };
      const ctx = { sessionManager: manager };
      await assert.rejects(readDcpJournalBranch(ctx as any), /branch changed/);
      assert.equal(reads, 1);
    });
  }
});
