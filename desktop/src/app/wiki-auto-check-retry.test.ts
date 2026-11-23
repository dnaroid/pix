import { describe, expect, it } from "vitest";
import type { KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { findingInvalid, reportMessage, sourceInvalid } from "../../../acp/src/knowledge/report-language";
import type { ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";
import {
  planWikiAutoCheckRetry, WIKI_AUTO_CHECK_INCOMPLETE_RETRY_MS, WIKI_AUTO_CHECK_TRANSIENT_RETRY_MS, wikiAutoCheckRetryCause,
} from "./wiki-auto-check-retry";

const HASH = "a".repeat(64);
function job(state: ProjectKnowledgeJob["state"], result?: Partial<KnowledgeCheckResult>): ProjectKnowledgeJob {
  return { id: 1, workspace: "/p", path: "wiki/a.md", content: "A", expectedContent: "A", persistStamp: true,
    state, createdAt: 0, ...(result ? { result: { status: "incomplete", path: "wiki/a.md", documentHash: HASH,
      modelRef: "m", checkedSources: 1, conflicts: [], notices: [], ...result } } : {}) };
}
const uncertainty = { sourceId: "S1", draftQuote: "A", existingQuote: "B", explanation: "?" } as never;

describe("automatic Wiki check retry policy", () => {
  it("classifies failures, races and malformed model output as transient", () => {
    expect(wikiAutoCheckRetryCause(job("failed"))).toBe("transient");
    for (const notice of [reportMessage("ru", "corpusChanged"), reportMessage("en", "responseJson"),
      sourceInvalid("ru", "wiki/b.md", reportMessage("ru", "sourceChangedReading"))]) {
      expect(wikiAutoCheckRetryCause(job("completed", { notices: [notice] }))).toBe("transient");
    }
  });

  it("retries other incomplete results once, never conflicts, clear results or clarification", () => {
    const quote = findingInvalid("ru", 1, "findingQuote");
    expect(wikiAutoCheckRetryCause(job("completed", { notices: [quote] }))).toBe("incomplete");
    expect(wikiAutoCheckRetryCause(job("completed", { status: "conflicts" }))).toBeUndefined();
    expect(wikiAutoCheckRetryCause(job("completed", { status: "clear" }))).toBeUndefined();
    expect(wikiAutoCheckRetryCause(job("completed", { uncertainties: [uncertainty] }))).toBeUndefined();
    expect(wikiAutoCheckRetryCause(job("cancelled"))).toBeUndefined();
  });

  it("spends two transient pauses and one incomplete retry per body version", () => {
    const first = planWikiAutoCheckRetry(undefined, job("failed"), HASH, 0)!;
    expect(first).toMatchObject({ transient: 1, at: WIKI_AUTO_CHECK_TRANSIENT_RETRY_MS[0] });
    const second = planWikiAutoCheckRetry(first, job("failed"), HASH, 0)!;
    expect(second).toMatchObject({ transient: 2, at: WIKI_AUTO_CHECK_TRANSIENT_RETRY_MS[1] });
    expect(planWikiAutoCheckRetry(second, job("failed"), HASH, 0)).toBeUndefined();
    const incomplete = planWikiAutoCheckRetry(second, job("completed", { notices: ["x"] }), HASH, 0)!;
    expect(incomplete).toMatchObject({ incomplete: true, at: WIKI_AUTO_CHECK_INCOMPLETE_RETRY_MS });
    expect(planWikiAutoCheckRetry(incomplete, job("completed", { notices: ["x"] }), HASH, 0)).toBeUndefined();
    // A new body version starts with a fresh budget.
    expect(planWikiAutoCheckRetry(second, job("failed"), "b".repeat(64), 0)).toMatchObject({ transient: 1 });
  });
});
