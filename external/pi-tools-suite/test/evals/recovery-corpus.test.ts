import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
	prepareRecoveryProject,
	RECOVERY_CASES,
	RECOVERY_CORPUS_VERSION,
	RECOVERY_FACTS,
	recoveryCleanupForCase,
} from "./recovery-corpus.js";

describe("Context Gateway recovery corpus identity", () => {
	test("keeps opaque expected values out of prompts and versions the corpus", () => {
		expect(RECOVERY_CORPUS_VERSION).toBe(2);
		for (const evalCase of RECOVERY_CASES) {
			const fact = RECOVERY_FACTS[evalCase.id as keyof typeof RECOVERY_FACTS];
			expect(fact).toBeTruthy();
			expect(evalCase.prompt).not.toContain(fact);
			expect(evalCase.assert.stdoutIncludes).toContain(fact);
		}
	});

	test("places each hidden fact in the intended synthetic source and nowhere in config", () => {
		const root = mkdtempSync(join(tmpdir(), "recovery-corpus-contract-"));
		try {
			prepareRecoveryProject(root);
			expect(readFileSync(join(root, "large-read-recovery.txt"), "utf8")).toContain(RECOVERY_FACTS["recovery.read-offset"]);
			expect(readFileSync(join(root, "emit-large-recovery.mjs"), "utf8")).toContain(RECOVERY_FACTS["recovery.bash-temp-output"]);
			expect(readFileSync(join(root, "src", "ast-recovery.ts"), "utf8")).toContain(RECOVERY_FACTS["recovery.ast-grep-temp-output"]);
			const config = readFileSync(join(root, ".pi", "pi-tools-suite.jsonc"), "utf8");
			for (const fact of Object.values(RECOVERY_FACTS)) expect(config).not.toContain(fact);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("cleanup declarations reference only the synthetic producer sources", () => {
		expect(recoveryCleanupForCase("recovery.read-offset")).toBeUndefined();
		expect(recoveryCleanupForCase("recovery.bash-temp-output")).toEqual({
			bash: ["emit-large-recovery.mjs"],
			shell: ["emit-large-recovery.mjs"],
			shell_command: ["emit-large-recovery.mjs"],
		});
		expect(recoveryCleanupForCase("recovery.ast-grep-temp-output")).toEqual({
			ast_grep: ["src/ast-recovery.ts"],
		});
	});
});
