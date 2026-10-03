import { describe, expect, it } from "vitest";
import { BRAINSTORM_STATE_CHANNEL, brainstormSessionLink, isSessionBrainstormSnapshot, sessionBrainstormSnapshot, updateSessionBrainstormSnapshots } from "./session-brainstorm";

const snapshot = {
  version: 1 as const,
  checkedAt: 10,
  runs: [{
    runId: "run-1", runDir: "/tmp/run-1", topic: "topic", status: "awaiting_synthesis" as const, round: 2,
    participants: [{ slot: 1, sessionId: "stable-acp-id", name: "[BS:run-1] P1", model: "model-x", status: "done" as const, round: 2 }],
  }],
};

describe("session brainstorm snapshots", () => {
  it("uses explicit linkage, stays managed during synthesis and releases on terminal snapshot", () => {
    const meta = { "pix.brainstorm": { runId: "run-1", parentSessionId: "parent", slot: 1, owned: true } };
    expect(brainstormSessionLink("stable-acp-id", meta, new Map())?.owned).toBe(true);
    expect(brainstormSessionLink("stable-acp-id", undefined, new Map([["parent", snapshot]]))).toEqual(meta["pix.brainstorm"]);
    expect(brainstormSessionLink("stable-acp-id", meta, new Map([["parent", { ...snapshot, runs: [{ ...snapshot.runs[0]!, status: "complete" }] }]]))?.owned).toBe(false);
    expect(brainstormSessionLink("[BS:run-1] renamed", undefined, new Map([["parent", snapshot]]))).toBeUndefined();
    expect(brainstormSessionLink("stable-acp-id", { "pix.brainstorm": { owned: true } }, new Map())).toBeUndefined();
  });
  it("parses the versioned channel and rejects malformed or duplicate identities", () => {
    expect(sessionBrainstormSnapshot({ sessionId: "parent", channel: BRAINSTORM_STATE_CHANNEL, data: snapshot })).toEqual(snapshot);
    expect(sessionBrainstormSnapshot({ sessionId: "parent", channel: "other", data: snapshot })).toBeUndefined();
    expect(isSessionBrainstormSnapshot({ ...snapshot, checkedAt: Number.NaN })).toBe(false);
    expect(isSessionBrainstormSnapshot({ ...snapshot, runs: [{ ...snapshot.runs[0]!, participants: [{ ...snapshot.runs[0]!.participants[0]!, sessionId: "" }] }] })).toBe(false);
    expect(isSessionBrainstormSnapshot({ ...snapshot, runs: [snapshot.runs[0], snapshot.runs[0]] })).toBe(false);
  });

  it("keeps newer snapshots and isolates session attachments", () => {
    const original = new Map([ ["parent", snapshot] ]);
    expect(updateSessionBrainstormSnapshots(original, "parent", { ...snapshot, checkedAt: 9 }).get("parent")?.checkedAt).toBe(10);
    const next = updateSessionBrainstormSnapshots(original, "other", { ...snapshot, checkedAt: 1 });
    expect(next.has("parent")).toBe(true);
    expect(next.get("other")?.checkedAt).toBe(1);
  });
});
