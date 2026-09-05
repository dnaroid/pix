import { spawnSync } from "node:child_process";
import type { EvalAssertionResult, EvalCase, EvalEvent, EvalRunResult } from "./types.js";
import { isMutationTool, isVerificationCall } from "./metrics.js";

export function evaluateAssertions(evalCase: EvalCase, result: Omit<EvalRunResult, "assertions" | "passed">): EvalAssertionResult[] {
	const assertions: EvalAssertionResult[] = [];
	const toolCalls = result.events.filter((event) => event.type === "tool_call");
	const toolNames = toolCalls.map((event) => event.toolName ?? "unknown");
	const output = `${result.stdout}\n${result.stderr}`;
	const add = (name: string, passed: boolean, detail?: string) => assertions.push({ name, passed, ...(detail ? { detail } : {}) });

	add("process completed", result.exitCode === 0 && !result.timedOut, `exit=${result.exitCode} timedOut=${result.timedOut}`);
	for (const tool of evalCase.assert.requiredTools ?? []) add(`required tool: ${tool}`, toolNames.includes(tool), toolNames.join(" → "));
	for (const tool of evalCase.assert.forbiddenTools ?? []) add(`forbidden tool absent: ${tool}`, !toolNames.includes(tool), toolNames.join(" → "));
	if (evalCase.assert.firstTool) add(`first tool: ${evalCase.assert.firstTool}`, toolNames[0] === evalCase.assert.firstTool, toolNames[0] ?? "none");
	if (evalCase.assert.firstToolOneOf) add("first tool allowed", evalCase.assert.firstToolOneOf.includes(toolNames[0] ?? ""), toolNames[0] ?? "none");
	if (evalCase.assert.maxToolCalls !== undefined) add("tool-call budget", toolCalls.length <= evalCase.assert.maxToolCalls, `${toolCalls.length}/${evalCase.assert.maxToolCalls}`);
	if (evalCase.assert.maxMutations !== undefined) add("mutation budget", result.metrics.mutationCount <= evalCase.assert.maxMutations, `${result.metrics.mutationCount}/${evalCase.assert.maxMutations}`);
	if (evalCase.assert.maxFilesChanged !== undefined) add("changed-file budget", result.metrics.changedFiles.length <= evalCase.assert.maxFilesChanged, `${result.metrics.changedFiles.length}/${evalCase.assert.maxFilesChanged}: ${result.metrics.changedFiles.join(", ")}`);

	if (evalCase.assert.requireReproBeforeMutation) {
		const firstMutation = toolCalls.findIndex((event) => isMutationTool(event.toolName));
		const firstVerification = toolCalls.findIndex(isVerificationCall);
		add("repro/verification before first mutation", firstVerification >= 0 && (firstMutation < 0 || firstVerification < firstMutation), `verify=${firstVerification} mutate=${firstMutation}`);
	}
	if (evalCase.assert.requireVerificationAfterMutation) {
		const lastMutation = findLastIndex(toolCalls, (event) => isMutationTool(event.toolName));
		const verifyAfter = toolCalls.findIndex((event, index) => index > lastMutation && isVerificationCall(event));
		add("behavioral verification after mutation", lastMutation >= 0 && verifyAfter > lastMutation, `lastMutation=${lastMutation} verifyAfter=${verifyAfter}`);
	}
	for (const expected of evalCase.assert.stdoutIncludes ?? []) add(`output includes: ${expected}`, output.toLowerCase().includes(expected.toLowerCase()));
	for (const forbidden of evalCase.assert.stdoutExcludes ?? []) add(`output excludes: ${forbidden}`, !output.toLowerCase().includes(forbidden.toLowerCase()));

	for (const check of evalCase.assert.postRunCommands ?? []) {
		const executed = spawnSync(check.command, { cwd: result.projectDir, shell: true, encoding: "utf8", timeout: 60_000 });
		const expectedExit = check.expectedExit ?? 0;
		add(`post-run command: ${check.command}`, executed.status === expectedExit, `exit=${executed.status}\n${executed.stdout}\n${executed.stderr}`.trim());
		for (const expected of check.stdoutIncludes ?? []) {
			add(`post-run output includes: ${expected}`, `${executed.stdout}\n${executed.stderr}`.toLowerCase().includes(expected.toLowerCase()));
		}
	}

	for (const failure of evalCase.validate?.({ ...result, assertions: [], passed: false }) ?? []) add(`custom: ${failure}`, false, failure);
	return assertions;
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean): number {
	for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index]!, index)) return index;
	return -1;
}
