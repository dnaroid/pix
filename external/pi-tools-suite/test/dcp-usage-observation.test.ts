import { describe, expect, test } from "bun:test";
import { dcpUsageObservation } from "../src/dcp/diagnostics.js";
import { ProviderEvidenceTracker } from "../src/dcp/provider-tool-results.js";

const attempt = { sessionEpoch: 1, provider: "fixture", model: "model", contentRevision: "same",
  toolIds: new Set<string>() };
const message = { ...attempt, stopReason: "stop", timestamp: 123,
  content: [{ type: "text", text: "private body" }],
  usage: { input: 2, output: 10, cacheRead: 100, cacheWrite: 20, cacheWrite1h: 20,
    totalTokens: 132, cost: { total: 0 } } };

describe("DCP adapter usage observations", () => {
  test("identical retries correlate once without multiplying the adapter's usage", () => {
    const tracker = new ProviderEvidenceTracker();
    tracker.begin(attempt);
    tracker.begin(attempt);
    const result = dcpUsageObservation(message, tracker.complete(message), "epoch");
    expect(result).toMatchObject({ scope: "assistant-message-reported", correlation: "promote",
      firstRequestId: "epoch:1", lastRequestId: "epoch:2", attempts: 2,
      input: 2, output: 10, cacheRead: 100, cacheWrite: 20, cacheWrite1h: 20, totalTokens: 132 });
    expect(JSON.stringify(result)).not.toContain("private body");
    expect(result).not.toHaveProperty("cost");
    expect(Object.values(result).every(value => value === null || typeof value !== "object")).toBe(true);
    const duplicate = dcpUsageObservation(message, tracker.complete(message), "epoch");
    expect(duplicate).toMatchObject({ correlation: "refused", refusalReason: "no-pending",
      firstRequestId: null, lastRequestId: null, attempts: 0 });
  });

  test.each(["ambiguous", "terminal-failure", "stale-session", "identity-mismatch", "no-pending"])(
    "%s never infers a request ID from adjacency", (reason: string) => {
      const tracker = new ProviderEvidenceTracker();
      tracker.begin(attempt);
      if (reason === "ambiguous") tracker.begin({ ...attempt, contentRevision: "changed" });
      if (reason === "no-pending") tracker.reset();
      const final = { ...message,
        ...(reason === "terminal-failure" ? { stopReason: "error" } : {}),
        ...(reason === "stale-session" ? { sessionEpoch: 2 } : {}),
        ...(reason === "identity-mismatch" ? { model: "other" } : {}) };
      expect(dcpUsageObservation(final, tracker.complete(final), "epoch")).toMatchObject({
        correlation: "refused", refusalReason: reason, firstRequestId: null, lastRequestId: null,
        cacheWrite: 20,
      });
    });

  test("unknown or invalid counters stay unknown; zero does not imply free work", () => {
    const result = dcpUsageObservation({ usage: { input: 0, output: -1, cacheRead: NaN,
      cacheWrite: Infinity, totalTokens: "12" } },
    { status: "refused", reason: "no-pending", attempts: 0 }, "epoch");
    expect(result).toMatchObject({ input: 0, output: null, cacheRead: null, cacheWrite: null,
      cacheWrite1h: null, totalTokens: null, messageTimestamp: null });
    expect(result).not.toHaveProperty("cost");
  });
});
