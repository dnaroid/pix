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
 * unnecessary so the agent removes them on its next turn.
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
	return [{ filePath, removedLines: [], addedLines: splitLines(content) }];
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
			edits.push({ filePath: op.path, removedLines: [], addedLines: op.lines });
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
	if (typeof details !== "object" || details === null) return [];
	const record = details as Record<string, unknown>;
	const changedFiles = Array.isArray(record.changedFiles) ? record.changedFiles : undefined;
	if (!changedFiles) return [];
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

const REASON_LABELS: Record<string, string> = {
	"restate-code": "restates what the code already says",
	filler: "is filler phrasing",
	decorative: "is a decorative separator",
	"generic-explanation": "paraphrases surrounding code",
	"non-essential-comment": "looks unnecessary",
};

function formatNudge(findings: CommentFinding[]): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("---");
	lines.push("💬 comment-checker: the following code comments look unnecessary.");
	lines.push("Re-read each one. If it does not add information beyond the code, remove it. Keep only comments that capture intent, contracts, non-obvious rationale, or TODO/FIXME tasks.");
	lines.push("");
	for (const finding of findings) {
		const label = REASON_LABELS[finding.reason] ?? finding.reason;
		lines.push(`- \`${finding.filePath}\` — ${finding.text}  (${label})`);
	}
	lines.push("");
	lines.push("If a flagged comment is genuinely valuable, keep it and ignore this notice.");
	lines.push("---");
	return lines.join("\n");
}

/** Shared mutable state (module-scoped, like lsp's global manager). */
let lastNudgeTimestamp = 0;

export function __resetCommentCheckerState(): void {
	lastNudgeTimestamp = 0;
}

export default function commentCheckerExtension(pi: ExtensionAPI): void {
	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return undefined;
		if (!isMutationTool(event.toolName)) return undefined;

		const options = loadOptions(ctx);
		if (!options.enabled) return undefined;

		const edits = extractEdits(event.toolName, event.input, event.details);
		if (edits.length === 0) return undefined;

		const findings = detectSlopComments(edits, options.strictness, MAX_FINDINGS);
		if (findings.length === 0) return undefined;

		// Per-session dedup: at most one nudge per DEDUP_WINDOW_MS.
		const now = Date.now();
		if (now - lastNudgeTimestamp < DEDUP_WINDOW_MS) return undefined;
		lastNudgeTimestamp = now;

		const nudge = formatNudge(findings);
		return {
			content: [...event.content, { type: "text" as const, text: nudge }],
		};
	});
}
