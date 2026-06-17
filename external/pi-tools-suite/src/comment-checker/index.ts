import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseApplyPatch } from "../model-tools/apply-patch.js";
import { detectSlopComments, type CommentFinding, type Edit, type Strictness } from "./detect.js";
import { loadCommentCheckerConfig } from "./config.js";

type ExtensionContext = import("@earendil-works/pi-coding-agent").ExtensionContext;

/**
 * comment-checker: AI-slop comment guard.
 *
 * Listens to the pi "tool_result" event for write/edit/apply_patch/ast_apply
 * mutation tools, extracts the net-new comment lines the agent just added,
 * classifies them, and appends a nudge to the tool result when they look
 * unnecessary so the agent removes them on their next turn.
 *
 * Adapted from oh-my-opencode's comment-checker hook, but pure-TypeScript and
 * headless (no external binary, no pending-calls machinery: pi's tool_result
 * event already carries both the input and the result in one call).
 *
 * Per-session deduplication mirrors oh-my-opencode: at most one nudge per
 * session within DEDUP_WINDOW_MS, to prevent a fix/remark loop.
 */

const DEDUP_WINDOW_MS = 30_000;
const MAX_FINDINGS = 8;

const MUTATION_TOOL_NAMES = new Set(["write", "edit", "apply_patch", "ast_apply", "multiedit"]);

interface CommentCheckerOptions {
	strictness: Strictness;
	enabled: boolean;
}

function loadOptions(ctx: ExtensionContext): CommentCheckerOptions {
	const config = loadCommentCheckerConfig(ctx.cwd);
	return { strictness: config.strictness, enabled: config.enabled };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.filter((item): item is string => typeof item === "string");
	return out.length > 0 ? out : undefined;
}

function splitLines(text: string | undefined): readonly string[] {
	if (text === undefined) return [];
	return text.split(/\r?\n/);
}

function editsFromWrite(input: Record<string, unknown>): Edit[] {
	const filePath = asString(input.file_path) ?? asString(input.path);
	const content = asString(input.content);
	if (!filePath || content === undefined) return [];
	// Full-file write: the added lines start at line 1 of the new file.
	return [{ filePath, removedLines: [], addedLines: splitLines(content), baseLineNumber: 1 }];
}

function editsFromEdit(input: Record<string, unknown>): Edit[] {
	const filePath = asString(input.file_path) ?? asString(input.path);
	if (!filePath) return [];

	// Claude/GLM alias shape: { old_string, new_string }.
	const oldString = asString(input.old_string) ?? asString(input.oldString);
	const newString = asString(input.new_string) ?? asString(input.newString);
	if (oldString !== undefined || newString !== undefined) {
		return [{ filePath, removedLines: splitLines(oldString), addedLines: splitLines(newString) }];
	}

	// Pi builtin edit shape: { edits: [{ oldText, newText }] }.
	const editsArray = asStringArray(input.edits) ?? input.edits;
	if (Array.isArray(editsArray)) {
		const removed: string[] = [];
		const added: string[] = [];
		for (const item of editsArray) {
			if (item && typeof item === "object") {
				const rec = item as Record<string, unknown>;
				const o = asString(rec.oldText) ?? asString(rec.old_string);
				const n = asString(rec.newText) ?? asString(rec.new_string);
				removed.push(...splitLines(o));
				added.push(...splitLines(n));
			}
		}
		if (added.length > 0 || removed.length > 0) {
			return [{ filePath, removedLines: removed, addedLines: added }];
		}
	}

	return [];
}

function editsFromApplyPatch(input: Record<string, unknown>): Edit[] {
	const patch = asString(input.input) ?? asString(input.patch) ?? asString(input.command);
	if (!patch) return [];

	let operations: ReturnType<typeof parseApplyPatch> = [];
	try {
		operations = parseApplyPatch(patch);
	} catch {
		return [];
	}

	const edits: Edit[] = [];
	for (const op of operations) {
		if (op.kind === "delete") continue;
		if (op.kind === "add") {
			// Add File creates a new file; added lines start at line 1.
			edits.push({ filePath: op.path, removedLines: [], addedLines: op.lines, baseLineNumber: 1 });
			continue;
		}
		// update: reconstruct added/removed lines from hunks.
		const removed: string[] = [];
		const added: string[] = [];
		for (const hunk of op.hunks) {
			for (const line of hunk.lines) {
				if (line.kind === "remove") removed.push(line.text);
				else if (line.kind === "add") added.push(line.text);
			}
		}
		if (added.length > 0 || removed.length > 0) {
			edits.push({ filePath: op.moveTo ?? op.path, removedLines: removed, addedLines: added });
		}
	}
	return edits;
}

function editsFromAstApply(details: unknown): Edit[] {
	void details;
	// ast_apply does not expose per-file diffs cheaply in details; the caller
	// would have to re-read. Skip diffing here and rely on write/edit/apply_patch.
	return [];
}

function extractEdits(toolName: string, input: Record<string, unknown>, details: unknown): Edit[] {
	const base = toolName.includes(".") ? toolName.split(".").pop() ?? toolName : toolName;
	const lower = base.toLowerCase();

	if (lower === "write") return editsFromWrite(input);
	if (lower === "edit" || lower === "multiedit") return editsFromEdit(input);
	if (lower === "apply_patch") return editsFromApplyPatch(input);
	if (lower === "ast_apply") return editsFromAstApply(details);
	return [];
}

function isMutationTool(toolName: string): boolean {
	const base = toolName.includes(".") ? toolName.split(".").pop() ?? toolName : toolName;
	return MUTATION_TOOL_NAMES.has(base.toLowerCase());
}

/**
 * Resolve absolute line numbers for edits that do not already know them
 * (edit / apply_patch update hunks) by reading the already-written file and
 * locating the start of the added block. write / Add File already carry
 * baseLineNumber=1 and are skipped.
 */
async function resolveBaseLineNumbers(edits: readonly Edit[]): Promise<void> {
	for (const edit of edits) {
		if (edit.baseLineNumber !== undefined) continue;
		if (edit.addedLines.length === 0) continue;
		edit.baseLineNumber = await findBlockStartLine(edit.filePath, edit.addedLines);
	}
}

/**
 * Find the 1-based line number where `addedLines` begins in the target file.
 * Matches the leading non-empty lines of `addedLines` against the file; returns
 * undefined if the file cannot be read or the block is not found.
 */
async function findBlockStartLine(filePath: string, addedLines: readonly string[]): Promise<number | undefined> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
	const fileLines = raw.split(/\r?\n/);

	// Anchor: up to 3 leading non-empty added lines.
	const anchor: string[] = [];
	for (const line of addedLines) {
		if (line.trim().length === 0) {
			if (anchor.length === 0) continue;
			break;
		}
		anchor.push(line);
		if (anchor.length >= 3) break;
	}
	if (anchor.length === 0) return undefined;

	for (let i = 0; i + anchor.length <= fileLines.length; i++) {
		let match = true;
		for (let j = 0; j < anchor.length; j++) {
			if (fileLines[i + j] !== anchor[j]) {
				match = false;
				break;
			}
		}
		if (match) return i + 1;
	}
	return undefined;
}

const REASON_TAGS: Record<string, string> = {
	"restate-code": "restate",
	filler: "filler",
	decorative: "decorative",
	"generic-explanation": "generic",
	"non-essential-comment": "slop",
};

/** Render a display path: relative when inside cwd, otherwise the raw path. */
function displayPath(filePath: string, cwd: string): string {
	if (isAbsolute(filePath)) {
		const rel = relative(cwd, filePath);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	}
	return filePath;
}

function formatNudge(findings: CommentFinding[], cwd: string): string {
	// Group by display path, preserving first-seen order.
	const groups = new Map<string, CommentFinding[]>();
	const order: string[] = [];
	for (const finding of findings) {
		const key = displayPath(finding.filePath, cwd);
		const bucket = groups.get(key);
		if (bucket) bucket.push(finding);
		else {
			groups.set(key, [finding]);
			order.push(key);
		}
	}

	// Compact: one line per file. Each finding is `line:tag` (no comment text —
	// the file already contains it, and the path+line locate it exactly). This
	// keeps the nudge token-light while preserving location + failure category.
	const out: string[] = [];
	out.push("");
	out.push("---");
	out.push("💬 comment-checker — unnecessary comments at the lines below (line:reason). Remove any that only restate code / are filler; keep intent, contracts, rationale, TODO.");
	out.push("");
	for (const key of order) {
		const entries = (groups.get(key) ?? []).map((finding) => {
			const tag = REASON_TAGS[finding.reason] ?? finding.reason;
			return finding.line !== undefined ? `${finding.line}:${tag}` : `?:${tag}`;
		});
		out.push(`${key}  ${entries.join(" ")}`);
	}
	out.push("");
	out.push("---");
	return out.join("\n");
}

/** Shared mutable state (module-scoped, like lsp's global manager). */
let lastNudgeTimestamp = 0;

export function __resetCommentCheckerState(): void {
	lastNudgeTimestamp = 0;
}

export default function commentCheckerExtension(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;
		if (!isMutationTool(event.toolName)) return undefined;

		const options = loadOptions(ctx);
		if (!options.enabled) return undefined;

		const edits = extractEdits(event.toolName, event.input, event.details);
		if (edits.length === 0) return undefined;

		// Resolve absolute line numbers for edit/apply_patch by reading the file
		// the tool just wrote. Failures are non-fatal: findings just lack a line.
		await resolveBaseLineNumbers(edits);

		const findings = detectSlopComments(edits, options.strictness, MAX_FINDINGS);
		if (findings.length === 0) return undefined;

		// Per-session dedup: at most one nudge per DEDUP_WINDOW_MS.
		const now = Date.now();
		if (now - lastNudgeTimestamp < DEDUP_WINDOW_MS) return undefined;
		lastNudgeTimestamp = now;

		const nudge = formatNudge(findings, ctx.cwd);
		return {
			content: [...event.content, { type: "text" as const, text: nudge }],
		};
	});
}
