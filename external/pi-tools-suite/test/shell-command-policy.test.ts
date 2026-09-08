import { describe, expect, test } from "bun:test";

import { classifyShellCommand } from "../src/shell-command-policy.js";

describe("shared shell command policy", () => {
	test("recognises simple read-only inspection commands", () => {
		expect(classifyShellCommand({ command: "git status --short" })).toEqual({ scope: "simple", kind: "inspection" });
		expect(classifyShellCommand({ command: "rg TODO src" })).toEqual({ scope: "simple", kind: "inspection" });
		expect(classifyShellCommand({ command: "rg 'quoted value|other' src" })).toEqual({ scope: "simple", kind: "inspection" });
		expect(classifyShellCommand({ command: "sed -n 1,80p src/a.ts" })).toEqual({ scope: "simple", kind: "inspection" });
	});

	test("proves allowlisted inspection pipelines and ephemeral temp-file staging", () => {
		expect(classifyShellCommand({ command: "find src -type f -print | sort" })).toEqual({ scope: "compound", kind: "inspection" });
		expect(classifyShellCommand({ command: "git status --short && git diff --stat" })).toEqual({ scope: "compound", kind: "inspection" });
		expect(classifyShellCommand({
			command: "rg -n 'needle|other' README.md > /tmp/readme.log; printf 'MATCH\\n'; head -n 20 /tmp/readme.log",
		})).toEqual({ scope: "compound", kind: "inspection" });
	});

	test("recognises bounded verification commands without treating arbitrary scripts as tests", () => {
		expect(classifyShellCommand({ command: "bun test test/dcp-config.test.ts" })).toEqual({ scope: "simple", kind: "test-build" });
		expect(classifyShellCommand({ command: "npm run typecheck" })).toEqual({ scope: "simple", kind: "test-build" });
		expect(classifyShellCommand({ command: "node custom-test-runner.mjs" })).toEqual({ scope: "simple", kind: "unknown" });
	});

	test("fails closed for mutation, unsafe redirects, command substitution, and dangerous inspection flags", () => {
		expect(classifyShellCommand({ command: "git checkout main" })).toEqual({ scope: "simple", kind: "mutation" });
		expect(classifyShellCommand({ command: "rm -rf dist" })).toEqual({ scope: "simple", kind: "mutation" });
		expect(classifyShellCommand({ command: "cat file > out" })).toEqual({ scope: "compound", kind: "mutation" });
		expect(classifyShellCommand({ command: "find src -delete" })).toEqual({ scope: "simple", kind: "unknown" });
		expect(classifyShellCommand({ command: "find src -exec rm {} \\;" })).not.toEqual({ scope: "compound", kind: "inspection" });
		expect(classifyShellCommand({ command: "rg --pre ./formatter needle src" })).toEqual({ scope: "simple", kind: "unknown" });
		expect(classifyShellCommand({ command: "echo $(rm -rf dist)" })).toEqual({ scope: "unknown", kind: "unknown" });
		expect(classifyShellCommand({ command: "git remote set-url origin example" })).toEqual({ scope: "simple", kind: "unknown" });
	});
});
