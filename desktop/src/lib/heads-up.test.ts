import { describe, expect, it } from "vitest";
import { parseHeadsUpSnapshot } from "./heads-up";

const note = { id: "note", title: "Finding", consequence: "Consequence", createdAt: 1, expiresAt: 30001, evidence: [{ id: "entry", text: "evidence" }] };
const state = { version: 1, instanceId: "runtime", revision: 1, enabled: true, model: "provider/model", phase: "idle", checks: 1, inputTokens: 2, outputTokens: 3, notice: note };
describe("Heads up state validation", () => {
  it("accepts the portable contract, rejects unsupported versions, huge and negative values", () => {
    expect(parseHeadsUpSnapshot(state)).toEqual(state);
    for (const value of [{ ...state, version: 2 }, { ...state, phase: "doing-stuff" }, { ...state, revision: -1 }, { ...state, reason: "x".repeat(513) }, { ...state, enabled: false }, { ...state, notice: { ...note, title: "x".repeat(161) } }, { ...state, notice: { ...note, evidence: [] } }, { ...state, notice: { ...note, evidence: [note.evidence[0], note.evidence[0]] } }, { ...state, notice: { ...note, id: "x\noff" } }, Object.assign(Object.create({ polluted: true }), state)]) expect(parseHeadsUpSnapshot(value)).toBeUndefined();
  });
  it("validates bounded stack membership, payload consistency, IDs and disabled state", () => {
    const second = { ...note, id: "note-2", title: "Second" };
    const stacked = { ...state, notice: note, notices: [note, second] };
    expect(parseHeadsUpSnapshot(stacked)?.notices).toHaveLength(2);
    for (const invalid of [
      { ...stacked, notices: [note, second, { ...note, id: "note-3" }, { ...note, id: "note-4" }] },
      { ...stacked, notices: [note, note] },
      { ...stacked, notices: [second] },
      { ...stacked, notice: null },
      { ...stacked, notices: [] },
      { ...stacked, enabled: false },
      { ...stacked, notices: [null] },
    ]) expect(parseHeadsUpSnapshot(invalid)).toBeUndefined();
    expect(parseHeadsUpSnapshot({ ...state, notice: null, notices: [] })?.notices).toEqual([]);
    expect(parseHeadsUpSnapshot(state)?.notices).toBeUndefined();
  });
  it("accepts neutral awaiting-review snapshots without exposing retained claims", () => {
    const waiting = { ...state, notice: null, notices: [], awaitingReview: true };
    expect(parseHeadsUpSnapshot(waiting)).toEqual(waiting);
    expect(parseHeadsUpSnapshot({ ...state, awaitingReview: false })?.notice).toEqual(note);
    for (const invalid of [
      { ...waiting, notice: note }, { ...waiting, notices: [note] },
      { ...waiting, enabled: false }, { ...waiting, phase: "off" },
      { ...waiting, awaitingReview: "true" },
    ]) expect(parseHeadsUpSnapshot(invalid)).toBeUndefined();
  });
  it("round-trips optional issue identity without accepting malformed pairs", () => {
    const notice = { ...note, topic: "api-return-type", subject: "src/sdk.ts:getUser" };
    expect(parseHeadsUpSnapshot({ ...state, notice })?.notice).toEqual(notice);
    for (const patch of [{ subject: undefined }, { topic: "" }, { topic: "x".repeat(81) }, { subject: "a\nb" }]) {
      expect(parseHeadsUpSnapshot({ ...state, notice: { ...notice, ...patch } })).toBeUndefined();
    }
  });
});
