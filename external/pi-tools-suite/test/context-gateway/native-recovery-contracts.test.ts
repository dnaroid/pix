import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { createBashToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js";
import { createReadToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
import { registerAstGrepTool } from "../../src/ast-grep/tool.js";
import repoDiscoveryExtension from "../../src/repo-discovery/index.js";
import { applyNativeCompactPolicy } from "../../src/repo-discovery/native-compact.js";

function tempDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function resultText(result: { content: Array<{ type?: string; text?: string }> }): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

function readToolFor(getSource: () => string) {
	return createReadToolDefinition(tmpdir(), {
		operations: {
			async access() {},
			async readFile() { return Buffer.from(getSource(), "utf8"); },
			async detectImageMimeType() { return undefined; },
		},
	});
}

describe("P01-R native recovery contracts", () => {
	test("Read continuation is exact for the SDK text view across CRLF, Unicode, empty/EOF, and large limits", async () => {
		let source = "α\r\nβ🙂\r\nγ\r\nδ";
		const read = readToolFor(() => source);

		const first = await read.execute("read-crlf-1", { path: "fixture.txt", limit: 2 }, undefined, undefined, { cwd: tmpdir() } as any);
		expect(resultText(first)).toBe("α\r\nβ🙂\r\n\n[2 more lines in file. Use offset=3 to continue.]");
		const continuation = await read.execute("read-crlf-2", { path: "fixture.txt", offset: 3, limit: 999 }, undefined, undefined, { cwd: tmpdir() } as any);
		expect(resultText(continuation)).toBe("γ\r\nδ");
		expect(resultText(first)).toContain("\r\n");

		source = "";
		const empty = await read.execute("read-empty", { path: "empty.txt" }, undefined, undefined, { cwd: tmpdir() } as any);
		expect(resultText(empty)).toBe("");
		await expect(read.execute("read-empty-eof", { path: "empty.txt", offset: 2 }, undefined, undefined, { cwd: tmpdir() } as any))
			.rejects.toThrow("beyond end of file");
		expect((read.parameters as any).properties).not.toHaveProperty("byteOffset");
		expect((read.parameters as any).properties).not.toHaveProperty("cursor");
	});

	test("Read byte truncation keeps Unicode valid but a huge single line exposes no line continuation", async () => {
		let source = Array.from({ length: 1_500 }, (_, index) => `🙂-${index}-${"x".repeat(40)}`).join("\n");
		const read = readToolFor(() => source);
		const paged = await read.execute("read-unicode", { path: "unicode.txt" }, undefined, undefined, { cwd: tmpdir() } as any);
		const pagedText = resultText(paged);
		expect((paged.details as any).truncation.truncated).toBe(true);
		expect(pagedText).toContain("Use offset=");
		expect(pagedText).not.toContain("�");

		source = `${"🙂".repeat(20_000)}\nend`;
		const longLine = await read.execute("read-long-line", { path: "long-line.txt" }, undefined, undefined, { cwd: tmpdir() } as any);
		const longLineText = resultText(longLine);
		expect((longLine.details as any).truncation.firstLineExceedsLimit).toBe(true);
		expect(longLineText).toContain("exceeds");
		expect(longLineText).not.toContain("Use offset=");
	});

	test("Read continuation reads the current file version rather than an immutable snapshot", async () => {
		let source = "A1\nA2\nA3\nA4";
		const read = readToolFor(() => source);
		const first = await read.execute("read-version-a", { path: "changing.txt", limit: 2 }, undefined, undefined, { cwd: tmpdir() } as any);
		expect(resultText(first)).toContain("Use offset=3");

		source = "B1\nB2\nB3\nB4";
		const second = await read.execute("read-version-b", { path: "changing.txt", offset: 3, limit: 2 }, undefined, undefined, { cwd: tmpdir() } as any);
		expect(resultText(second)).toBe("B3\nB4");
		expect(resultText(second)).not.toContain("A3");
	});

	test("repo structure/AST native cursors are passed to new executions and do not imply a stable historical index", async () => {
		const root = tempDir("p01r-repo-cursor-");
		mkdirSync(path.join(root, ".indexer-cli"));
		const tools = new Map<string, any>();
		const calls: string[][] = [];
		let indexVersion = "index-A";
		try {
			repoDiscoveryExtension({
				registerCommand() {},
				registerTool(tool: any) { tools.set(tool.name, tool); },
				async exec(_command: string, args: string[]) {
					calls.push(args);
					return { stdout: `${indexVersion}:${args.join(" ")}`, stderr: "", code: 0 };
				},
			} as any, { profile: "native-compact", cwd: root });

			const structure = tools.get("repo_structure");
			const first = await structure.execute("cursor-a", { args: ["--cursor", "20"] }, undefined, undefined, { cwd: root });
			expect(resultText(first)).toContain("index-A");
			indexVersion = "index-B";
			const second = await structure.execute("cursor-b", { args: ["--cursor", "20"] }, undefined, undefined, { cwd: root });
			expect(resultText(second)).toContain("index-B");

			const ast = tools.get("repo_ast");
			indexVersion = "index-C";
			const third = await ast.execute("cursor-c", { target: "helper", args: ["--cursor", "40"] }, undefined, undefined, { cwd: root });
			expect(resultText(third)).toContain("index-C");
			expect(calls).toHaveLength(3);
			expect(calls[0]).toContain("20");
			expect(calls[1]).toContain("20");
			expect(calls[0]).toEqual(calls[1]);
			expect(calls[2]).toContain("40");

			expect(applyNativeCompactPolicy({ command: "structure", args: ["--cursor", "-1"] }).ok).toBe(false);
			expect(applyNativeCompactPolicy({ command: "structure", args: ["--cursor", "9007199254740992"] }).ok).toBe(false);
			expect(applyNativeCompactPolicy({ command: "search", args: ["--cursor", "1"] }).ok).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("successful Bash full output is exact at publication time but remains a mutable/expiring temp file", async () => {
		const root = tempDir("p01r-bash-temp-");
		const source = Array.from({ length: 2_500 }, (_, index) => `bash-${index}-${"z".repeat(48)}`).join("\n");
		const bash = createBashToolDefinition(root, {
			exposeSessionEnvironment: false,
			operations: {
				async exec(_command, _cwd, options) {
					options.onData(Buffer.from(source, "utf8"));
					return { exitCode: 0 };
				},
			},
		});
		const result = await bash.execute("bash-temp", { command: "emit large" }, undefined, undefined, { cwd: root } as any);
		const fullOutputPath = (result.details as any).fullOutputPath as string;
		try {
			expect(fullOutputPath).toBeTruthy();
			expect(existsSync(fullOutputPath)).toBe(true);
			expect(readFileSync(fullOutputPath, "utf8")).toBe(source);
			expect(result.details).not.toHaveProperty("snapshotHash");
			const nativeRead = createReadToolDefinition(root);
			const initialRead = await nativeRead.execute("bash-temp-read", { path: fullOutputPath, offset: 1, limit: 1 }, undefined, undefined, { cwd: root } as any);
			expect(resultText(initialRead)).toContain("bash-0-");

			writeFileSync(fullOutputPath, "replacement-version", "utf8");
			expect(readFileSync(fullOutputPath, "utf8")).toBe("replacement-version");
			const replacementRead = await nativeRead.execute("bash-temp-replaced", { path: fullOutputPath }, undefined, undefined, { cwd: root } as any);
			expect(resultText(replacementRead)).toBe("replacement-version");
			rmSync(fullOutputPath, { force: true });
			expect(existsSync(fullOutputPath)).toBe(false);
			await expect(nativeRead.execute("bash-temp-missing", { path: fullOutputPath }, undefined, undefined, { cwd: root } as any)).rejects.toThrow();
		} finally {
			// Bash owns the shared temp namespace; a consumer may remove only the
			// concrete file it was issued, never the parent temp directory.
			rmSync(fullOutputPath, { force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("actual Read recovers a Bash head fact omitted from the delivered tail via the final native handle", async () => {
		const root = tempDir("p01r-bash-read-recovery-");
		const hiddenFact = "CG_R_C_BASH_FACT=HEAD_ONLY_7Q4M";
		const source = [
			hiddenFact,
			...Array.from({ length: 2_500 }, (_, index) => `bash-tail-${index}-${"t".repeat(48)}`),
		].join("\n");
		const bash = createBashToolDefinition(root, {
			exposeSessionEnvironment: false,
			operations: {
				async exec(_command, _cwd, options) {
					options.onData(Buffer.from(source, "utf8"));
					return { exitCode: 0 };
				},
			},
		});
		const result = await bash.execute("bash-hidden-head", { command: "emit large" }, undefined, undefined, { cwd: root } as any);
		const delivered = resultText(result);
		const fullOutputPath = (result.details as any).fullOutputPath as string;
		try {
			expect(delivered).not.toContain(hiddenFact);
			const read = createReadToolDefinition(root);
			const recovered = await read.execute("read-bash-native-handle", { path: fullOutputPath, offset: 1, limit: 1 }, undefined, undefined, { cwd: root } as any);
			expect(resultText(recovered)).toContain(hiddenFact);
		} finally {
			rmSync(fullOutputPath, { force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("Bash timeout/abort/nonzero preserve visible status but do not return a structured recovery result", async () => {
		const source = Array.from({ length: 2_500 }, (_, index) => `error-${index}-${"e".repeat(48)}`).join("\n");
		for (const mode of ["timeout", "abort", "nonzero"] as const) {
			const controller = new AbortController();
			const bash = createBashToolDefinition(tmpdir(), {
				exposeSessionEnvironment: false,
				operations: {
					async exec(_command, _cwd, options) {
						options.onData(Buffer.from(source, "utf8"));
						if (mode === "timeout") throw new Error("timeout:3");
						if (mode === "abort") {
							controller.abort();
							throw new Error("aborted");
						}
						return { exitCode: 7 };
					},
				},
			});
			let message = "";
			try {
				await bash.execute(
					`bash-${mode}`,
					{ command: "emit failure", ...(mode === "timeout" ? { timeout: 3 } : {}) },
					mode === "abort" ? controller.signal : undefined,
					undefined,
					{ cwd: tmpdir() } as any,
				);
				throw new Error("expected rejection");
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain(mode === "timeout" ? "timed out" : mode === "abort" ? "aborted" : "exited with code 7");
			const match = [...message.matchAll(/Full output: ([^\]\n]+)/g)].at(-1);
			const tempPath = match?.[1];
			if (tempPath && existsSync(tempPath)) rmSync(tempPath, { force: true });
		}
	});

	test("Bash streaming preview can expose a still-growing temp path; only the final successful result is a recovery boundary", async () => {
		const root = tempDir("p01r-bash-streaming-temp-");
		const firstChunk = Array.from({ length: 1_400 }, (_, index) => `first-${index}-${"f".repeat(48)}`).join("\n") + "\n";
		const secondChunk = Array.from({ length: 1_400 }, (_, index) => `second-${index}-${"s".repeat(48)}`).join("\n");
		let release!: () => void;
		let markStarted!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const updates: any[] = [];
		const bash = createBashToolDefinition(root, {
			exposeSessionEnvironment: false,
			operations: {
				async exec(_command, _cwd, options) {
					options.onData(Buffer.from(firstChunk, "utf8"));
					markStarted();
					await gate;
					options.onData(Buffer.from(secondChunk, "utf8"));
					return { exitCode: 0 };
				},
			},
		});
		const execution = bash.execute(
			"bash-streaming-temp",
			{ command: "emit growing output" },
			undefined,
			(update) => updates.push(structuredClone(update)),
			{ cwd: root } as any,
		);
		await started;
		const interim = updates.find((update) => update.details?.fullOutputPath);
		expect(interim?.details?.truncation?.truncated).toBe(true);
		const interimPath = interim.details.fullOutputPath as string;
		// OutputAccumulator assigns the path synchronously, while createWriteStream
		// opens it asynchronously. A streaming/UI preview can therefore advertise
		// a path that is not yet readable. It is not a model recovery capability.
		expect(existsSync(interimPath)).toBe(false);

		release();
		const result = await execution;
		const finalPath = (result.details as any).fullOutputPath as string;
		try {
			expect(finalPath).toBe(interimPath);
			const finalBytes = readFileSync(finalPath, "utf8");
			expect(finalBytes).toContain("first-0-");
			expect(finalBytes).toContain("second-0-");
		} finally {
			rmSync(finalPath, { force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ast_grep publishes a temp artifact only for successful truncation; cancelled/error paths do not fabricate one", async () => {
		const tools = new Map<string, any>();
		let mode: "success" | "cancelled" | "error" = "success";
		const source = Array.from({ length: 2_500 }, (_, index) => `src/a.ts:${index + 1}: helper(${index}) ${"a".repeat(48)}`).join("\n");
		registerAstGrepTool({
			registerTool(tool: any) { tools.set(tool.name, tool); },
			async exec() {
				if (mode === "cancelled") return { stdout: "partial", stderr: "", code: null, killed: true };
				if (mode === "error") return { stdout: "", stderr: "fatal ast error", code: 2, killed: false };
				return { stdout: source, stderr: "", code: 0, killed: false };
			},
		} as any);
		const tool = tools.get("ast_grep");
		const params = { command: "run", pattern: "helper($A)", lang: "ts", paths: ["src"] };

		const success = await tool.execute("ast-success", params, undefined, undefined, { cwd: tmpdir() });
		const fullOutputPath = success.details.fullOutputPath as string;
		try {
			expect(existsSync(fullOutputPath)).toBe(true);
			expect(readFileSync(fullOutputPath, "utf8")).toBe(source);
			writeFileSync(fullOutputPath, "replaced-ast-output", "utf8");
			expect(readFileSync(fullOutputPath, "utf8")).toBe("replaced-ast-output");
		} finally {
			rmSync(path.dirname(fullOutputPath), { recursive: true, force: true });
		}

		mode = "cancelled";
		const cancelled = await tool.execute("ast-cancelled", params, undefined, undefined, { cwd: tmpdir() });
		expect(resultText(cancelled)).toBe("ast-grep cancelled");
		expect(cancelled.details.fullOutputPath).toBeUndefined();

		mode = "error";
		await expect(tool.execute("ast-error", params, undefined, undefined, { cwd: tmpdir() }))
			.rejects.toThrow("ast-grep failed with exit code 2");
	});

	test("actual Read recovers an ast_grep late fact omitted from the delivered head via the final native artifact", async () => {
		const tools = new Map<string, any>();
		const hiddenFact = "CG_R_C_AST_FACT=LATE_ONLY_8W2P";
		const lines = Array.from({ length: 2_500 }, (_, index) => `src/a.ts:${index + 1}: helper(${index}) ${"h".repeat(48)}`);
		lines[2_400] = hiddenFact;
		const source = lines.join("\n");
		registerAstGrepTool({
			registerTool(tool: any) { tools.set(tool.name, tool); },
			async exec() { return { stdout: source, stderr: "", code: 0, killed: false }; },
		} as any);
		const tool = tools.get("ast_grep");
		const result = await tool.execute(
			"ast-hidden-late",
			{ command: "run", pattern: "helper($A)", lang: "ts", paths: ["src"] },
			undefined,
			undefined,
			{ cwd: tmpdir() },
		);
		const fullOutputPath = result.details.fullOutputPath as string;
		try {
			expect(resultText(result)).not.toContain(hiddenFact);
			const read = createReadToolDefinition(tmpdir());
			const recovered = await read.execute("read-ast-native-handle", { path: fullOutputPath, offset: 2_401, limit: 1 }, undefined, undefined, { cwd: tmpdir() } as any);
			expect(resultText(recovered)).toContain(hiddenFact);
		} finally {
			rmSync(path.dirname(fullOutputPath), { recursive: true, force: true });
		}
	});
});

