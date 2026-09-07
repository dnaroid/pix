import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import repoDiscoveryExtension from "../src/repo-discovery/index.js";
import {
	applyNativeCompactPolicy,
	describeNativeCompactArgs,
	loadRepoDiscoveryProfile,
	NATIVE_COMPACT_OUTPUT_LIMITS,
	truncateNativeCompactOutput,
} from "../src/repo-discovery/native-compact.js";

type RegisteredTool = {
	name: string;
	parameters: { properties: Record<string, any> };
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { cwd: string },
	) => Promise<{
		content: Array<{ text: string }>;
		isError?: boolean;
		details?: Record<string, any>;
	}>;
};

function tempDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("repo discovery Native Compact config", () => {
	test("defaults to baseline and layers user, PI_CONFIG_DIR, project, and env", () => {
		const root = tempDir("repo-native-config-");
		const home = path.join(root, "home");
		const piConfig = path.join(root, "pi-config");
		const project = path.join(root, "project", "child");
		mkdirSync(path.join(home, ".config", "pi"), { recursive: true });
		mkdirSync(piConfig, { recursive: true });
		mkdirSync(path.join(root, "project", ".pi"), { recursive: true });
		mkdirSync(project, { recursive: true });

		try {
			expect(loadRepoDiscoveryProfile(project, {}, home)).toEqual({ profile: "baseline", issues: [] });
			writeFileSync(path.join(home, ".config", "pi", "pi-tools-suite.jsonc"), `{"repoDiscovery":{"profile":"native-compact"}}`);
			writeFileSync(path.join(piConfig, "pi-tools-suite.jsonc"), `{"repoDiscovery":{"profile":"baseline"}}`);
			writeFileSync(path.join(root, "project", ".pi", "pi-tools-suite.jsonc"), `{"repoDiscovery":{"profile":"native-compact"}}`);

			const layered = loadRepoDiscoveryProfile(project, {
				HOME: home,
				PI_CONFIG_DIR: piConfig,
				PI_REPO_DISCOVERY_PROFILE: "baseline",
			}, home);
			expect(layered).toEqual({ profile: "baseline", issues: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps the previous safe profile and records invalid layers", () => {
		const root = tempDir("repo-native-config-invalid-");
		const home = path.join(root, "home");
		mkdirSync(path.join(home, ".config", "pi"), { recursive: true });
		writeFileSync(path.join(home, ".config", "pi", "pi-tools-suite.jsonc"), `{"repoDiscovery":{"profile":"magic"}}`);
		try {
			const result = loadRepoDiscoveryProfile(root, { HOME: home, PI_REPO_DISCOVERY_PROFILE: "also-magic" }, home);
			expect(result.profile).toBe("baseline");
			expect(result.issues).toHaveLength(2);
			expect(result.issues.join("\n")).toContain("repoDiscovery.profile");
			expect(result.issues.join("\n")).toContain("PI_REPO_DISCOVERY_PROFILE");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("repo discovery Native Compact argument policy", () => {
	test("normalizes equals-form and applies compact native defaults", () => {
		const structure = applyNativeCompactPolicy({ command: "structure", args: ["--path-prefix=src"] });
		expect(structure.ok).toBe(true);
		if (structure.ok) {
			expect(structure.args).toEqual(["--path-prefix", "src", "--max-files", "20", "--max-depth", "2"]);
			expect(structure.maxLines).toBe(NATIVE_COMPACT_OUTPUT_LIMITS.compact.maxLines);
			expect(structure.maxBytes).toBe(NATIVE_COMPACT_OUTPUT_LIMITS.compact.maxBytes);
		}

		const ast = applyNativeCompactPolicy({ command: "ast" });
		expect(ast.ok).toBe(true);
		if (ast.ok) expect(ast.args).toEqual(["--max-depth", "3", "--max-nodes", "40", "--no-include-text"]);

		const search = applyNativeCompactPolicy({ command: "search", args: ["--include-content"] });
		expect(search.ok).toBe(true);
		if (search.ok) expect(search.args).toEqual(["--include-content", "--max-files", "1"]);

		const explain = applyNativeCompactPolicy({ command: "explain" });
		expect(explain.ok).toBe(true);
		if (explain.ok) expect(explain.args).toEqual(["--signature-only"]);

		const explainBody = applyNativeCompactPolicy({ command: "explain", args: ["--include-body"] });
		expect(explainBody.ok).toBe(true);
		if (explainBody.ok) expect(explainBody.args).toEqual(["--include-body", "--body-lines", "20"]);

		const deps = applyNativeCompactPolicy({ command: "deps" });
		expect(deps.ok).toBe(true);
		if (deps.ok) expect(deps.args).toEqual(["--depth", "1"]);
	});

	test("rejects duplicate, malformed, unknown, and conflicting flags before execution", () => {
		const cases = [
			applyNativeCompactPolicy({ command: "search", args: ["--max-files", "1", "--max-files=2"] }),
			applyNativeCompactPolicy({ command: "search", args: ["--include-content=true"] }),
			applyNativeCompactPolicy({ command: "search", args: ["--path-prefix", "--max-files", "1"] }),
			applyNativeCompactPolicy({ command: "search", args: ["--made-up"] }),
			applyNativeCompactPolicy({ command: "search", args: ["--include-tests", "--exclude-tests"] }),
			applyNativeCompactPolicy({ command: "structure", args: ["--no-tests", "--include-tests-summary"] }),
			applyNativeCompactPolicy({ command: "explain", args: ["--include-body", "--signature-only"] }),
		];
		for (const result of cases) {
			expect(result.ok).toBe(false);
			if (result.ok === false) {
				expect(result.outcome.refused).toBe(true);
				expect(result.message.length).toBeGreaterThan(5);
			}
		}
	});

	test("enforces compact limits and allows only a bounded explicit full override", () => {
		const compactRefusals = [
			applyNativeCompactPolicy({ command: "structure", args: ["--max-files", "21"] }),
			applyNativeCompactPolicy({ command: "ast", args: ["--max-nodes=41"] }),
			applyNativeCompactPolicy({ command: "search", args: ["--include-content", "--max-files", "2"] }),
			applyNativeCompactPolicy({ command: "structure", maxLines: 401 }),
			applyNativeCompactPolicy({ command: "structure", maxBytes: 12_001 }),
		];
		for (const result of compactRefusals) {
			expect(result.ok).toBe(false);
		}
		const structureRefusal = compactRefusals[0];
		expect(structureRefusal.ok).toBe(false);
		if (structureRefusal.ok === false) {
			expect(structureRefusal.message).toContain("--max-files<=20");
			expect(structureRefusal.message).toContain("outputMode=full on this same tool call");
			expect(structureRefusal.message).toContain("Do not repeat the rejected compact value unchanged");
		}

		const full = applyNativeCompactPolicy({
			command: "structure",
			args: ["--max-files=300", "--max-depth", "8"],
			outputMode: "full",
			maxLines: 2_000,
			maxBytes: 50_000,
		});
		expect(full.ok).toBe(true);
		if (full.ok) {
			expect(full.args).toEqual(["--max-files", "300", "--max-depth", "8"]);
			expect(full.outcome.outputMode).toBe("full");
		}

		expect(applyNativeCompactPolicy({ command: "structure", args: ["--max-files", "301"], outputMode: "full" }).ok).toBe(false);
		expect(applyNativeCompactPolicy({ command: "search", args: ["--max-files", "51"], outputMode: "full" }).ok).toBe(false);
	});

	test("publishes compact/full native limits as model-facing argument guidance", () => {
		expect(describeNativeCompactArgs("structure")).toContain("--max-files<=20");
		expect(describeNativeCompactArgs("structure")).toContain("--max-files<=300");
		expect(describeNativeCompactArgs("ast")).toContain("--max-nodes<=40");
		expect(describeNativeCompactArgs("search")).toContain("--include-content use exactly --max-files 1");
		expect(describeNativeCompactArgs("deps")).toContain("--depth<=1");
	});
});

describe("repo discovery Native Compact final delivery budget", () => {
	test("keeps the complete result inside both budgets and preserves unicode", () => {
		const source = Array.from({ length: 50 }, (_, index) => `line ${index} 🙂 ${"x".repeat(30)}`).join("\n");
		const result = truncateNativeCompactOutput(source, 8, 240, "compact");
		expect(result.truncation.truncated).toBe(true);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(240);
		expect(result.text.split("\n").length).toBeLessThanOrEqual(8);
		expect(result.text).not.toContain("�");
		expect(result.text).toContain("outputMode=full");
	});

	test("leaves already-bounded output byte-equivalent", () => {
		const source = "one\ntwo\nthree";
		const result = truncateNativeCompactOutput(source, 10, 100, "compact");
		expect(result.text).toBe(source);
		expect(result.truncation.truncated).toBe(false);
	});
});

describe("repo discovery Native Compact wrapper integration", () => {
	test("baseline keeps historical schema/default argv while native compact adds its explicit override", async () => {
		const projectRoot = tempDir("repo-native-wrapper-");
		mkdirSync(path.join(projectRoot, ".indexer-cli"));
		try {
			const baselineTools: RegisteredTool[] = [];
			const baselineCalls: string[][] = [];
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => baselineTools.push(tool),
				exec: async (_command: string, args: string[]) => {
					baselineCalls.push(args);
					return { stdout: "baseline", stderr: "", code: 0 };
				},
			} as never, { profile: "baseline", cwd: projectRoot });
			const baselineSearch = baselineTools.find((tool) => tool.name === "repo_search")!;
			expect(baselineSearch.parameters.properties.outputMode).toBeUndefined();
			await baselineSearch.execute("baseline", { target: "needle" }, undefined, undefined, { cwd: projectRoot });
			expect(baselineCalls).toEqual([["search", "needle"]]);

			const nativeTools: RegisteredTool[] = [];
			const nativeCalls: string[][] = [];
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => nativeTools.push(tool),
				exec: async (_command: string, args: string[]) => {
					nativeCalls.push(args);
					return { stdout: Array.from({ length: 1000 }, (_, i) => `file-${i}.ts`).join("\n"), stderr: "", code: 0 };
				},
			} as never, { profile: "native-compact", cwd: projectRoot });
			const structure = nativeTools.find((tool) => tool.name === "repo_structure")!;
			expect(structure.parameters.properties.outputMode).toMatchObject({ default: "compact", enum: ["compact", "full"] });
			expect(structure.parameters.properties.outputMode.description).toContain("this same tool call");
			expect(structure.parameters.properties.maxLines).toMatchObject({ type: "integer", minimum: 1, maximum: 2_000, default: 400 });
			expect(structure.parameters.properties.maxBytes).toMatchObject({ type: "integer", minimum: 1, maximum: 50_000, default: 12_000 });
			expect(structure.parameters.properties.args.items).toMatchObject({ type: "string", minLength: 1 });
			expect(structure.parameters.properties.args.description).toContain("compact allows --max-files<=20");
			expect(structure.parameters.properties.args.description).toContain("Do not retry a rejected compact value unchanged");
			const result = await structure.execute("native", {}, undefined, undefined, { cwd: projectRoot });
			expect(nativeCalls).toEqual([["structure", "--max-files", "20", "--max-depth", "2"]]);
			expect(result.isError).toBe(false);
			expect((result.details?.nativePolicy as any)).toMatchObject({ profile: "native-compact", outputMode: "compact", refused: false });
			expect(Buffer.byteLength(result.content[0]!.text, "utf8")).toBeLessThanOrEqual(NATIVE_COMPACT_OUTPUT_LIMITS.compact.maxBytes);
			expect(result.content[0]!.text.split("\n").length).toBeLessThanOrEqual(NATIVE_COMPACT_OUTPUT_LIMITS.compact.maxLines);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	test("refuses a policy violation before idx and records only safe policy metadata", async () => {
		const projectRoot = tempDir("repo-native-refusal-");
		mkdirSync(path.join(projectRoot, ".indexer-cli"));
		const calls: string[][] = [];
		try {
			const tools: RegisteredTool[] = [];
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => tools.push(tool),
				exec: async (_command: string, args: string[]) => {
					calls.push(args);
					return { stdout: "must not execute", stderr: "", code: 0 };
				},
			} as never, { profile: "native-compact", cwd: projectRoot });
			const search = tools.find((tool) => tool.name === "repo_search")!;
			const result = await search.execute("bad", {
				target: "PRIVATE_QUERY_SENTINEL",
				args: ["--max-files", "1", "--max-files=2"],
			}, undefined, undefined, { cwd: projectRoot });

			expect(calls).toEqual([]);
			expect(result.isError).toBe(true);
			expect(result.content[0]!.text).toContain("Duplicate search flag");
		const policyJson = JSON.stringify(result.details?.nativePolicy);
			expect(policyJson).not.toContain("PRIVATE_QUERY_SENTINEL");
			expect(policyJson).not.toContain("max-files");
			expect(result.details?.nativePolicy).toMatchObject({ refused: true, reason: "duplicate-flag" });
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
