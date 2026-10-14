import { expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import dcpModule from "../src/dcp/index.js";
import { createState } from "../src/dcp/state.js";
import { registerCompressTool } from "../src/dcp/compress-tool.js";

test("DCP reports auto-compression failures, blocked provider sends and manual errors without payloads or repeats", async () => {
  const sinkSymbol = Symbol.for("pix.diagnostics.sink");
  const hostSymbol = Symbol.for("pix.host.runtime");
  const globals = globalThis as Record<symbol, unknown>;
  const previousSink = globals[sinkSymbol], previousHost = globals[hostSymbol];
  const records: Array<{ level: string; event: string; details: Record<string, unknown>; sessionId?: string }> = [];
  globals[hostSymbol] = true;
  globals[sinkSymbol] = (level: string, event: string, details: Record<string, unknown>,
    scope: { sessionId?: string }) => records.push({ level, event, details, sessionId: scope.sessionId });

  try {
    const config = loadConfig({ homeDir: "/__dcp_logging_test__" });
    config.debug = false;
    config.compress.minContextPercent = 0.25;
    config.compress.maxContextPercent = 0.46;
    config.compress.summaryBuffer = false;
    config.compress.protectUserMessages = true;
    config.compress.autoCandidates = { enabled: true, minContextPercent: 0.25,
      keepRecentTurns: 1, minMessages: 2, minTokens: 10 };
    config.compress.autoCompress = { enabled: true, patience: 0, timeoutMs: 1000,
      summarizerModel: [], summarizerFallbackModels: [] };

    const state = createState();
    const handlers = new Map<string, (...args: any[]) => any>();
    const calls: string[] = [];
    const pi = {
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
      registerTool() {}, registerCommand() {}, sendMessage() {},
      appendEntry() {},
    };
    await dcpModule(pi as any, { config, state });
    const ctx = {
      cwd: "/__dcp_logging_test__", model: { provider: "fixture", id: "main", contextWindow: 272_000, maxTokens: 128_000 },
      sessionManager: { getBranch: () => [], getSessionId: () => "dcp-log-fixture" },
      getContextUsage: () => ({ tokens: 145_000, contextWindow: 272_000, percent: 145_000 / 2720 }),
      ui: { notify(text: string) { calls.push(text); } },
      abort() {},
    };
    const message = (id: string, role: string, timestamp: number, content: string) => ({ id, role, timestamp, content });
    const messages = [
      message("old-request", "user", 3, "Continue."),
      message("requirement", "user", 4, `PRIVATE_CONTEXT_${"requirements ".repeat(220)}`),
      message("ack", "assistant", 5, "ack"),
      message("live-user", "user", 6, "ACTIVE_REQUEST ".repeat(50_000)),
    ];
    for (let attempt = 0; attempt < 3; attempt++) {
      state.consecutiveIgnoredNudges = 1;
      await handlers.get("context")!({ type: "context", messages }, ctx);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(records.filter((r) => r.event === "suite:auto-compression-failed")).toHaveLength(1);
    const blocked = records.filter((r) => r.event === "suite:provider-request-blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.level).toBe("error");
    expect(typeof blocked[0]!.details.reason).toBe("string");
    expect(typeof blocked[0]!.details.capacityGapTokens).toBe("number");
    expect(blocked[0]!.sessionId).toBe("dcp-log-fixture");

    let manual: any;
    registerCompressTool({ registerTool(tool: any) { manual = tool; } } as any,
      createState(), config, { isSessionSupported: () => false });
    await expect(manual.execute("id", { topic: "private manual summary" }, undefined, undefined, ctx)).rejects.toThrow("unavailable");
    expect(records.filter((r) => r.event === "suite:manual-compression-failed")).toHaveLength(1);
    expect(records.find((r) => r.event === "suite:manual-compression-failed")?.details.phase).toBe("preflight");

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("PRIVATE_CONTEXT");
    expect(serialized).not.toContain("ACTIVE_REQUEST");
    expect(serialized).not.toContain("private manual summary");
    expect(serialized).not.toContain("requirements");
    expect(calls).toHaveLength(1);
  } finally {
    if (previousSink === undefined) delete globals[sinkSymbol]; else globals[sinkSymbol] = previousSink;
    if (previousHost === undefined) delete globals[hostSymbol]; else globals[hostSymbol] = previousHost;
  }
});
