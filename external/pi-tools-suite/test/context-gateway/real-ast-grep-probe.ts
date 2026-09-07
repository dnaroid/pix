import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import { registerAstGrepTool } from "../../src/ast-grep/tool.js";

function manyLines(head: string, tail: string, count = 2_100): string {
	const middle = Array.from({ length: count }, (_, index) => `line-${String(index + 1).padStart(4, "0")}-payload`);
	return [head, ...middle, tail].join("\n");
}

const head = "P00_AST_GREP_HEAD";
const tail = "P00_AST_GREP_TAIL_OUTSIDE_RESULT";
const source = manyLines(head, tail);
const tools = new Map<string, any>();
const pi = {
	registerTool(tool: any) { tools.set(tool.name, tool); },
	async exec() { return { stdout: source, stderr: "", code: 0 }; },
};

registerAstGrepTool(pi as any);
const tool = tools.get("ast_grep");
if (!tool) throw new Error("ast_grep was not registered");
const result = await tool.execute(
	"ast-grep-capture",
	{ command: "run", pattern: "foo", paths: ["."] },
	undefined,
	undefined,
	{ cwd: tmpdir() },
);
const fullOutputPath = result.details?.fullOutputPath as string | undefined;
const stored = fullOutputPath ? readFileSync(fullOutputPath, "utf8") : "";
const deliveredText = (result.content[0] as any)?.text ?? "";
const truncationContent = result.details?.truncation?.content ?? "";
if (fullOutputPath) rmSync(dirname(fullOutputPath), { recursive: true, force: true });
process.stdout.write(JSON.stringify({
	truncated: result.details?.truncation?.truncated === true,
	deliveredBytes: Buffer.byteLength(deliveredText, "utf8"),
	truncationContentBytes: Buffer.byteLength(truncationContent, "utf8"),
	deliveredStartsWithTruncationContent: deliveredText.startsWith(truncationContent),
	contentHasHead: JSON.stringify(result.content).includes(head),
	contentHasTail: JSON.stringify(result.content).includes(tail),
	storedHasHead: stored.includes(head),
	storedHasTail: stored.includes(tail),
}));
