import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ComparisonResult } from "../../acp/src/knowledge/comparison.js";
import type { KnowledgeCheckResult } from "../../acp/src/knowledge/contract.js";
import type { KnowledgeEvalClass } from "./cases.js";
import { diagnoseKnowledgeResponse, type KnowledgeEvalScore } from "./scoring.js";
import type { EvalCallRecord } from "./runtime.js";

export interface KnowledgeEvalRun {
  readonly id: string;
  readonly title: string;
  readonly stage: "judge" | "retrieval";
  readonly repetition: number;
  readonly expected: KnowledgeEvalClass;
  readonly expectedConflictPairs: number;
  readonly passed: boolean;
  readonly score?: KnowledgeEvalScore;
  readonly result?: ComparisonResult | KnowledgeCheckResult;
  readonly retrieval?: unknown;
  readonly requestIds: readonly number[];
  readonly elapsedMs: number;
  readonly error?: string;
  readonly notRun?: boolean;
}

export interface KnowledgeEvalReport {
  readonly version: 1;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly model: unknown;
  readonly thinking: string;
  readonly source: unknown;
  readonly maxCalls: number;
  readonly plannedCalls: number;
  readonly plannedCases: { readonly judge: number; readonly retrieval: number };
  readonly runs: readonly KnowledgeEvalRun[];
  readonly requests: readonly EvalCallRecord[];
  readonly stopReason?: string;
}

export function summarizeKnowledgeEval(report: KnowledgeEvalReport) {
  const judge = report.runs.filter(run => run.stage === "judge");
  const scored = judge.filter(run => run.score);
  let truePositivePairs = 0, falsePositivePairs = 0, missedPairs = 0;
  for (const run of scored) {
    const missing = run.score!.missingPairs.filter(pair => pair.outcome === "conflict").length;
    truePositivePairs += run.expectedConflictPairs - missing;
    missedPairs += missing;
    falsePositivePairs += run.score!.unexpectedPairs.filter(pair => pair.outcome === "conflict").length;
  }
  const diagnostics = report.requests.map(request => {
    const prompt = JSON.parse(request.prompt.user);
    return { requestId: request.id, caseId: request.caseId,
      ...(request.error !== undefined ? { providerError: request.error } : {}),
      diagnostic: diagnoseKnowledgeResponse(request.rawText, prompt.draft, prompt.sources) };
  });
  // A successful empty response is invalid JSON, not an absent denominator.
  // Provider failures retain diagnostics but do not masquerade as model answers.
  const responses = diagnostics.filter(response => response.providerError === undefined);
  const findings = responses.flatMap(response => response.diagnostic.findings);
  const count = (runs: readonly KnowledgeEvalRun[], planned: number) => ({ planned,
    passed: runs.filter(run => run.passed && !run.notRun).length,
    failed: runs.filter(run => !run.passed && !run.notRun).length,
    notRun: runs.filter(run => run.notRun).length,
    pending: Math.max(0, planned - runs.length) });
  return {
    total: count(report.runs, report.plannedCases.judge + report.plannedCases.retrieval),
    judge: count(judge, report.plannedCases.judge),
    retrieval: count(report.runs.filter(run => run.stage === "retrieval"), report.plannedCases.retrieval),
    modelCalls: report.requests.length,
    providerErrors: report.requests.filter(request => request.error !== undefined).length,
    technicalIncomplete: scored.filter(run => run.score!.technicalIncomplete).length,
    classificationErrors: scored.filter(run => run.score!.classActual !== run.expected).length,
    pairMetrics: { truePositivePairs, falsePositivePairs, missedPairs,
      precision: truePositivePairs + falsePositivePairs ? truePositivePairs / (truePositivePairs + falsePositivePairs) : null,
      recall: truePositivePairs + missedPairs ? truePositivePairs / (truePositivePairs + missedPairs) : null },
    responses: { total: responses.length, validJson: responses.filter(item => item.diagnostic.jsonValid).length,
      validSchema: responses.filter(item => item.diagnostic.schemaValid).length },
    proposedFindings: findings.length,
    validFindings: findings.filter(finding => finding.valid).length,
    rejectedQuotes: findings.filter(finding => finding.errors.some(error => error.endsWith(":not-found") || error.endsWith(":ambiguous"))).length,
    diagnostics,
  };
}

const escapeCell = (value: unknown) => String(value ?? "—").replaceAll("|", "\\|").replace(/\r?\n/gu, " ");

async function writeAtomically(output: string, name: string, content: string): Promise<void> {
  const temporary = join(output, `.${name}.${randomUUID()}.tmp`);
  let owned = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    owned = true;
    try { await file.writeFile(content, "utf8"); }
    finally { await file.close(); }
    await rename(temporary, join(output, name));
  } finally {
    // Remove only a temporary file successfully created by this call.
    if (owned) await rm(temporary, { force: true });
  }
}

/** Checkpoints remain readable after interruption; detailed request files contain exact rejected quotations. */
export async function writeKnowledgeEvalReport(output: string, report: KnowledgeEvalReport): Promise<void> {
  const summary = summarizeKnowledgeEval(report);
  const metadata = report.model as { modelRef?: string };
  const lines = ["# Wiki contradiction evaluation", "", `Model: ${metadata.modelRef ?? "unavailable"}; thinking: ${report.thinking}.`, "",
    `Started: ${report.startedAt}. Finished: ${report.finishedAt ?? "running"}.`, "",
    `Cases: ${summary.total.passed}/${summary.total.planned} passed; ${summary.total.failed} failed; ${summary.total.notRun} not run; ${summary.total.pending} pending.`,
    `Judge: ${summary.judge.passed}/${summary.judge.planned}; native retrieval: ${summary.retrieval.passed}/${summary.retrieval.planned}.`,
    `Model calls: ${summary.modelCalls}/${report.maxCalls}; provider errors: ${summary.providerErrors}.`,
    `JSON: ${summary.responses.validJson}/${summary.responses.total}; schema: ${summary.responses.validSchema}/${summary.responses.total}; validated proposed findings: ${summary.validFindings}/${summary.proposedFindings}.`, "",
    "JSON/schema rates include completed empty responses as invalid; provider errors are counted separately.", "",
    "Gold labels and claim anchors are fixture-authored and never sent to the model. Production prompts, quote validation and chunk merging are used unchanged.",
    "Judge cases supply known evidence. Native cases separately measure candidates, final selected passages and inclusion of the deciding claim; lexical-only or incomplete semantic retrieval cannot pass that stage.",
    "Pair precision/recall cover scored judge responses only; provider errors and cases not run remain explicit failures of the run. This small synthetic sample is not an estimate of accuracy across an entire real Wiki.", "",
    "| Case | Stage | Repeat | Expected | Actual | Result |", "| --- | --- | ---: | --- | --- | --- |",
    ...report.runs.map(run => `| ${escapeCell(run.id)} | ${run.stage} | ${run.repetition} | ${run.expected} | ${run.score?.classActual ?? "unavailable"} | ${run.notRun ? "not run" : run.passed ? "pass" : "fail"} |`),
  ];
  if (report.stopReason) lines.push("", `Stopped: ${report.stopReason}`);
  for (const run of report.runs.filter(run => !run.passed && !run.notRun)) {
    lines.push("", `## ${run.stage}/${run.id} · ${run.repetition}`);
    if (run.error) lines.push("", `Error: ${run.error}`);
    if (run.score) {
      lines.push("", `Missing expected pairs: ${run.score.missingPairs.length}; unexpected pairs: ${run.score.unexpectedPairs.length}.`);
      for (const notice of run.score.notices) lines.push(`- ${notice}`);
    }
    const requests = run.requestIds.map(id => {
      const name = `call-${String(id).padStart(4, "0")}.json`;
      return `[${name}](requests/${name})`;
    });
    lines.push("", `Requests: ${requests.join(", ") || "none"}. See [report.json](report.json) for the complete result and diagnostics.`);
  }
  await writeAtomically(output, "report.json", JSON.stringify({ ...report, summary }, null, 2) + "\n");
  await writeAtomically(output, "report.md", lines.join("\n") + "\n");
}
