/**
 * Tool renderer registry.
 *
 * Exposes:
 *   - lookup(name):     find a renderer for a given tool name (exact match
 *                       first, then prefix match like "repo_*" / "ast_*")
 *   - defaultRenderer:  fallback used when no specific renderer applies
 *   - summarize/render: convenience helpers that always produce output
 *
 * Tool names from the SDK can be cased differently per provider
 * (e.g. "Bash" vs "bash"). We normalize to lowercase for lookup.
 */

import type { ToolRenderProps, ToolRenderer } from "./types";
import { CodeBlock, Section, formatHeaderArgs, resultText } from "./common";
import {
  astApplyTool,
  astGrepTool,
  compressTool,
  applyPatchTool,
  folderTool,
  questionTool,
  readTool,
  repoTool,
  shellTool,
  skillTool,
  subagentsTool,
  todoTool,
  webFetchTool,
  webSearchTool,
  writeTool,
} from "./renderers";

const EXACT: Record<string, ToolRenderer> = {
  // shell family
  bash: shellTool,
  shell: shellTool,
  shell_command: shellTool,
  exec: shellTool,

  // file ops
  read: readTool,
  write: writeTool,
  apply_patch: applyPatchTool,
  edit: applyPatchTool,
  ls: folderTool,
  list: folderTool,
  glob: folderTool,
  find: folderTool,

  // planning
  todo: todoTool,
  question: questionTool,
  subagents: subagentsTool,
  compress: compressTool,
  skill: skillTool,

  // codebase discovery / structural edits
  ast_grep: astGrepTool,
  ast_apply: astApplyTool,
  repo_architecture: repoTool,
  repo_structure: repoTool,
  repo_ast: repoTool,
  repo_search: repoTool,
  repo_explain: repoTool,
  repo_deps: repoTool,

  // web
  web_search: webSearchTool,
  web_fetch: webFetchTool,
};

const PREFIX: Array<{ prefix: string; renderer: ToolRenderer }> = [
  { prefix: "repo_", renderer: repoTool },
  { prefix: "ast_", renderer: astGrepTool },
];

/** Normalize a tool name: last segment of dotted/dashed/slash, lowercase. */
function normalizeName(name: string): string {
  const last = name.split(/[.:/]/).filter(Boolean).at(-1) ?? name;
  return last.trim().toLowerCase();
}

export function lookup(name: string): ToolRenderer | undefined {
  const normalized = normalizeName(name);
  return (
    EXACT[normalized] ??
    EXACT[name.toLowerCase()] ??
    PREFIX.find(({ prefix }) => normalized.startsWith(prefix))?.renderer
  );
}

/** Fallback renderer: shows args + result as JSON, like the pre-Phase-3 view. */
export const defaultRenderer: ToolRenderer = {
  id: "default",
  summarize: ({ args }) => formatHeaderArgs(args),
  render: ({ args, result, status, isError }) => {
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        {args !== undefined && (
          <Section label="args">
            <CodeBlock>{prettyJson(args)}</CodeBlock>
          </Section>
        )}
        {out && (
          <Section label={isError ? "error" : "result"}>
            <CodeBlock>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

export function summarizeWithFallback(props: ToolRenderProps): string {
  const r = lookup(props.name) ?? defaultRenderer;
  return r.summarize(props);
}

export function renderWithFallback(props: ToolRenderProps): React.ReactNode {
  const r = lookup(props.name) ?? defaultRenderer;
  return r.render(props);
}

function prettyJson(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
