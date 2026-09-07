import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

import { getPiToolsSuiteUserConfigPath } from "../config.js";

export const REPO_DISCOVERY_PROFILES = ["baseline", "native-compact"] as const;
export type RepoDiscoveryProfile = (typeof REPO_DISCOVERY_PROFILES)[number];
export type RepoDiscoveryOutputMode = "compact" | "full";
export type RepoIdxCommand = "architecture" | "structure" | "ast" | "search" | "explain" | "deps";

export const NATIVE_COMPACT_OUTPUT_LIMITS = Object.freeze({
	compact: { maxLines: 400, maxBytes: 12_000 },
	full: { maxLines: 2_000, maxBytes: 50_000 },
});

export interface RepoDiscoveryProfileConfig {
	profile: RepoDiscoveryProfile;
	issues: string[];
}

export interface NativePolicyOutcome {
	version: 1;
	profile: "native-compact";
	outputMode: RepoDiscoveryOutputMode;
	maxLines: number;
	maxBytes: number;
	refused: boolean;
	reason?: NativePolicyRefusalReason;
}

export type NativePolicyRefusalReason =
	| "invalid-wrapper-budget"
	| "unknown-flag"
	| "missing-flag-value"
	| "duplicate-flag"
	| "invalid-flag-value"
	| "conflicting-flags"
	| "compact-limit-exceeded"
	| "full-limit-exceeded";

export type NativePolicyResult =
	| { ok: true; args: string[]; maxLines: number; maxBytes: number; outcome: NativePolicyOutcome }
	| { ok: false; message: string; outcome: NativePolicyOutcome };

export interface NativePolicyParams {
	command: RepoIdxCommand;
	args?: string[];
	maxLines?: number;
	maxBytes?: number;
	outputMode?: RepoDiscoveryOutputMode;
}

export interface StrictTruncation {
	truncated: boolean;
	totalLines: number;
	outputLines: number;
	totalBytes: number;
	outputBytes: number;
}

type FlagKind = "boolean" | "string" | "positive-int" | "nonnegative-int" | "number";
type FlagSpec = { kind: FlagKind; values?: readonly string[] };

const FLAG_SPECS: Record<RepoIdxCommand, Record<string, FlagSpec>> = {
	architecture: {
		"--path-prefix": { kind: "string" },
	},
	structure: {
		"--path-prefix": { kind: "string" },
		"--kind": { kind: "string" },
		"--max-depth": { kind: "positive-int" },
		"--max-files": { kind: "positive-int" },
		"--cursor": { kind: "nonnegative-int" },
		"--include-internal": { kind: "boolean" },
		"--no-tests": { kind: "boolean" },
		"--include-tests-summary": { kind: "boolean" },
	},
	ast: {
		"--max-depth": { kind: "positive-int" },
		"--max-nodes": { kind: "positive-int" },
		"--cursor": { kind: "nonnegative-int" },
		"--no-include-text": { kind: "boolean" },
	},
	search: {
		"--max-files": { kind: "positive-int" },
		"--path-prefix": { kind: "string" },
		"--chunk-types": { kind: "string" },
		"--mode": { kind: "string", values: ["hybrid", "semantic", "lexical", "symbol"] },
		"--include-imports": { kind: "boolean" },
		"--min-score": { kind: "number" },
		"--include-content": { kind: "boolean" },
		"--dedupe-file": { kind: "boolean" },
		"--dedupe-symbol": { kind: "boolean" },
		"--cluster": { kind: "boolean" },
		"--exclude-tests": { kind: "boolean" },
		"--include-tests": { kind: "boolean" },
	},
	explain: {
		"--path-prefix": { kind: "string" },
		"--include-body": { kind: "boolean" },
		"--body-lines": { kind: "positive-int" },
		"--signature-only": { kind: "boolean" },
	},
	deps: {
		"--mode": { kind: "string", values: ["modules", "module-imports", "calls", "call-graph"] },
		"--direction": { kind: "string", values: ["callers", "imported-by", "callees", "imports", "both"] },
		"--depth": { kind: "positive-int" },
		"--show-edges": { kind: "boolean" },
		"--tests": { kind: "boolean" },
	},
};

const COMPACT_NATIVE_LIMITS: Partial<Record<RepoIdxCommand, Record<string, number>>> = {
	structure: { "--max-depth": 2, "--max-files": 20 },
	ast: { "--max-depth": 3, "--max-nodes": 40 },
	search: { "--max-files": 3 },
	explain: { "--body-lines": 20 },
	deps: { "--depth": 1 },
};

const FULL_NATIVE_LIMITS: Partial<Record<RepoIdxCommand, Record<string, number>>> = {
	structure: { "--max-depth": 8, "--max-files": 300 },
	ast: { "--max-depth": 8, "--max-nodes": 500 },
	search: { "--max-files": 50 },
	explain: { "--body-lines": 200 },
	deps: { "--depth": 6 },
};

const NATIVE_COMPACT_ARG_GUIDANCE: Record<RepoIdxCommand, string> = {
	architecture:
		"Native Compact: keep outputMode=compact unless this same tool result is actually truncated; scope with --path-prefix before using full.",
	structure:
		"Native Compact: compact allows --max-files<=20 and --max-depth<=2; continue with --cursor. For an intentional broader structure call, set outputMode=full on that same call (full limits: --max-files<=300, --max-depth<=8). Do not retry a rejected compact value unchanged.",
	ast:
		"Native Compact: compact allows --max-nodes<=40 and --max-depth<=3 and defaults to --no-include-text; continue with --cursor. For an intentional broader AST call, set outputMode=full on that same call (full limits: --max-nodes<=500, --max-depth<=8). Do not retry a rejected compact value unchanged.",
	search:
		"Native Compact: compact allows --max-files<=3; with --include-content use exactly --max-files 1. For an intentional broader search, set outputMode=full on that same call (full limit: --max-files<=50). Do not retry a rejected compact value unchanged.",
	explain:
		"Native Compact: compact defaults to --signature-only; with --include-body use --body-lines<=20. For an intentional broader explanation, set outputMode=full on that same call (full limit: --body-lines<=200). Do not retry a rejected compact value unchanged.",
	deps:
		"Native Compact: compact allows --depth<=1. For an intentional deeper dependency traversal, set outputMode=full on that same call (full limit: --depth<=6). Do not retry a rejected compact value unchanged.",
};

export function describeNativeCompactArgs(command: RepoIdxCommand): string {
	return NATIVE_COMPACT_ARG_GUIDANCE[command];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonc(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
	try {
		const parsed = parseJsonc(readFileSync(filePath, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function findProjectConfig(startDir: string): string | undefined {
	let dir = resolve(startDir);
	const root = parse(dir).root;
	while (true) {
		const candidate = join(dir, ".pi", "pi-tools-suite.jsonc");
		if (existsSync(candidate)) return candidate;
		if (dir === root) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function parseProfile(value: unknown): RepoDiscoveryProfile | undefined {
	if (value === "baseline" || value === "native-compact") return value;
	return undefined;
}

export function loadRepoDiscoveryProfile(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	homeDir: string = env.HOME ?? process.env.HOME ?? homedir(),
): RepoDiscoveryProfileConfig {
	let profile: RepoDiscoveryProfile = "baseline";
	const issues: string[] = [];
	const layers = [getPiToolsSuiteUserConfigPath(homeDir)];
	if (env.PI_CONFIG_DIR) layers.push(join(env.PI_CONFIG_DIR, "pi-tools-suite.jsonc"));
	const projectConfig = findProjectConfig(cwd);
	if (projectConfig) layers.push(projectConfig);

	for (const filePath of layers) {
		const section = readJsonc(filePath).repoDiscovery;
		if (!isRecord(section) || section.profile === undefined) continue;
		const next = parseProfile(section.profile);
		if (next) profile = next;
		else issues.push(`repoDiscovery.profile must be baseline or native-compact; keeping ${profile}.`);
	}

	if (env.PI_REPO_DISCOVERY_PROFILE !== undefined) {
		const next = parseProfile(env.PI_REPO_DISCOVERY_PROFILE);
		if (next) profile = next;
		else issues.push("PI_REPO_DISCOVERY_PROFILE must be baseline or native-compact; ignoring it.");
	}

	return { profile, issues };
}

function validateNumeric(kind: FlagKind, value: string): boolean {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return false;
	if (kind === "number") return true;
	if (!Number.isSafeInteger(numeric)) return false;
	if (kind === "positive-int") return numeric > 0;
	if (kind === "nonnegative-int") return numeric >= 0;
	return true;
}

function parseArgs(command: RepoIdxCommand, args: string[]):
	| { ok: true; normalized: string[]; values: Map<string, string | true> }
	| { ok: false; reason: NativePolicyRefusalReason; message: string } {
	const specs = FLAG_SPECS[command];
	const normalized: string[] = [];
	const values = new Map<string, string | true>();

	for (let index = 0; index < args.length; index++) {
		const token = args[index]!;
		if (!token.startsWith("--")) {
			return { ok: false, reason: "unknown-flag", message: `Unexpected native idx argument: ${token}. Pass only documented flags in args.` };
		}

		const equalsIndex = token.indexOf("=");
		const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
		const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
		const spec = specs[flag];
		if (!spec) return { ok: false, reason: "unknown-flag", message: `Unsupported ${command} flag in Native Compact: ${flag}.` };
		if (values.has(flag)) return { ok: false, reason: "duplicate-flag", message: `Duplicate ${command} flag is not allowed: ${flag}.` };

		if (spec.kind === "boolean") {
			if (inlineValue !== undefined) {
				return { ok: false, reason: "invalid-flag-value", message: `${flag} is a boolean flag and does not accept =value.` };
			}
			values.set(flag, true);
			normalized.push(flag);
			continue;
		}

		const value = inlineValue ?? args[++index];
		if (value === undefined || value.length === 0) {
			return { ok: false, reason: "missing-flag-value", message: `${flag} requires a value.` };
		}
		if (inlineValue === undefined && value.startsWith("--")) {
			return { ok: false, reason: "missing-flag-value", message: `${flag} requires a value before the next flag.` };
		}
		if (spec.values && !spec.values.includes(value)) {
			return { ok: false, reason: "invalid-flag-value", message: `${flag} must be one of: ${spec.values.join(", ")}.` };
		}
		if (["positive-int", "nonnegative-int", "number"].includes(spec.kind) && !validateNumeric(spec.kind, value)) {
			return { ok: false, reason: "invalid-flag-value", message: `${flag} has an invalid numeric value.` };
		}
		values.set(flag, value);
		normalized.push(flag, value);
	}

	return { ok: true, normalized, values };
}

function numericValue(values: Map<string, string | true>, flag: string): number | undefined {
	const raw = values.get(flag);
	return typeof raw === "string" ? Number(raw) : undefined;
}

function appendValue(args: string[], values: Map<string, string | true>, flag: string, value: string): void {
	if (values.has(flag)) return;
	values.set(flag, value);
	args.push(flag, value);
}

function appendBoolean(args: string[], values: Map<string, string | true>, flag: string): void {
	if (values.has(flag)) return;
	values.set(flag, true);
	args.push(flag);
}

function refusal(
	outputMode: RepoDiscoveryOutputMode,
	maxLines: number,
	maxBytes: number,
	reason: NativePolicyRefusalReason,
	message: string,
): NativePolicyResult {
	return {
		ok: false,
		message,
		outcome: { version: 1, profile: "native-compact", outputMode, maxLines, maxBytes, refused: true, reason },
	};
}

function validWrapperBudget(value: number | undefined): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function applyNativeCompactPolicy(params: NativePolicyParams): NativePolicyResult {
	const outputMode = params.outputMode ?? "compact";
	if (outputMode !== "compact" && outputMode !== "full") {
		return refusal("compact", NATIVE_COMPACT_OUTPUT_LIMITS.compact.maxLines, NATIVE_COMPACT_OUTPUT_LIMITS.compact.maxBytes, "invalid-flag-value", "Native Compact outputMode must be compact or full.");
	}
	const outputLimits = NATIVE_COMPACT_OUTPUT_LIMITS[outputMode];
	const maxLines = params.maxLines === undefined ? outputLimits.maxLines : params.maxLines;
	const maxBytes = params.maxBytes === undefined ? outputLimits.maxBytes : params.maxBytes;
	if (!validWrapperBudget(maxLines) || !validWrapperBudget(maxBytes)) {
		return refusal(outputMode, outputLimits.maxLines, outputLimits.maxBytes, "invalid-wrapper-budget", "Native Compact maxLines/maxBytes must be positive integers.");
	}
	if (maxLines > outputLimits.maxLines || maxBytes > outputLimits.maxBytes) {
		return refusal(
			outputMode,
			maxLines,
			maxBytes,
			outputMode === "compact" ? "compact-limit-exceeded" : "full-limit-exceeded",
			`Native Compact ${outputMode} output budget exceeded. Allowed maxLines=${outputLimits.maxLines}, maxBytes=${outputLimits.maxBytes}.`,
		);
	}

	const parsed = parseArgs(params.command, params.args ?? []);
	if (parsed.ok === false) return refusal(outputMode, maxLines, maxBytes, parsed.reason, parsed.message);
	const args = [...parsed.normalized];
	const values = parsed.values;

	if (params.command === "search" && values.has("--include-tests") && values.has("--exclude-tests")) {
		return refusal(outputMode, maxLines, maxBytes, "conflicting-flags", "repo_search cannot combine --include-tests with --exclude-tests.");
	}
	if (params.command === "structure" && values.has("--no-tests") && values.has("--include-tests-summary")) {
		return refusal(outputMode, maxLines, maxBytes, "conflicting-flags", "repo_structure cannot combine --no-tests with --include-tests-summary.");
	}
	if (params.command === "explain" && values.has("--include-body") && values.has("--signature-only")) {
		return refusal(outputMode, maxLines, maxBytes, "conflicting-flags", "repo_explain cannot combine --include-body with --signature-only.");
	}

	if (outputMode === "compact") {
		if (params.command === "structure") {
			appendValue(args, values, "--max-files", "20");
			appendValue(args, values, "--max-depth", "2");
		}
		if (params.command === "ast") {
			appendValue(args, values, "--max-depth", "3");
			appendValue(args, values, "--max-nodes", "40");
			appendBoolean(args, values, "--no-include-text");
		}
		if (params.command === "search" && values.has("--include-content")) {
			appendValue(args, values, "--max-files", "1");
		}
		if (params.command === "explain") {
			if (values.has("--include-body")) appendValue(args, values, "--body-lines", "20");
			else appendBoolean(args, values, "--signature-only");
		}
		if (params.command === "deps") appendValue(args, values, "--depth", "1");
	}

	const nativeLimits = outputMode === "compact" ? COMPACT_NATIVE_LIMITS[params.command] : FULL_NATIVE_LIMITS[params.command];
	for (const [flag, maximum] of Object.entries(nativeLimits ?? {})) {
		const value = numericValue(values, flag);
		if (value !== undefined && value > maximum) {
			const recovery = outputMode === "compact"
				? `Retry with ${flag}<=${maximum} (prefer a native cursor/narrower scope), or set outputMode=full on this same tool call when the broader request is intentional. Do not repeat the rejected compact value unchanged.`
				: `Retry with ${flag}<=${maximum} and narrow/page the request. Do not repeat the rejected full value unchanged.`;
			return refusal(
				outputMode,
				maxLines,
				maxBytes,
				outputMode === "compact" ? "compact-limit-exceeded" : "full-limit-exceeded",
				`${flag}=${value} exceeds Native Compact ${outputMode} limit ${maximum}. ${recovery}`,
			);
		}
	}

	if (params.command === "search" && outputMode === "compact" && values.has("--include-content")) {
		const maxFiles = numericValue(values, "--max-files");
		if (maxFiles !== 1) {
			return refusal(
				outputMode,
				maxLines,
				maxBytes,
				"compact-limit-exceeded",
				"--include-content in compact mode requires --max-files 1. Retry with --max-files 1, or set outputMode=full on this same search call when broad inline content is intentional; do not repeat the rejected compact value unchanged.",
			);
		}
	}

	return {
		ok: true,
		args,
		maxLines,
		maxBytes,
		outcome: { version: 1, profile: "native-compact", outputMode, maxLines, maxBytes, refused: false },
	};
}

function truncateUtf8Prefix(text: string, maxBytes: number): string {
	let output = "";
	let bytes = 0;
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > maxBytes) break;
		output += char;
		bytes += charBytes;
	}
	return output;
}

export function truncateNativeCompactOutput(
	text: string,
	maxLines: number,
	maxBytes: number,
	outputMode: RepoDiscoveryOutputMode,
): { text: string; truncation: StrictTruncation } {
	const totalBytes = Buffer.byteLength(text, "utf8");
	const lines = text.split("\n");
	if (lines.length <= maxLines && totalBytes <= maxBytes) {
		return {
			text,
			truncation: { truncated: false, totalLines: lines.length, outputLines: lines.length, totalBytes, outputBytes: totalBytes },
		};
	}

	const maxBodyLines = Math.max(0, maxLines - 1);
	let body = lines.slice(0, maxBodyLines).join("\n");
	let bodyBytes = Buffer.byteLength(body, "utf8");
	let bodyLines = body.length === 0 ? 0 : body.split("\n").length;
	const continuation = outputMode === "compact"
		? "Use a native cursor/narrower scope or outputMode=full."
		: "Use a native cursor or narrower scope.";

	for (let attempt = 0; attempt < 4; attempt++) {
		const marker = `[Output truncated: first ${bodyLines}/${lines.length} lines, ${bodyBytes}/${totalBytes} bytes. ${continuation}]`;
		const markerBytes = Buffer.byteLength(marker, "utf8");
		const separatorBytes = body.length > 0 ? 1 : 0;
		const availableBodyBytes = Math.max(0, maxBytes - markerBytes - separatorBytes);
		if (bodyBytes > availableBodyBytes) {
			body = truncateUtf8Prefix(body, availableBodyBytes);
			bodyBytes = Buffer.byteLength(body, "utf8");
			bodyLines = body.length === 0 ? 0 : body.split("\n").length;
			continue;
		}
		const finalText = body.length > 0 ? `${body}\n${marker}` : truncateUtf8Prefix(marker, maxBytes);
		return {
			text: finalText,
			truncation: { truncated: true, totalLines: lines.length, outputLines: bodyLines, totalBytes, outputBytes: bodyBytes },
		};
	}

	const fallback = truncateUtf8Prefix("[Output truncated; narrow the idx query.]", maxBytes);
	return {
		text: fallback,
		truncation: { truncated: true, totalLines: lines.length, outputLines: 0, totalBytes, outputBytes: 0 },
	};
}
