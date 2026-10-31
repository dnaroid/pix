import type { KnowledgeCheckResult, KnowledgeReportLanguage } from "./contract.js";
import { reportMessage } from "./report-language.js";
import { KNOWLEDGE_REPORT_PREFIX, MAX_KNOWLEDGE_REPORT_BYTES } from "./stamp.js";

/** Measure the exact escaped UTF-8 envelope used by the Markdown report writer. */
function savedBytes(result: KnowledgeCheckResult): number {
  const envelope = { version: 1, checkedAt: "2000-01-01T00:00:00.000Z", result };
  const json = JSON.stringify(envelope).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return Buffer.byteLength("\n" + KNOWLEDGE_REPORT_PREFIX + json + " -->\n", "utf8");
}

/** Whole citations/findings are retained or omitted; quotations are never rewritten to fit. */
export function boundChunkReport(input: KnowledgeCheckResult, language: KnowledgeReportLanguage): KnowledgeCheckResult {
  const conflicts = [...input.conflicts], uncertainties = [...input.uncertainties ?? []], reviewedSources = [...input.reviewedSources ?? []];
  const notices = [...new Set(input.notices.map(notice => notice.slice(0, 2048)))].slice(0, 64);
  let shortened = notices.length < input.notices.length || input.notices.some(notice => notice.length > 2048);
  let findingsDropped = false;
  const add = (key: Parameters<typeof reportMessage>[1]) => {
    const message = reportMessage(language, key);
    if (!notices.includes(message)) notices.push(message);
  };
  if (shortened) add("reportSizeLimit");
  const result = (): KnowledgeCheckResult => ({ ...input, conflicts, uncertainties, reviewedSources, notices,
    status: conflicts.length ? "conflicts" : findingsDropped ? "incomplete" : input.status,
    ...(input.coverage ? { coverage: { ...input.coverage,
      ...(reviewedSources.length !== (input.reviewedSources?.length ?? 0) ? { retainedPassages: reviewedSources.length } : {}) } } : {}) });
  for (;;) {
    const current = result();
    if (savedBytes(current) <= MAX_KNOWLEDGE_REPORT_BYTES) return current;
    if (!shortened) { shortened = true; add("reportSizeLimit"); }
    if (reviewedSources.length) { reviewedSources.pop(); add("reviewedSourcesSampled"); continue; }
    if (uncertainties.length) { uncertainties.pop(); findingsDropped = true; add("uncertaintyLimit"); continue; }
    // Keep one established conflict red even if the remaining finding list cannot fit.
    if (conflicts.length > 1) { conflicts.pop(); findingsDropped = true; add("conflictLimit"); continue; }
    if (notices.length > 4) { notices.splice(0, 1); continue; }
    // Validated field bounds make this unreachable for a normal result.
    throw new Error("The merged Wiki report cannot fit its saved metadata limit.");
  }
}
