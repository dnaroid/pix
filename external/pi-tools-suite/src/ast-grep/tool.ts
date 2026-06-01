import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { astGrepToolDescriptions } from "../tool-descriptions";
import { renderAstApplyCall, renderAstGrepCall, renderAstGrepResult } from "./render";
import { AstApplyParams, AstGrepParams } from "./schema";
import type { AstGrepDetails, AstGrepParamsType } from "./types";
import { cleanPath, countLikelyMatches, normalizeNonNegativeInteger } from "./utils";

type NormalizedAstGrepParams = {
	mode: "run" | "scan";
	paths: string[];
	context?: number;
	before?: number;
	after?: number;
	threads?: number;
	maxResults?: number;
};

function pushJsonArg(args: string[], params: AstGrepParamsType) {
	if (params.json) args.push(`--json=${params.jsonStyle ?? "pretty"}`);
}

function pushSeverityArgs(args: string[], flag: "error" | "warning" | "info" | "hint" | "off", ids?: string[]) {
	for (const id of ids ?? []) {
		args.push(id ? `--${flag}=${id}` : `--${flag}`);
	}
}

function validateParams(params: AstGrepParamsType, options: { allowUpdateAll: boolean } = { allowUpdateAll: false }): NormalizedAstGrepParams {
	const mode = params.command ?? "run";

	if (params.updateAll && !options.allowUpdateAll) {
		throw new Error("ast_grep is read-only; use ast_apply to apply rewrites/fixes");
	}

	if (params.filesWithMatches && params.json) {
		throw new Error("filesWithMatches conflicts with json");
	}
	if (params.filesWithMatches && params.rewrite) {
		throw new Error("filesWithMatches conflicts with rewrite");
	}
	if (params.filesWithMatches && params.updateAll) {
		throw new Error("filesWithMatches conflicts with updateAll");
	}
	if (params.updateAll && params.json) {
		throw new Error("updateAll conflicts with json: ast-grep does not apply rewrites while emitting JSON");
	}
	if (params.context !== undefined && (params.before !== undefined || params.after !== undefined)) {
		throw new Error("context conflicts with before/after; choose one style");
	}
	if (params.debugQuery && !params.lang) {
		throw new Error("debugQuery requires lang");
	}

	if (mode === "run") {
		if (!params.pattern?.trim()) throw new Error("pattern is required when command=run");
		if (params.updateAll && !params.rewrite) throw new Error("updateAll requires rewrite when command=run");
		if (
			params.rule || params.inlineRules || params.format || params.reportStyle || params.includeMetadata ||
			params.filter || params.maxResults !== undefined || params.error || params.warning || params.info || params.hint ||
			params.off
		) {
			throw new Error("scan-only options require command=scan");
		}
	} else {
		if (params.pattern || params.rewrite || params.selector || params.strictness || params.debugQuery || params.lang) {
			throw new Error("pattern/rewrite/lang/selector/strictness/debugQuery are run-only options; use command=run");
		}
		if (params.rule && params.inlineRules) throw new Error("rule conflicts with inlineRules");
		if (params.rule && params.filter) throw new Error("rule conflicts with filter");
		if (params.includeMetadata && !params.json) throw new Error("includeMetadata requires json");
	}

	return {
		mode,
		paths: (params.paths && params.paths.length > 0 ? params.paths : ["."]).map(cleanPath),
		context: normalizeNonNegativeInteger(params.context, "context"),
		before: normalizeNonNegativeInteger(params.before, "before"),
		after: normalizeNonNegativeInteger(params.after, "after"),
		threads: normalizeNonNegativeInteger(params.threads, "threads"),
		maxResults: normalizeNonNegativeInteger(params.maxResults, "maxResults"),
	};
}

function appendSharedArgs(args: string[], params: AstGrepParamsType, normalized: NormalizedAstGrepParams) {
	if (params.config) args.push("--config", cleanPath(params.config));
	if (params.updateAll) args.push("--update-all");
	if (params.filesWithMatches) args.push("--files-with-matches");
	pushJsonArg(args, params);
	if (params.follow) args.push("--follow");
	if (normalized.threads !== undefined) args.push("--threads", String(normalized.threads));
	if (params.inspect) args.push("--inspect", params.inspect);
	if (normalized.context !== undefined) args.push("--context", String(normalized.context));
	if (normalized.before !== undefined) args.push("--before", String(normalized.before));
	if (normalized.after !== undefined) args.push("--after", String(normalized.after));
	for (const glob of params.globs ?? []) args.push("--globs", glob);
	for (const mode of params.noIgnore ?? []) args.push("--no-ignore", mode);
}

function buildAstGrepArgs(params: AstGrepParamsType, normalized: NormalizedAstGrepParams): string[] {
	if (normalized.mode === "run") {
		const args = ["run", "--pattern", params.pattern!, "--color", "never", "--heading", "never"];
		if (params.lang) args.push("--lang", params.lang);
		if (params.selector) args.push("--selector", params.selector);
		if (params.strictness) args.push("--strictness", params.strictness);
		if (params.debugQuery) args.push(`--debug-query=${params.debugQuery}`);
		if (params.rewrite) args.push("--rewrite", params.rewrite);
		appendSharedArgs(args, params, normalized);
		args.push(...normalized.paths);
		return args;
	}

	const args = ["scan", "--color", "never"];
	if (params.rule) args.push("--rule", cleanPath(params.rule));
	if (params.inlineRules) args.push("--inline-rules", params.inlineRules);
	if (params.format) args.push("--format", params.format);
	if (params.reportStyle) args.push("--report-style", params.reportStyle);
	if (params.includeMetadata) args.push("--include-metadata");
	if (params.filter) args.push("--filter", params.filter);
	pushSeverityArgs(args, "error", params.error);
	pushSeverityArgs(args, "warning", params.warning);
	pushSeverityArgs(args, "info", params.info);
	pushSeverityArgs(args, "hint", params.hint);
	pushSeverityArgs(args, "off", params.off);
	appendSharedArgs(args, params, normalized);
	if (normalized.maxResults !== undefined) args.push("--max-results", String(normalized.maxResults));
	args.push(...normalized.paths);
	return args;
}

function mutationQueuePath(cwd: string, paths: string[]) {
	return resolve(cwd, paths.length === 1 ? paths[0] : ".");
}

function buildPreviewArgsForChangedFiles(params: AstGrepParamsType, normalized: NormalizedAstGrepParams): string[] {
	const previewParams: AstGrepParamsType = {
		...params,
		updateAll: false,
		json: true,
		jsonStyle: "stream",
		format: undefined,
		reportStyle: undefined,
		includeMetadata: undefined,
	};
	return buildAstGrepArgs(previewParams, normalized);
}

function collectFilesFromJsonStream(output: string): string[] {
	const files = new Set<string>();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const record = JSON.parse(trimmed) as { file?: unknown; replacement?: unknown };
			if (typeof record.file === "string" && record.file.trim() && "replacement" in record) files.add(record.file);
		} catch {
			// Ignore malformed non-JSON lines. The real ast-grep invocation below will
			// still surface errors; this preflight is only for LSP changedFiles metadata.
		}
	}
	return [...files];
}

async function collectChangedFiles(
	pi: ExtensionAPI,
	params: AstGrepParamsType,
	normalized: NormalizedAstGrepParams,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const previewArgs = buildPreviewArgsForChangedFiles(params, normalized);
	const result = await pi.exec("ast-grep", previewArgs, { cwd, signal, timeout: 120_000 });
	const combined = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
	if ((result.code ?? 0) > 1) {
		throw new Error(`ast-grep changed-file preflight failed with exit code ${result.code}: ${combined.trim() || "no output"}`);
	}
	return collectFilesFromJsonStream(result.stdout);
}

function prepareAstGrepArguments(args: unknown): AstGrepParamsType {
	if (!args || typeof args !== "object") return args as AstGrepParamsType;
	const input = args as AstGrepParamsType & { path?: string; paths?: string[] | string };
	if (typeof input.paths === "string") {
		return { ...input, paths: [input.paths] };
	}
	if (typeof input.path === "string" && input.paths === undefined) {
		const { path, ...rest } = input;
		return { ...rest, paths: [path] };
	}
	return args as AstGrepParamsType;
}

async function executeAstGrep(
	pi: ExtensionAPI,
	params: AstGrepParamsType,
	signal: AbortSignal | undefined,
	ctx: { cwd: string },
	options: { allowUpdateAll: boolean } = { allowUpdateAll: false },
) {
	const normalized = validateParams(params, options);
	const args = buildAstGrepArgs(params, normalized);
	const mutated = Boolean(params.updateAll);
	const rewritePreview = Boolean(params.rewrite && !params.updateAll);
	let changedFiles: string[] | undefined;

	const runAstGrep = async () => {
		if (mutated) changedFiles = await collectChangedFiles(pi, params, normalized, ctx.cwd, signal);
		return pi.exec("ast-grep", args, { cwd: ctx.cwd, signal, timeout: 120_000 });
	};
	const result = mutated
		? await withFileMutationQueue(mutationQueuePath(ctx.cwd, normalized.paths), runAstGrep)
		: await runAstGrep();
	const combined = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");

	if (signal?.aborted || result.killed) {
		return {
			content: [{ type: "text" as const, text: "ast-grep cancelled" }],
			details: {
				command: ["ast-grep", ...args],
				mode: normalized.mode,
				cwd: ctx.cwd,
				pattern: params.pattern,
				paths: normalized.paths,
				lang: params.lang,
				rewritePreview,
				mutated,
				changedFiles,
				matchCount: 0,
				exitCode: result.code ?? -1,
				stderr: result.stderr || undefined,
			} satisfies AstGrepDetails,
		};
	}

	if ((result.code ?? 0) !== 0 && !combined.trim()) {
		return {
			content: [{ type: "text" as const, text: "No matches found" }],
			details: {
				command: ["ast-grep", ...args],
				mode: normalized.mode,
				cwd: ctx.cwd,
				pattern: params.pattern,
				paths: normalized.paths,
				lang: params.lang,
				rewritePreview,
				mutated,
				changedFiles,
				matchCount: 0,
				exitCode: result.code ?? 1,
			} satisfies AstGrepDetails,
		};
	}

	if ((result.code ?? 0) > 1) {
		throw new Error(`ast-grep failed with exit code ${result.code}: ${combined.trim() || "no output"}`);
	}

	const matchCount = countLikelyMatches(combined, params);
	const truncation = truncateHead(combined || "No matches found", {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let resultText = truncation.content;
	const details: AstGrepDetails = {
		command: ["ast-grep", ...args],
		mode: normalized.mode,
		cwd: ctx.cwd,
		pattern: params.pattern,
		paths: normalized.paths,
		lang: params.lang,
		rewritePreview,
		mutated,
		changedFiles,
		matchCount,
		exitCode: result.code ?? 0,
		stderr: result.stderr || undefined,
	};

	if (truncation.truncated) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-ast-grep-"));
		const tempFile = join(tempDir, "output.txt");
		await withFileMutationQueue(tempFile, async () => {
			await writeFile(tempFile, combined, "utf8");
		});

		details.truncation = truncation;
		details.fullOutputPath = tempFile;

		resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		resultText += ` Full output saved to: ${tempFile}]`;
	}

	if (mutated) {
		const changedCount = changedFiles?.length ?? 0;
		resultText += `\n\n[Changes were applied with ast-grep --update-all${changedCount ? ` to ${changedCount} file${changedCount === 1 ? "" : "s"}` : ""}.]`;
	} else if (rewritePreview) {
		resultText += "\n\n[Rewrite preview only: no files were modified.]";
	}

	return {
		content: [{ type: "text" as const, text: resultText }],
		details,
	};
}

export function registerAstGrepTool(pi: ExtensionAPI) {
	const toolDescriptions = astGrepToolDescriptions(DEFAULT_MAX_LINES, formatSize(DEFAULT_MAX_BYTES));

	pi.registerTool({
		...toolDescriptions.astGrep,
		parameters: AstGrepParams,
		prepareArguments: prepareAstGrepArguments,

		async execute(_toolCallId, params: AstGrepParamsType, signal, _onUpdate, ctx) {
			return executeAstGrep(pi, params, signal, ctx);
		},

		renderCall: renderAstGrepCall,
		renderResult: renderAstGrepResult,
	});

	pi.registerTool({
		...toolDescriptions.astApply,
		parameters: AstApplyParams,
		prepareArguments: prepareAstGrepArguments,

		async execute(_toolCallId, params: AstGrepParamsType, signal, _onUpdate, ctx) {
			return executeAstGrep(pi, { ...params, updateAll: true }, signal, ctx, { allowUpdateAll: true });
		},

		renderCall: renderAstApplyCall,
		renderResult: renderAstGrepResult,
	});
}
