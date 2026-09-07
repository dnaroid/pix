import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	prepareRecoveryProject,
	RECOVERY_CASES,
	RECOVERY_FACTS,
	recoveryCleanupForCase,
	recoveryProbeForCase,
	type RecoveryCaseId,
} from "./recovery-corpus.js";
import { readRecoveryProbeEvents, type RecoveryProbeEvent } from "./recovery-provenance.js";
import { renderRecoveryMarkdown, toSafeRecoveryRun, type RecoverySafeRun } from "./recovery-report.js";
import { buildRecoveryRunIdentity, RECOVERY_REPORT_VERSION } from "./recovery-run-identity.js";
import { parseEvalModels, runEvalCase } from "./harness/runner.js";
import type { EvalRunResult } from "./harness/types.js";

function assertCorpusDoesNotLeakAnswers(): void {
	for (const evalCase of RECOVERY_CASES) {
		const expectedFact = RECOVERY_FACTS[evalCase.id as RecoveryCaseId];
		if (!expectedFact) throw new Error(`Recovery corpus has no expected fact for ${evalCase.id}`);
		if (evalCase.prompt.includes(expectedFact)) {
			throw new Error(`Recovery corpus prompt leaks its opaque expected value for ${evalCase.id}`);
		}
	}
}

const models = parseEvalModels();
if (models.length === 0) {
	console.error("Set PI_TOOLS_SUITE_EVAL_MODELS before running Context Gateway native recovery evidence.");
	process.exit(2);
}

assertCorpusDoesNotLeakAnswers();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const timeoutMs = Number(process.env.PI_TOOLS_SUITE_EVAL_TIMEOUT_MS ?? 240_000);
const streamIo = /^(1|true|yes)$/i.test(process.env.PI_TOOLS_SUITE_EVAL_STREAM_IO ?? "");
const outputDir = process.env.PI_TOOLS_SUITE_EVAL_OUTPUT_DIR
	? path.resolve(process.env.PI_TOOLS_SUITE_EVAL_OUTPUT_DIR)
	: path.resolve(HERE, "artifacts", `context-gateway-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const identity = buildRecoveryRunIdentity({
	packageRoot: PACKAGE_ROOT,
	repoRoot: REPO_ROOT,
	models,
	caseIds: RECOVERY_CASES.map((evalCase) => evalCase.id),
});

const startedAt = new Date().toISOString();
const runs: RecoverySafeRun[] = [];
for (const model of models) {
	for (const evalCase of RECOVERY_CASES) {
		process.stderr.write(`[context-gateway-recovery] ${model} :: ${evalCase.id}\n`);
		let result: EvalRunResult | undefined;
		try {
			result = await runEvalCase(evalCase, model, {
				timeoutMs,
				streamIo,
				keepProject: true,
				prepareProject: prepareRecoveryProject,
				deleteProjectFilesAfterToolResult: recoveryCleanupForCase(evalCase.id),
				recoveryProbe: recoveryProbeForCase(evalCase.id),
				env: { PI_CONTEXT_GATEWAY_MODE: "observe", PI_REPO_DISCOVERY_PROFILE: "native-compact" },
			});
			const probes = readRecoveryProbeEvents(result.projectDir);
			const safe = toSafeRecoveryRun(result, probes);
			runs.push(safe);
			process.stderr.write(
				`[context-gateway-recovery] task=${safe.taskPassed ? "PASS" : "FAIL"} observation=${safe.observationValid ? "PASS" : "FAIL"} available=${safe.recoveryAvailable ? "YES" : "NO"} strategy=${safe.strategyValid ? "PASS" : "FAIL"}:${safe.reason} calls=${safe.toolCalls} reads=${safe.recoveryReads}\n`,
			);
		} finally {
			if (result?.projectDir) fs.rmSync(result.projectDir, { recursive: true, force: true });
		}
	}
}

const finishedAt = new Date().toISOString();
const report = {
	version: RECOVERY_REPORT_VERSION,
	startedAt,
	finishedAt,
	identity,
	models,
	runs,
};
fs.mkdirSync(outputDir, { recursive: true });
const jsonPath = path.join(outputDir, "context-gateway-recovery-report.json");
const markdownPath = path.join(outputDir, "context-gateway-recovery-report.md");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
fs.writeFileSync(markdownPath, renderRecoveryMarkdown(startedAt, finishedAt, identity, runs), "utf8");

console.log(`JSON: ${jsonPath}`);
console.log(`Markdown: ${markdownPath}`);
console.log(`Runs: ${runs.length}`);
if (runs.some((run) => !run.taskPassed || !run.observationValid || !run.recoveryAvailable || !run.strategyValid)) process.exitCode = 1;
