import type { Theme } from "../theme.js";
import type { ToolBodySyntaxHighlights } from "../syntax-highlight.js";

export type ToolBodyLineStyle = {
	startLine: number;
	endLine?: number;
	foreground?: string;
	color?: keyof Theme["colors"];
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
};

export type ToolRenderInput = {
	toolName: string;
	argsText: string;
	output: string;
	details?: unknown;
	isError: boolean;
	status: "running" | "done";
	cwd?: string;
	colors?: Theme["colors"];
	toolColor?: string;
};

export type ToolRenderResult = {
	toolName?: string;
	headerArgs?: string;
	bodyLineStyles?: readonly ToolBodyLineStyle[];
	bodyStyle?: "diff";
	preserveAnsi?: boolean;
	syntaxHighlight?: ToolBodySyntaxHighlights | undefined;
	collapsedBody: string;
	expandedText: string;
};

export type ToolRendererMiddleware = (input: ToolRenderInput) => ToolRenderResult | undefined;
