import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import {
	createBashToolDefinition,
	createReadToolDefinition,
	DEFAULT_MAX_BYTES,
} from "@earendil-works/pi-coding-agent";

import repoDiscoveryExtension from "../../src/repo-discovery/index.js";

function manyLines(head: string, tail: string, count = 2_100): string {
	const middle = Array.from({ length: count }, (_, index) => `line-${String(index + 1).padStart(4, "0")}-payload`);
	return [head, ...middle, tail].join("\n");
}

describe("context gateway P00: pre-truncation capture capabilities", () => {
	test("built-in read has full bytes inside execute but exposes only the truncated result", async () => {
		const toolCwd = tmpdir();
		const head = "P00_READ_HEAD";
		const tail = "P00_READ_TAIL_OUTSIDE_RESULT";
		const source = manyLines(head, tail);
		let bytesRead = 0;
		const read = createReadToolDefinition(toolCwd, {
			operations: {
				async access() {},
				async readFile() {
					const bytes = Buffer.from(source, "utf8");
					bytesRead = bytes.length;
					return bytes;
				},
				async detectImageMimeType() { return undefined; },
			},
		});

		const result = await read.execute(
			"read-capture",
			{ path: "large.txt" },
			undefined,
			undefined,
			{ cwd: toolCwd } as any,
		);

		expect(bytesRead).toBe(Buffer.byteLength(source, "utf8"));
		expect(result.details?.truncation?.truncated).toBe(true);
		const deliveredBytes = Buffer.byteLength((result.content[0] as any).text, "utf8");
		expect(deliveredBytes).toBeGreaterThan(8_192);
		expect(deliveredBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 512);
		expect(JSON.stringify(result)).toContain(head);
		expect(JSON.stringify(result)).not.toContain(tail);
		expect((result.details as any)?.fullOutputPath).toBeUndefined();
		const truncationContent = (result.details as any)?.truncation?.content;
		expect(typeof truncationContent).toBe("string");
		expect(Buffer.byteLength(truncationContent, "utf8")).toBeGreaterThan(8_192);
		expect((result.content[0] as any).text.startsWith(truncationContent)).toBe(true);
	});

	test("built-in bash exposes a trusted full-output temp path when its delivered tail is truncated", async () => {
		const toolCwd = tmpdir();
		const head = "P00_BASH_HEAD_OUTSIDE_RESULT";
		const tail = "P00_BASH_TAIL";
		const source = manyLines(head, tail);
		const bash = createBashToolDefinition(toolCwd, {
			exposeSessionEnvironment: false,
			operations: {
				async exec(_command, _cwd, options) {
					options.onData(Buffer.from(source, "utf8"));
					return { exitCode: 0 };
				},
			},
		});

		const result = await bash.execute(
			"bash-capture",
			{ command: "contract large output" },
			undefined,
			undefined,
			{ cwd: toolCwd } as any,
		);

		expect(result.details?.truncation?.truncated).toBe(true);
		const deliveredBytes = Buffer.byteLength((result.content[0] as any).text, "utf8");
		expect(deliveredBytes).toBeGreaterThan(8_192);
		expect(deliveredBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 512);
		expect(JSON.stringify(result.content)).not.toContain(head);
		expect(JSON.stringify(result.content)).toContain(tail);
		const truncationContent = (result.details as any)?.truncation?.content;
		expect(typeof truncationContent).toBe("string");
		expect(Buffer.byteLength(truncationContent, "utf8")).toBeGreaterThan(8_192);
		expect((result.content[0] as any).text.includes(truncationContent)).toBe(true);
		const fullOutputPath = result.details?.fullOutputPath;
		expect(fullOutputPath).toBeTruthy();
		const stored = readFileSync(fullOutputPath!, "utf8");
		expect(stored).toContain(head);
		expect(stored).toContain(tail);
		rmSync(fullOutputPath!, { force: true });
	});

	test("repo_search/repo_ast/repo_structure truncate inside the suite wrapper without a full-output handle", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "context-gateway-p00-repo-"));
		mkdirSync(join(projectRoot, ".indexer-cli"));
		const head = "P00_REPO_HEAD";
		const tail = "P00_REPO_TAIL_OUTSIDE_RESULT";
		const source = manyLines(head, tail, 30);
		const tools = new Map<string, any>();
		const execCalls: Array<{ command: string; args: string[] }> = [];
		const pi = {
			registerTool(tool: any) { tools.set(tool.name, tool); },
			registerCommand() {},
			sendMessage() {},
			async exec(command: string, args: string[]) {
				execCalls.push({ command, args });
				return { stdout: source, stderr: "", code: 0 };
			},
		};
		repoDiscoveryExtension(pi as any, { profile: "baseline", cwd: projectRoot });

		const cases = [
			{ name: "repo_search", params: { target: "context gateway", maxLines: 2, maxBytes: 200 } },
			{ name: "repo_ast", params: { target: "src/app.ts", maxLines: 2, maxBytes: 200 } },
			{ name: "repo_structure", params: { maxLines: 2, maxBytes: 200 } },
		];
		for (const item of cases) {
			const tool = tools.get(item.name);
			expect(tool, `${item.name} should be registered in an indexed project`).toBeTruthy();
			const result = await tool.execute(
				`call-${item.name}`,
				item.params,
				undefined,
				undefined,
				{ cwd: projectRoot },
			);
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(JSON.stringify(result)).toContain(head);
			expect(JSON.stringify(result)).not.toContain(tail);
			expect(result.details?.fullOutputPath).toBeUndefined();
		}
		expect(execCalls).toHaveLength(3);
		expect(execCalls.every((call) => call.command === "idx")).toBe(true);
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("ast_grep truncates its delivered head but preserves the complete output in its temp artifact", async () => {
		const probe = fileURLToPath(new URL("./real-ast-grep-probe.ts", import.meta.url));
		const child = spawnSync(process.execPath, [probe], {
			cwd: fileURLToPath(new URL("../..", import.meta.url)),
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1" },
			timeout: 10_000,
		});
		expect(child.status, child.stderr).toBe(0);
		const result = JSON.parse(child.stdout.trim()) as {
			truncated: boolean;
			deliveredBytes: number;
			truncationContentBytes: number;
			deliveredStartsWithTruncationContent: boolean;
			contentHasHead: boolean;
			contentHasTail: boolean;
			storedHasHead: boolean;
			storedHasTail: boolean;
		};
		expect(result.truncated).toBe(true);
		expect(result.deliveredBytes).toBeGreaterThan(8_192);
		expect(result.deliveredBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 512);
		expect(result.truncationContentBytes).toBeGreaterThan(8_192);
		expect(result.deliveredStartsWithTruncationContent).toBe(true);
		expect(result.contentHasHead).toBe(true);
		expect(result.contentHasTail).toBe(false);
		expect(result.storedHasHead).toBe(true);
		expect(result.storedHasTail).toBe(true);
	});
});
