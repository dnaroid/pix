import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/dcp/config.js";
import dcpModule from "../src/dcp/index.js";
import { createState } from "../src/dcp/state.js";

describe("DCP automatic rejection warning policy", () => {
  for (const pressure of ["routine", "emergency", "capacity"] as const) {
    for (const mode of ["extractive", "model", "model-failure", "already-degraded"] as const) {
      test(`${pressure}: ${mode} distinguishes economic rejection from a preparation failure`, async () => {
        const config = loadConfig({ homeDir: "/__dcp_auto_rejection_policy__" });
        config.debug = false;
        config.compress.minContextPercent = 0.25;
        config.compress.maxContextPercent = 0.46;
        config.compress.summaryBuffer = false;
        config.compress.protectUserMessages = true;
        config.compress.autoCandidates = {
          enabled: true, minContextPercent: 0.25, keepRecentTurns: 1, minMessages: 2, minTokens: 10,
        };
        config.compress.autoCompress = {
          enabled: true, patience: 0, timeoutMs: 1000,
          summarizerModel: mode === "extractive" ? [] : ["fixture/summary"],
          summarizerFallbackModels: [],
        };
        const state = createState();
        const handlers = new Map<string, any>();
        const warnings: string[] = [];
        const diagnostics: any[] = [];
        let modelLookups = 0;
        let aborts = 0;
        let tokens = 73_900;
        await dcpModule({
          on(name: string, handler: any) { handlers.set(name, handler); },
          registerTool() {}, registerCommand() {}, sendMessage() {},
          appendEntry(type: string, data: any) { diagnostics.push({ type, ...data }); },
        } as any, { config, state });
        const ctx: any = {
          cwd: "/__dcp_auto_rejection_policy__",
          model: { provider: "fixture", id: "main", contextWindow: 272_000, maxTokens: 128_000 },
          modelRegistry: {
            find(provider: string, id: string) {
              modelLookups++;
              return mode === "model" ? { provider, id, contextWindow: 128_000, maxTokens: 4096 } : undefined;
            },
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-key", headers: {} }),
            complete: async () => ({
              role: "assistant", content: [{ type: "text", text: "Compact summary." }], stopReason: "stop",
            }),
          },
          sessionManager: { getBranch: () => [], getSessionId: () => "rejection-policy" },
          getContextUsage: () => ({ tokens, contextWindow: 272_000, percent: tokens / 2720 }),
          ui: { notify(message: string) { warnings.push(message); } },
          abort() { aborts++; },
        };
        const messages: any[] = [];
        const text = (id: string, role: string, timestamp: number, content: string) => ({ id, role, timestamp, content });
        const context = async () => {
          state.consecutiveIgnoredNudges = 1;
          return handlers.get("context")({ type: "context", messages }, ctx);
        };
        if (mode === "already-degraded") {
          // Match the incident: an earlier model failure still committed a
          // useful fallback. Later extractive rejection is NOT a new outage.
          messages.push(
            text("seed-user", "user", 1, "Inspect old work."),
            text("seed-answer", "assistant", 2, "Completed investigation details.\n".repeat(1200)),
            text("old-request", "user", 3, "Continue investigation."),
          );
          await context();
          expect(state.compressionBlocks).toHaveLength(1);
          expect(state.compressionBlocks[0]?.autoSummaryRepresentation).toBe("extractive-fallback");
          expect(warnings).toEqual([]);
        } else {
          messages.push(text("old-request", "user", 3, "Continue investigation."));
        }
        // Exact user continuity plus summary overhead is larger than this
        // small source, even if the model itself returns a compact summary.
        messages.push(
          text("requirement", "user", 4, `Constraint: ${"preserve this requirement ".repeat(220)}`),
          text("ack", "assistant", 5, "ack"),
          text("live-user", "user", 6, pressure === "capacity" ? "ACTIVE_REQUEST ".repeat(50_000) : "ACTIVE_REQUEST"),
        );
        tokens = { routine: 73_900, emergency: 135_000, capacity: 145_000 }[pressure];
        const blocksBefore = JSON.stringify(state.compressionBlocks);
        const lookupsBefore = modelLookups;
        for (let retry = 0; retry < 3; retry++) {
          const result = await context();
          expect(JSON.stringify(result.messages)).toContain("ACTIVE_REQUEST");
          expect(JSON.stringify(state.compressionBlocks)).toBe(blocksBefore);
        }
        expect(diagnostics.some((entry) => entry.event === "auto-rejected" && entry.reason === "non-positive-gain")).toBe(true);
        const autoWarnings = warnings.filter((warning) => warning.includes("DCP automatic compression failed"));
        expect(autoWarnings).toHaveLength(pressure === "routine" && mode !== "model-failure" ? 0 : 1);
        if (pressure === "routine" && mode !== "model-failure") expect(warnings).toEqual([]);
        if (pressure === "capacity") expect(aborts).toBeGreaterThan(0);
        else expect(aborts).toBe(0);
        expect(state.compressionProgress?.remainingTokens).toBeGreaterThan(0);
        if (mode === "already-degraded") expect(modelLookups).toBe(lookupsBefore);

        if (pressure !== "routine") return;
        // New source must still be attempted after rejection. Working models
        // remain enabled; previously failed ones remain bypassed.
        const lookupsAfterRejection = modelLookups;
        messages.push(
          text("new-work", "assistant", 7, "Work after the first rejection."),
          text("new-user", "user", 8, "NEW_ACTIVE_REQUEST"),
        );
        const nextProjection = await context();
        expect(JSON.stringify(nextProjection.messages)).toContain("NEW_ACTIVE_REQUEST");
        expect(diagnostics.filter((entry) => entry.event === "auto-rejected")).toHaveLength(4);
        if (mode === "model") expect(modelLookups).toBeGreaterThan(lookupsAfterRejection);
        else expect(modelLookups).toBe(lookupsAfterRejection);
      });
    }
  }
});
