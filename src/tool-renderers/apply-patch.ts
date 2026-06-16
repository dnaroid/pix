import { isAbsolute, relative, sep } from "node:path";
import { normalizeBeginPatchForDisplay } from "./patch-normalize.js";
import type { ToolRendererMiddleware } from "./types.js";
import { expandedTextFromParts, resultText, stringArg, summarizePatch } from "./utils.js";

type DiffDetails = {
	patch?: unknown;
	diff?: unknown;
};

export const renderApplyPatchTool: ToolRendererMiddleware = (input) => {
	const detailsDiff = diffFromDetails(input.details);
	const argPatch = stringArg(input, ["input", "patch"]);
	const rawPatch = argPatch ?? detailsDiff?.text;
	// Re-minimize loose `*** Begin Patch` hunks so unchanged neighbor lines are
	// rendered as context instead of spurious `-` deletions. Plain unified diffs
	// and other formats pass through unchanged.
	const patch = rawPatch ? normalizeBeginPatchForDisplay(rawPatch) : rawPatch;
	const path = pathForDisplay(stringArg(input, ["path", "file_path", "filePath"]), input.cwd);
	const summary = summarizePatch(patch) ?? "patch";
	const expanded = expandedTextFromParts({ text: patch }, { text: resultText(input, { empty: !patch }) });

	return {
		headerArgs: summary === "patch" && path ? path : summary,
		bodyStyle: "diff",
		collapsedBody: patch || input.output || summary,
		...expanded,
	};
};

function diffFromDetails(details: unknown): { text: string } | undefined {
	if (!isDiffDetails(details)) return undefined;
	if (typeof details.diff === "string" && details.diff.trim()) return { text: details.diff.trim() };
	if (typeof details.patch === "string" && details.patch.trim()) return { text: details.patch.trim() };
	return undefined;
}

function isDiffDetails(value: unknown): value is DiffDetails {
	return typeof value === "object" && value !== null;
}

function pathForDisplay(filePath: string | undefined, cwd: string | undefined): string | undefined {
	if (!filePath || !cwd || !isAbsolute(filePath)) return filePath;

	const relativePath = relative(cwd, filePath);
	if (!relativePath) return ".";
	return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) ? filePath : relativePath.replace(/\\/gu, "/");
}
