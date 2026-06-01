import { isAbsolute, relative, sep } from "node:path";
import { syntaxHighlightLanguageForPath } from "../syntax-highlight.js";
import type { ToolRendererMiddleware, ToolRenderInput, ToolRenderResult } from "./types.js";
import { argsRecord, expandedTextFromParts, lineCount, resultText, stringArg } from "./utils.js";

export const renderWriteTool: ToolRendererMiddleware = (input) => {
	const filePath = stringArg(input, ["path", "file_path", "filePath"]);
	if (!filePath) return undefined;

	const displayPath = pathForDisplay(filePath, input.cwd);
	const content = writeContent(input);
	const expanded = expandedTextFromParts(
		{ text: content !== undefined ? content || "(empty)" : "" },
		{ text: resultText(input, { empty: content === undefined }) },
	);
	const rendered: ToolRenderResult = {
		headerArgs: displayPath,
		collapsedBody: content ?? input.output,
		...expanded,
	};

	if (content === undefined) return rendered;

	const syntaxLanguage = !input.isError ? syntaxHighlightLanguageForPath(filePath) : undefined;
	if (!syntaxLanguage) return rendered;

	return {
		...rendered,
		syntaxHighlight: {
			language: syntaxLanguage,
			startLine: 0,
			endLine: lineCount(content || "(empty)"),
			startColumn: 0,
		},
	};
};

function writeContent(input: ToolRenderInput): string | undefined {
	const content = argsRecord(input)?.content;
	return typeof content === "string" ? content : undefined;
}

function pathForDisplay(filePath: string, cwd: string | undefined): string {
	if (!cwd || !isAbsolute(filePath)) return filePath;

	const relativePath = relative(cwd, filePath);
	if (!relativePath) return ".";
	return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) ? filePath : relativePath;
}
