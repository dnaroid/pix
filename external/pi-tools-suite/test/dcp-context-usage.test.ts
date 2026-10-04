import { describe, expect, test } from "bun:test";
import { AgentSession, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { createDcpContextUsageResolver } from "../src/dcp/context-usage.js";

const assistant = (input = 0) => ({ role: "assistant", content: [{ type: "text", text: "Done" }],
  timestamp: 1, stopReason: "stop", usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input } } as any);
const usage = (manager: SessionManager) => AgentSession.prototype.getContextUsage.call({
  sessionManager: manager, _limitsModel: () => ({ contextWindow: 100_000 }),
} as any)!;

describe("DCP SDK fallback provenance", () => {
  test("re-estimates projected messages with resolved system sections, not only their content", () => {
    const manager = SessionManager.inMemory();
    const system = { role: "system", content: "base", timestamp: 0,
      sections: { instructions: "Tool policy ".repeat(400) },
      toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }] } as any;
    manager.appendMessage(system);
    manager.appendMessage({ role: "user", content: "Archived detail ".repeat(4000), timestamp: 0 });
    const measuredId = manager.appendMessage(assistant(80_000));
    manager.appendContextEdit(measuredId, { content: [{ type: "text", text: "Edited" }] });
    const projected = [{ role: "user" as const, content: "Short summary", timestamp: 0 }];
    const observed = usage(manager);
    const resolve = createDcpContextUsageResolver(manager.getBranch());
    const result = resolve(observed, projected);
    expect(result.source).toBe("sdk-fallback-rebased");
    expect(result.usage?.tokens).toBe(estimateTokens(system) + estimateTokens(projected[0]!));
    expect(resolve(observed, projected)).toEqual(result); // No cumulative subtraction.
    // New unsaved hook messages are counted immediately, not a stale last-request estimate.
    expect(resolve(observed, [...projected, { role: "user", content: "new ".repeat(8000) }]).usage!.tokens)
      .toBeGreaterThan(result.usage!.tokens! + 7_000);
  });

  test("no-response fallback is corrected, but mismatched/unknown host usage is retained", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "raw ".repeat(4000), timestamp: 0 });
    const resolve = createDcpContextUsageResolver(manager.getBranch());
    const observed = usage(manager);
    expect(resolve(observed, []).usage!.tokens).toBe(0);
    const unknown = { ...observed, tokens: 99_000, percent: 99 };
    expect(resolve(unknown, [])).toEqual({ usage: unknown, source: "sdk" });
    expect(resolve({ contextWindow: 100_000, tokens: null, percent: null }, []).usage?.tokens).toBeNull();
    expect(resolve(undefined, []).usage).toBeUndefined();
  });

  test("post-edit measured usage remains a floor even if equal to the raw estimate", () => {
    const manager = SessionManager.inMemory();
    const id = manager.appendMessage(assistant(10_000));
    manager.appendContextEdit(id, null);
    const measured = assistant(1);
    measured.usage.input = measured.usage.totalTokens = estimateTokens(measured);
    manager.appendMessage(measured);
    const observed = usage(manager);
    expect(createDcpContextUsageResolver(manager.getBranch())(observed, []))
      .toEqual({ usage: observed, source: "sdk" });
  });

  test("failed/aborted responses do not establish a new native floor", () => {
    for (const stopReason of ["error", "aborted"]) {
      const manager = SessionManager.inMemory();
      manager.appendMessage({ ...assistant(90_000), stopReason });
      expect(createDcpContextUsageResolver(manager.getBranch())(usage(manager), []).source)
        .toBe("sdk-fallback-rebased");
    }
  });
});
