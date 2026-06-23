import { renderApplyPatchTool } from "./apply-patch.js";
import { renderAstTool } from "./ast.js";
import { renderCompressTool } from "./compress.js";
import { renderQuestionTool } from "./question.js";
import { renderReadTool } from "./read.js";
import { renderRepoTool } from "./repo.js";
import { renderSearchTool } from "./search.js";
import { renderShellTool } from "./shell.js";
import { applySkillReadDisplay } from "./skill.js";
import { renderSubagentsTool } from "./subagents.js";
import { renderTodoTool } from "./todo.js";
import type { ToolRenderInput, ToolRenderResult, ToolRendererMiddleware } from "./types.js";
import { defaultToolRender, normalizeToolName } from "./utils.js";
import { renderWebFetchTool, renderWebSearchTool } from "./web.js";
import { renderWriteTool } from "./write.js";

const TOOL_RENDERERS: Record<string, ToolRendererMiddleware> = {
	bash: renderShellTool,
	Bash: renderShellTool,
	shell: renderShellTool,
	shell_command: renderShellTool,
	read: renderReadTool,
	Read: renderReadTool,
	apply_patch: renderApplyPatchTool,
	edit: renderApplyPatchTool,
	Edit: renderApplyPatchTool,
	write: renderWriteTool,
	Write: renderWriteTool,
	ast_grep: renderAstTool,
	ast_apply: renderAstTool,
	grep: renderSearchTool,
	Grep: renderSearchTool,
	rg: renderSearchTool,
	Glob: renderSearchTool,
	glob: renderSearchTool,
	find: renderSearchTool,
	Find: renderSearchTool,
	web_search: renderWebSearchTool,
	web_fetch: renderWebFetchTool,
	todo: renderTodoTool,
	question: renderQuestionTool,
	subagents: renderSubagentsTool,
	compress: renderCompressTool,
};

const PREFIX_RENDERERS: readonly [prefix: string, renderer: ToolRendererMiddleware][] = [
	["repo_", renderRepoTool],
	["ast_", renderAstTool],
];

export function renderToolDisplay(input: ToolRenderInput): ToolRenderResult {
	const normalizedName = normalizeToolName(input.toolName);
	const exact = TOOL_RENDERERS[input.toolName] ?? TOOL_RENDERERS[normalizedName];
	const rendered = exact?.(input) ?? PREFIX_RENDERERS.find(([prefix]) => normalizedName.startsWith(prefix))?.[1](input);
	return applySkillReadDisplay(input, rendered ?? defaultToolRender(input));
}

export type { ToolRenderInput, ToolRenderResult } from "./types.js";
