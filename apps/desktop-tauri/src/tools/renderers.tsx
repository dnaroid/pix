/**
 * Per-tool React renderers for the tool-call cards.
 *
 * Each renderer mirrors the logic of the corresponding terminal renderer in
 * src/tool-renderers/*.ts but emits React nodes instead of styled ANSI text.
 * The shared ToolCard in App.tsx still owns the header (chevron + name +
 * status); renderers below provide:
 *   - summarize(props): short string shown in the header next to the name
 *   - render(props):   expanded body content
 */

import { FolderOpen, FileText, FilePlus2, FileEdit, ListChecks, Search, Link as LinkIcon } from "lucide-react";
import type { ToolRenderer } from "./types";
import {
  CodeBlock,
  DiffBlock,
  Section,
  compactCommand,
  isGitDiffCommand,
  numberArg,
  pathForDisplay,
  resultText,
  stringArg,
  summarizePatch,
  truncate,
} from "./common";

// -- Shell / Bash ---------------------------------------------------------

export const shellTool: ToolRenderer = {
  id: "shell",
  summarize: ({ args }) =>
    compactCommand(stringArg(args, ["command", "cmd", "script"])) ?? "",
  render: ({ args, result, status, isError }) => {
    const command = compactCommand(stringArg(args, ["command", "cmd", "script"])) ?? "(no command)";
    const out = shellOutputText(result) ?? (typeof result === "string" ? result : resultText(result, status));
    const isDiff = isGitDiffCommand(command) && out.length > 0;
    return (
      <>
        <Section label="command">
          <CodeBlock>{`$ ${command}`}</CodeBlock>
        </Section>
        {out && (
          <Section label={isError ? "error" : "output"}>
            {isDiff ? <DiffBlock>{out}</DiffBlock> : <CodeBlock>{out}</CodeBlock>}
          </Section>
        )}
        {!out && status !== "running" && (
          <div className="tool__empty">(no output)</div>
        )}
      </>
    );
  },
};

function shellOutputText(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const code = typeof record.code === "number" ? record.code : null;
  const timedOut = record.timed_out === true;
  const pieces = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
  const suffix = timedOut
    ? "\n[timeout after 60s]"
    : code !== null && code !== 0
      ? `\n[exit ${code}]`
      : "";
  return `${pieces}${suffix}`.trimEnd();
}

// -- Read -----------------------------------------------------------------

export const readTool: ToolRenderer = {
  id: "read",
  summarize: ({ args, cwd }) => {
    const filePath = stringArg(args, ["path", "file", "target"]);
    if (!filePath) return "";
    const display = pathForDisplay(filePath, cwd);
    const offset = numberArg(args, ["offset"]);
    const limit = numberArg(args, ["limit"]);
    const range =
      offset != null ? `:${offset}${limit != null ? `+${limit}` : ""}` : "";
    return `${display}${range}`;
  },
  render: ({ args, result, status, isError, cwd }) => {
    const filePath = stringArg(args, ["path", "file", "target"]);
    const display = filePath ? pathForDisplay(filePath, cwd) : "(unknown path)";
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        <Section label="path">
          <div className="tool__path">
            <FileText size={12} />
            <code>{display}</code>
          </div>
        </Section>
        {out && (
          <Section label={isError ? "error" : "content"}>
            <CodeBlock language={languageForPath(filePath)}>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

// -- Write ----------------------------------------------------------------

export const writeTool: ToolRenderer = {
  id: "write",
  summarize: ({ args, cwd }) => {
    const filePath = stringArg(args, ["path", "file_path", "filePath"]);
    return filePath ? pathForDisplay(filePath, cwd) : "";
  },
  render: ({ args, result, status, isError, cwd }) => {
    const filePath = stringArg(args, ["path", "file_path", "filePath"]);
    const display = filePath ? pathForDisplay(filePath, cwd) : "(unknown path)";
    const content = stringArg(args, ["content", "text"]);
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        <Section label="path">
          <div className="tool__path">
            <FilePlus2 size={12} />
            <code>{display}</code>
          </div>
        </Section>
        {content !== undefined && (
          <Section label="content">
            <CodeBlock language={languageForPath(filePath)}>{content || "(empty)"}</CodeBlock>
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

// -- Apply patch / Edit ---------------------------------------------------

export const applyPatchTool: ToolRenderer = {
  id: "apply_patch",
  summarize: ({ args, cwd }) => {
    const path = stringArg(args, ["path", "file_path", "filePath"]);
    const displayPath = path ? pathForDisplay(path, cwd) : undefined;
    const patch = stringArg(args, ["input", "patch"]);
    const summary = summarizePatch(patch) ?? "patch";
    return summary === "patch" && displayPath ? displayPath : summary;
  },
  render: ({ args, result, status, isError, cwd }) => {
    const patch = stringArg(args, ["input", "patch"]);
    const path = stringArg(args, ["path", "file_path", "filePath"]);
    const displayPath = path ? pathForDisplay(path, cwd) : undefined;
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        {displayPath && (
          <Section label="path">
            <div className="tool__path">
              <FileEdit size={12} />
              <code>{displayPath}</code>
            </div>
          </Section>
        )}
        {patch && (
          <Section label="patch">
            <DiffBlock>{patch}</DiffBlock>
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

// -- Todo -----------------------------------------------------------------

export const todoTool: ToolRenderer = {
  id: "todo",
  summarize: ({ args }) => {
    const action = stringArg(args, ["action"]);
    const subject = stringArg(args, ["subject"]);
    return [action, subject].filter(Boolean).join(" · ");
  },
  render: ({ args, result, status, isError }) => {
    const action = stringArg(args, ["action"]);
    const subject = stringArg(args, ["subject"]);
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        {(action || subject) && (
          <Section label="task">
            <div className="tool__path">
              <ListChecks size={12} />
              <code>{[action, subject].filter(Boolean).join(" · ")}</code>
            </div>
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

// -- Web search / fetch ---------------------------------------------------

export const webSearchTool: ToolRenderer = {
  id: "web_search",
  summarize: ({ args }) => stringArg(args, ["query"]) ?? "",
  render: ({ args, result, status, isError }) => {
    const query = stringArg(args, ["query"]);
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        {query && (
          <Section label="query">
            <div className="tool__path">
              <Search size={12} />
              <code>{truncate(query, 200)}</code>
            </div>
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

export const webFetchTool: ToolRenderer = {
  id: "web_fetch",
  summarize: ({ args }) => stringArg(args, ["url"]) ?? "",
  render: ({ args, result, status, isError }) => {
    const url = stringArg(args, ["url"]);
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        {url && (
          <Section label="url">
            <div className="tool__path">
              <LinkIcon size={12} />
              <code>{truncate(url, 200)}</code>
            </div>
          </Section>
        )}
        {out && (
          <Section label={isError ? "error" : "content"}>
            <CodeBlock>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

// -- Folder open (placeholder for filesystem ops) -------------------------

export const folderTool: ToolRenderer = {
  id: "folder",
  summarize: ({ args, cwd }) => {
    const path = stringArg(args, ["path", "directory"]);
    return path ? pathForDisplay(path, cwd) : "";
  },
  render: ({ args, result, status, isError, cwd }) => {
    const path = stringArg(args, ["path", "directory"]);
    const display = path ? pathForDisplay(path, cwd) : "(no path)";
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        <Section label="path">
          <div className="tool__path">
            <FolderOpen size={12} />
            <code>{display}</code>
          </div>
        </Section>
        {out && (
          <Section label={isError ? "error" : "result"}>
            <CodeBlock>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

// -- Helpers --------------------------------------------------------------

function languageForPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const ext = path.split(".").pop();
  if (!ext || ext === path) return undefined;
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    mjs: "javascript",
    jsx: "javascript",
    json: "json",
    jsonc: "json",
    md: "markdown",
    rs: "rust",
    go: "go",
    py: "python",
    sh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    css: "css",
    html: "html",
  };
  return map[ext.toLowerCase()];
}
