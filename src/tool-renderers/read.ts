import { isAbsolute, relative, sep } from "node:path";
import { syntaxHighlightLanguageForPath } from "../syntax-highlight.js";
import type { ToolRendererMiddleware } from "./types.js";
import { numberArg, stringArg } from "./utils.js";

export const renderReadTool: ToolRendererMiddleware = (input) => {
	const filePath = stringArg(input, ["path", "file_path", "filePath", "file", "target"]);
	if (!filePath) return undefined;

	const displayPath = pathForDisplay(filePath, input.cwd);

	const offset = numberArg(input, ["offset"]);
	const limit = numberArg(input, ["limit"]);
	const range = offset != null ? `:${offset}${limit != null ? `+${limit}` : ""}` : "";
	const rendered = {
		headerArgs: `${displayPath}${range}`,
		collapsedBody: input.output,
		expandedText: input.output || (input.status === "running" ? "running…" : "(empty)"),
	};
	const syntaxLanguage = !input.isError && input.output ? syntaxHighlightLanguageForPath(filePath) : undefined;
	if (!syntaxLanguage) return rendered;

	return {
		...rendered,
		syntaxHighlight: {
			language: syntaxLanguage,
			startLine: 0,
			startColumn: 0,
		},
	};
};

function pathForDisplay(filePath: string, cwd: string | undefined): string {
	if (!cwd || !isAbsolute(filePath)) return filePath;

	const relativePath = relative(cwd, filePath);
	if (!relativePath) return ".";
	return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) ? filePath : relativePath.replace(/\\/gu, "/");
}
