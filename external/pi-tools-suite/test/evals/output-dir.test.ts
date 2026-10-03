import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEvalOutputDir } from "./harness/output-dir.js";

describe("eval artifact location", () => {
	for (const marker of [".pi", ".git"]) {
		test(`nested package uses the project ${marker} ancestor`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-output-"));
			try {
				fs.mkdirSync(path.join(root, marker));
				const cwd = path.join(root, "external", "pi-tools-suite");
				fs.mkdirSync(cwd, { recursive: true });
				const first = resolveEvalOutputDir("report", undefined, cwd);
				expect(path.dirname(first)).toBe(path.join(root, ".pi", "artifacts", "evals"));
				expect(path.basename(first)).toStartWith("report-");
				expect(resolveEvalOutputDir("report", undefined, cwd)).not.toBe(first);
				expect(resolveEvalOutputDir("report", "custom/evidence", cwd)).toBe(path.join(cwd, "custom", "evidence"));
				expect(resolveEvalOutputDir("report", root, cwd)).toBe(root);
				expect(fs.existsSync(first)).toBe(false);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}
	test("Git worktree marker files and changing caller projects are resolved per call", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-worktree-"));
		try {
			fs.writeFileSync(path.join(root, ".git"), "gitdir: /unused/worktree-marker\n");
			const nested = path.join(root, "nested-project");
			fs.mkdirSync(path.join(nested, ".pi"), { recursive: true });
			expect(path.dirname(resolveEvalOutputDir("worktree", undefined, root))).toBe(path.join(root, ".pi", "artifacts", "evals"));
			expect(path.dirname(resolveEvalOutputDir("nested", undefined, nested))).toBe(path.join(nested, ".pi", "artifacts", "evals"));
			expect(path.dirname(resolveEvalOutputDir("worktree", undefined, root))).toBe(path.join(root, ".pi", "artifacts", "evals"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	test("unmarked standalone directory falls back to cwd", () => {
		// A filesystem root has no project ancestor.
		const cwd = path.parse(process.cwd()).root;
		expect(path.dirname(resolveEvalOutputDir("standalone", undefined, cwd))).toBe(path.join(cwd, ".pi", "artifacts", "evals"));
	});
});
