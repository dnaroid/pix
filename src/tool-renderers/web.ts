import type { ToolRendererMiddleware } from "./types.js";
import { renderWithArgsAndResult, stringArg } from "./utils.js";

export const renderWebSearchTool: ToolRendererMiddleware = (input) => {
	const query = stringArg(input, ["query"]);
	return renderWithArgsAndResult(input, { headerArgs: query, collapsedBody: input.output });
};

export const renderWebFetchTool: ToolRendererMiddleware = (input) => {
	const url = stringArg(input, ["url"]);
	return renderWithArgsAndResult(input, { headerArgs: url, collapsedBody: input.output });
};
