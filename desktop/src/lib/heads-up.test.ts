import { describe, expect, it } from "vitest";
import { parseHeadsUpSnapshot } from "./heads-up";

const note = { id: "note", title: "Finding", consequence: "Consequence", createdAt: 1, expiresAt: 30001, evidence: [{ id: "entry", text: "evidence" }] };
const state = { version: 1, instanceId: "runtime", revision: 1, enabled: true, model: "provider/model", phase: "idle", checks: 1, inputTokens: 2, outputTokens: 3, notice: note };
describe("Heads up state validation", () => {
  it("accepts the portable contract, rejects unsupported versions, huge and negative values", () => {
    expect(parseHeadsUpSnapshot(state)).toEqual(state);
    for (const value of [{ ...state, version: 2 }, { ...state, phase: "doing-stuff" }, { ...state, revision: -1 }, { ...state, reason: "x".repeat(513) }, { ...state, enabled: false }, { ...state, notice: { ...note, title: "x".repeat(161) } }, { ...state, notice: { ...note, evidence: [] } }, { ...state, notice: { ...note, evidence: [note.evidence[0], note.evidence[0]] } }, { ...state, notice: { ...note, id: "x\noff" } }, Object.assign(Object.create({ polluted: true }), state)]) expect(parseHeadsUpSnapshot(value)).toBeUndefined();
  });
});
