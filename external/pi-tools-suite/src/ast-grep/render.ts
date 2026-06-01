import { Text } from "@earendil-works/pi-tui";
import type { AstGrepDetails, AstGrepParamsType } from "./types";
import { shellQuoteForDisplay } from "./utils";

type RenderTheme = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

type AstGrepRenderResult = {
	content: unknown[];
	details?: unknown;
};

type RenderResultOptions = {
	expanded?: boolean;
	isPartial?: boolean;
};

function renderAstGrepCallWithName(args: Partial<AstGrepParamsType>, theme: RenderTheme, toolName: string) {
	let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
	text += theme.fg("accent", args.command === "scan" ? "scan" : JSON.stringify(args.pattern ?? ""));
	if (args.lang) text += theme.fg("muted", ` --lang ${args.lang}`);
	if (args.updateAll) text += theme.fg("warning", " update-all");
	else if (args.rewrite) text += theme.fg("warning", " rewrite-preview");
	const paths = Array.isArray(args.paths) ? args.paths : [];
	if (paths.length > 0) text += theme.fg("dim", ` in ${paths.join(", ")}`);
	return new Text(text, 0, 0);
}

export function renderAstGrepCall(args: Partial<AstGrepParamsType>, theme: RenderTheme) {
	return renderAstGrepCallWithName(args, theme, "ast_grep");
}

export function renderAstApplyCall(args: Partial<AstGrepParamsType>, theme: RenderTheme) {
	return renderAstGrepCallWithName({ ...args, updateAll: true }, theme, "ast_apply");
}

export function renderAstGrepResult(
	result: AstGrepRenderResult,
	{ expanded, isPartial }: RenderResultOptions,
	theme: RenderTheme,
) {
	const details = result.details as AstGrepDetails | undefined;
	if (isPartial) return new Text(theme.fg("warning", "Searching AST..."), 0, 0);
	if (!details) return new Text(theme.fg("dim", "ast-grep finished"), 0, 0);

	let text = details.matchCount === 0
		? theme.fg("dim", "No matches")
		: theme.fg("success", `${details.matchCount} match${details.matchCount === 1 ? "" : "es"}`);
	if (details.mutated) text += theme.fg("warning", " (applied)");
	if (details.changedFiles?.length) {
		text += theme.fg("dim", ` ${details.changedFiles.length} file${details.changedFiles.length === 1 ? "" : "s"}`);
	}
	if (details.rewritePreview) text += theme.fg("warning", " (rewrite preview)");
	if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");
	if (details.fullOutputPath) text += theme.fg("dim", ` full: ${details.fullOutputPath}`);

	if (expanded) {
		text += `\n${theme.fg("dim", shellQuoteForDisplay(details.command))}`;
		const content = result.content[0] as { type?: unknown; text?: unknown } | undefined;
		if (content?.type === "text" && typeof content.text === "string" && content.text.trim()) {
			for (const line of content.text.split("\n").slice(0, 30)) {
				text += `\n${theme.fg("dim", line)}`;
			}
		}
	}

	return new Text(text, 0, 0);
}
