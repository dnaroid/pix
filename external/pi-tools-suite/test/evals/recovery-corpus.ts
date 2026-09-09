import * as fs from "node:fs";
import * as path from "node:path";

import type { EvalCase } from "./harness/types.js";
import type { RecoveryProbeConfig } from "./recovery-provenance.js";

export const RECOVERY_CORPUS_VERSION = 2;

export const RECOVERY_FACTS = {
	"recovery.read-offset": "CG_RECOVERY_READ_FACT=R7Q2-M4VX-91PK",
	"recovery.bash-temp-output": "CG_RECOVERY_BASH_FACT=B3NZ-8KQ4-72TW",
	"recovery.ast-grep-temp-output": "astHiddenTargetQ7M4",
} as const;

export type RecoveryCaseId = keyof typeof RECOVERY_FACTS;

const LARGE_LINE_COUNT = 2_500;
const BLOCK_DISCOVERY = [
	"repo_architecture", "repo_search", "repo_structure", "repo_ast", "repo_explain", "repo_deps", "repo_knowledge",
	"todo", "subagents", "async_subagents_spawn", "Grep", "grep", "Glob", "find",
];

export const RECOVERY_CASES: EvalCase[] = [
	{
		id: "recovery.read-offset",
		category: "negative",
		description: "Recover a hidden tail fact using only the built-in Read continuation offset.",
		fixture: "demo",
		blockTools: [...BLOCK_DISCOVERY, "bash", "Bash", "shell", "shell_command", "ast_grep"],
		prompt: [
			"Use only the Read tool to determine the exact value of CG_RECOVERY_READ_FACT in large-read-recovery.txt.",
			"Your first Read call must use the file path with no offset and no limit.",
			"If the result is truncated, follow its native offset continuation with another Read call; do not use grep/search/shell.",
			"Return exactly the full CG_RECOVERY_READ_FACT=... line and nothing else.",
		].join(" "),
		assert: { firstToolOneOf: ["Read", "read"], maxToolCalls: 4, stdoutIncludes: [RECOVERY_FACTS["recovery.read-offset"]] },
	},
	{
		id: "recovery.bash-temp-output",
		category: "negative",
		description: "Recover a head fact hidden by Bash tail truncation through the reported full-output path.",
		fixture: "demo",
		blockTools: [...BLOCK_DISCOVERY, "ast_grep"],
		prompt: [
			"Run `node emit-large-recovery.mjs` exactly once with Bash/shell and determine the exact CG_RECOVERY_BASH_FACT value from that command's output.",
			"The fact is near the beginning and may be outside the delivered tail.",
			"If Bash reports a Full output path, use Read on that output artifact; do not rerun the command and do not read emit-large-recovery.mjs itself.",
			"Return exactly the full CG_RECOVERY_BASH_FACT=... line and nothing else.",
		].join(" "),
		assert: { firstToolOneOf: ["bash", "Bash", "shell", "shell_command"], maxToolCalls: 4, stdoutIncludes: [RECOVERY_FACTS["recovery.bash-temp-output"]] },
	},
	{
		id: "recovery.ast-grep-temp-output",
		category: "negative",
		description: "Recover a late structural match through ast_grep's reported full-output artifact.",
		fixture: "demo",
		blockTools: [...BLOCK_DISCOVERY, "bash", "Bash", "shell", "shell_command"],
		prompt: [
			"Call ast_grep exactly once with command=run, pattern=`helper($A)`, lang=ts, paths=[`src/ast-recovery.ts`].",
			"Determine the exact exported function name for the match whose helper call uses argument 9999. The function name is not given in this prompt.",
			"If ast_grep truncates its delivered result, use Read on its reported full-output artifact; do not rerun ast_grep and do not Read src/ast-recovery.ts directly.",
			"Return only that exact function name.",
		].join(" "),
		assert: { requiredTools: ["ast_grep"], firstTool: "ast_grep", maxToolCalls: 4, stdoutIncludes: [RECOVERY_FACTS["recovery.ast-grep-temp-output"]] },
	},
];

export function prepareRecoveryProject(projectDir: string): void {
	fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
	const readLines = Array.from({ length: LARGE_LINE_COUNT }, (_, index) => `read-${String(index).padStart(4, "0")}-${"r".repeat(48)}`);
	readLines[2_250] = RECOVERY_FACTS["recovery.read-offset"];
	fs.writeFileSync(path.join(projectDir, "large-read-recovery.txt"), readLines.join("\n") + "\n", "utf8");

	fs.writeFileSync(path.join(projectDir, "emit-large-recovery.mjs"), [
		`console.log(${JSON.stringify(RECOVERY_FACTS["recovery.bash-temp-output"])});`,
		`for (let i = 0; i < ${LARGE_LINE_COUNT}; i += 1) console.log(\`bash-\${String(i).padStart(4, "0")}-\${"b".repeat(48)}\`);`,
		"console.log('CG_RECOVERY_BASH_END');",
	].join("\n") + "\n", "utf8");

	const astLines = [
		"function helper<T>(value: T): T { return value; }",
		...Array.from({ length: 900 }, (_, index) => `export function astRecovery${index}() { return helper(${index}); }`),
		`export function ${RECOVERY_FACTS["recovery.ast-grep-temp-output"]}() { return helper(9999); }`,
	];
	fs.writeFileSync(path.join(projectDir, "src", "ast-recovery.ts"), astLines.join("\n") + "\n", "utf8");

	const piDir = path.join(projectDir, ".pi");
	fs.mkdirSync(piDir, { recursive: true });
	fs.writeFileSync(path.join(piDir, "pi-tools-suite.jsonc"), JSON.stringify({
		modules: { "truncation-metadata-normalizer": true },
		contextGateway: { mode: "observe" },
		repoDiscovery: { profile: "native-compact" },
	}, null, 2) + "\n", "utf8");
}

export function recoveryProbeForCase(caseId: string): RecoveryProbeConfig | undefined {
	if (!(caseId in RECOVERY_FACTS)) return undefined;
	const expectedFact = RECOVERY_FACTS[caseId as RecoveryCaseId];
	return {
		expectedFact,
		producerToolNames: caseId === "recovery.bash-temp-output"
			? ["bash", "Bash", "shell", "shell_command"]
			: caseId === "recovery.ast-grep-temp-output"
				? ["ast_grep"]
				: [],
	};
}

export function recoveryCleanupForCase(caseId: string): Record<string, string[]> | undefined {
	if (caseId === "recovery.bash-temp-output") {
		return {
			bash: ["emit-large-recovery.mjs"],
			shell: ["emit-large-recovery.mjs"],
			shell_command: ["emit-large-recovery.mjs"],
		};
	}
	if (caseId === "recovery.ast-grep-temp-output") return { ast_grep: ["src/ast-recovery.ts"] };
	return undefined;
}
