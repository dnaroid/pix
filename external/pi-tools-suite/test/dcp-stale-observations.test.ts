import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import { budgetProtectedToolFragments } from "../src/dcp/compression-blocks.js";
import { applyPruning, detectMessageCompressionCandidates } from "../src/dcp/pruner.js";
import { staleObservationReasons } from "../src/dcp/stale-observations.js";
import { createInputFingerprint, createState, type DcpState, type ToolRecord } from "../src/dcp/state.js";

function dcpConfig() {
  const config = loadConfig({ homeDir: "/__dcp_stale_observations__" });
  Object.assign(config.compress.messageMode, { enabled: true, minContextPercent: 0, keepRecentTurns: 1, mediumTokens: 50, highTokens: 100_000 });
  return config;
}

function call(state: DcpState, messages: any[], id: string, toolName: string, inputArgs: Record<string, unknown>, output: string, options: { isError?: boolean; details?: unknown } = {}): void {
  const timestamp = messages.length + 1;
  messages.push({ role: "assistant", timestamp, content: [{ type: "toolCall", id, name: toolName, arguments: inputArgs }] });
  messages.push({ role: "toolResult", toolCallId: id, toolName, isError: options.isError ?? false, timestamp: timestamp + 0.5, content: [{ type: "text", text: output }] });
  const record: ToolRecord = {
    toolCallId: id, toolName, inputArgs, inputFingerprint: createInputFingerprint(toolName, inputArgs),
    isError: options.isError ?? false, turnIndex: 0, timestamp, tokenEstimate: Math.ceil(output.length / 4),
    outputText: output, outputDetails: options.details,
  };
  state.toolCalls.set(id, record);
}

function scenario() {
  const state = createState();
  const messages: any[] = [{ role: "user", content: "Fix the parser.", timestamp: 0 }];
  call(state, messages, "read-a-1", "read", { path: "src/a.ts" }, "OLD_A ".repeat(200));
  call(state, messages, "read-b-1", "read", { path: "src/b.ts" }, "B ".repeat(200));
  call(state, messages, "test-1", "bash", { command: "bun test" }, "FAIL_ONE ".repeat(200), { isError: true });
  call(state, messages, "commit-1", "bash", { command: "git commit -m wip" }, "COMMIT_ONE ".repeat(20));
  call(state, messages, "edit-a", "edit", { path: "src/a.ts", oldText: "x", newText: "y" }, "ok", { details: { changedFiles: ["src/a.ts"] } });
  call(state, messages, "read-b-2", "read", { path: "src/b.ts" }, "B ".repeat(200));
  call(state, messages, "test-2", "bash", { command: "bun test" }, "FAIL_TWO ".repeat(200), { isError: true });
  call(state, messages, "commit-2", "bash", { command: "git commit -m wip" }, "COMMIT_TWO ".repeat(20));
  call(state, messages, "test-3", "bash", { command: "bun test" }, "200 pass, 0 fail");
  messages.push({ role: "user", content: "Now tidy up.", timestamp: messages.length + 1 });
  return { state, messages };
}

describe("DCP stale observations", () => {
  test("identifies superseded observations and reads of later-edited files, never mutations", () => {
    const { state, messages } = scenario();
    const stale = staleObservationReasons(messages, state, dcpConfig());
    expect(stale.get("read-a-1")).toBe("file changed later by a write/edit");
    expect(stale.get("read-b-1")).toBe("superseded by a later identical call");
    expect(stale.get("test-1")).toBe("superseded by a later identical call");
    expect(stale.get("test-2")).toBe("superseded by a later identical call");
    for (const current of ["read-b-2", "test-3", "edit-a", "commit-1", "commit-2"]) expect(stale.has(current)).toBe(false);
  });

  test("continuity ledger keeps only the newest receipt of a repeated observation", () => {
    const { state } = scenario();
    const fragment = (id: string) => ({
      kind: "tool" as const, origin: `tool:${id}`, hash: id.padEnd(64, "0"), text: `receipt ${id}`,
      representation: "receipt" as const, sourceHash: id.padEnd(64, "1"), sourceBytes: 100, policyVersion: 2 as const,
    });
    const kept = budgetProtectedToolFragments(
      ["test-1", "commit-1", "test-2", "commit-2", "test-3"].map(fragment), state, dcpConfig(),
    ).map((item) => item.origin);
    expect(kept).toEqual(["tool:commit-1", "tool:commit-2", "tool:test-3"]);
  });

  test("stale observations surface as high-priority message candidates with their reason", () => {
    const { state, messages } = scenario();
    const config = dcpConfig();
    const projected = applyPruning(messages, state, config);
    const candidates = detectMessageCompressionCandidates(projected, state, config, 0.5);
    const byCall = new Map(candidates.map((candidate) => [state.messageMetaSnapshot.get(candidate.messageId)?.toolCallId, candidate]));
    expect(byCall.get("read-a-1")).toMatchObject({ priority: "high", stale: "file changed later by a write/edit" });
    expect(byCall.get("read-b-1")).toMatchObject({ priority: "high", stale: "superseded by a later identical call" });
    expect(byCall.get("read-b-2")?.stale).toBeUndefined();
  });

  test("inside the live turn only provider-seen stale observations are suggested", () => {
    const { state, messages } = scenario();
    messages.pop(); // one long autonomous turn: no later user message
    const config = dcpConfig();
    const projected = applyPruning(messages, state, config);
    expect(detectMessageCompressionCandidates(projected, state, config, 0.5)).toEqual([]);

    state.providerSeenToolIds.add("read-b-1");
    state.providerSeenToolIds.add("read-b-2");
    const candidates = detectMessageCompressionCandidates(projected, state, config, 0.5);
    expect(candidates.map((candidate) => state.messageMetaSnapshot.get(candidate.messageId)?.toolCallId)).toEqual(["read-b-1"]);
    expect(candidates[0]).toMatchObject({ priority: "high", stale: "superseded by a later identical call" });
  });

  test("message suggestions never include user messages, even large old ones", () => {
    const { state, messages } = scenario();
    // A large mid-history user message (e.g. pasted requirements) between tool calls.
    messages.splice(5, 0, { role: "user", content: `REQUIREMENTS ${"must keep this constraint ".repeat(400)}END`, timestamp: 2.7 });
    const config = dcpConfig();
    config.compress.messageMode.maxSuggestions = 50;
    const projected = applyPruning(messages, state, config);
    const roles = detectMessageCompressionCandidates(projected, state, config, 0.5).map((candidate) => candidate.role);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles).not.toContain("user");
  });

  test("a ledger drops an observation that a newer identical run supersedes elsewhere in the projection", () => {
    const { state } = scenario();
    const fragment = (id: string) => ({
      kind: "tool" as const, origin: `tool:${id}`, hash: id.padEnd(64, "0"), text: `receipt ${id}`,
      representation: "receipt" as const, sourceHash: id.padEnd(64, "1"), sourceBytes: 100, policyVersion: 2 as const,
    });
    state.toolCalls.get("test-1")!.timestamp = 10;
    state.toolCalls.get("test-3")!.timestamp = 30;
    // test-3 is still raw and visible in the latest projection.
    state.messageMetaSnapshot.set("m090", { timestamp: 30, role: "toolResult", toolCallId: "test-3", tokenEstimate: 10 } as any);
    const kept = budgetProtectedToolFragments([fragment("test-1"), fragment("commit-1")], state, dcpConfig()).map((item) => item.origin);
    expect(kept).toEqual(["tool:commit-1"]);

    // Without a newer occurrence the older run is the current state and survives.
    state.messageMetaSnapshot.clear();
    expect(budgetProtectedToolFragments([fragment("test-1")], state, dcpConfig()).map((item) => item.origin)).toEqual(["tool:test-1"]);
  });
});
