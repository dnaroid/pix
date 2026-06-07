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

import {
  Archive,
  Database,
  FileCode2,
  FileEdit,
  FilePlus2,
  FileText,
  FolderOpen,
  Link as LinkIcon,
  ListChecks,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ToolRenderer } from "./types";
import {
  CodeBlock,
  DiffBlock,
  Section,
  argsRecord,
  compactCommand,
  formatHeaderArgs,
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

// -- Codebase discovery / AST tools --------------------------------------

export const repoTool: ToolRenderer = {
  id: "repo",
  summarize: ({ args, cwd }) => {
    const target = stringArg(args, ["target", "path"]);
    const displayTarget = target ? pathForDisplay(target, cwd) : undefined;
    return displayTarget ?? formatHeaderArgs(args, ["target", "args"]);
  },
  render: ({ args, result, status, isError, name, cwd }) => {
    const target = stringArg(args, ["target", "path"]);
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        <ToolMeta icon={<Database size={12} />} label={name} value={target ? pathForDisplay(target, cwd) : undefined} />
        <ArgsSection args={args} preferredKeys={["target", "args", "maxLines", "maxBytes"]} />
        {out && (
          <Section label={isError ? "error" : "result"}>
            <CodeBlock>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

export const astGrepTool: ToolRenderer = {
  id: "ast_grep",
  summarize: ({ args }) => {
    const pattern = stringArg(args, ["pattern"]);
    const command = stringArg(args, ["command"]);
    return [command, pattern].filter(Boolean).join(" · ") || formatHeaderArgs(args, ["pattern", "paths"]);
  },
  render: ({ args, result, status, isError }) => {
    const pattern = stringArg(args, ["pattern"]);
    const rewrite = stringArg(args, ["rewrite"]);
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        <ToolMeta icon={<FileCode2 size={12} />} label="ast-grep" value={pattern} />
        {pattern && (
          <Section label="pattern">
            <CodeBlock>{pattern}</CodeBlock>
          </Section>
        )}
        {rewrite && (
          <Section label="rewrite preview">
            <CodeBlock>{rewrite}</CodeBlock>
          </Section>
        )}
        <ArgsSection args={args} preferredKeys={["command", "paths", "lang", "selector", "strictness"]} />
        {out && (
          <Section label={isError ? "error" : "matches"}>
            <CodeBlock>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

export const astApplyTool: ToolRenderer = {
  id: "ast_apply",
  summarize: ({ args }) => {
    const pattern = stringArg(args, ["pattern"]);
    const command = stringArg(args, ["command"]);
    return [command ?? "apply", pattern].filter(Boolean).join(" · ");
  },
  render: ({ args, result, status, isError }) => {
    const pattern = stringArg(args, ["pattern"]);
    const rewrite = stringArg(args, ["rewrite"]);
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        <ToolMeta icon={<FileEdit size={12} />} label="ast apply" value={pattern} />
        {pattern && (
          <Section label="pattern">
            <CodeBlock>{pattern}</CodeBlock>
          </Section>
        )}
        {rewrite && (
          <Section label="rewrite">
            <CodeBlock>{rewrite}</CodeBlock>
          </Section>
        )}
        <ArgsSection args={args} preferredKeys={["command", "paths", "lang", "selector", "strictness"]} />
        {out && (
          <Section label={isError ? "error" : "changed files"}>
            <CodeBlock>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

// -- Interactive / orchestration tools -----------------------------------

export const questionTool: ToolRenderer = {
  id: "question",
  summarize: ({ args }) => {
    const questions = argsRecord(args)?.questions;
    if (Array.isArray(questions)) return `${questions.length} question${questions.length === 1 ? "" : "s"}`;
    return formatHeaderArgs(args, ["questions"]);
  },
  render: ({ args, result, status, isError }) => {
    const questions = argsRecord(args)?.questions;
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        {Array.isArray(questions) ? (
          <Section label="questions">
            <CodeBlock>{formatQuestions(questions)}</CodeBlock>
          </Section>
        ) : (
          <ArgsSection args={args} preferredKeys={["questions"]} />
        )}
        {out && (
          <Section label={isError ? "error" : "answer"}>
            <CodeBlock>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

export const subagentsTool: ToolRenderer = {
  id: "subagents",
  summarize: ({ args }) => {
    const action = stringArg(args, ["action"]);
    const tasks = argsRecord(args)?.tasks;
    const count = Array.isArray(tasks) ? ` · ${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "";
    return `${action ?? "subagents"}${count}`;
  },
  render: ({ args, result, status, isError }) => {
    const action = stringArg(args, ["action"]);
    const tasks = argsRecord(args)?.tasks;
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        <ToolMeta icon={<Users size={12} />} label="subagents" value={action} />
        {Array.isArray(tasks) && (
          <Section label="tasks">
            <CodeBlock>{formatSubagentTasks(tasks)}</CodeBlock>
          </Section>
        )}
        <ArgsSection args={args} preferredKeys={["action", "agentIds", "agentId", "runDir", "timeout"]} />
        {out && (
          <Section label={isError ? "error" : "result"}>
            <CodeBlock>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

export const compressTool: ToolRenderer = {
  id: "compress",
  summarize: ({ args }) => {
    const topic = stringArg(args, ["topic"]);
    const record = argsRecord(args);
    const ranges = Array.isArray(record?.ranges) ? record.ranges.length : 0;
    const messages = Array.isArray(record?.messages) ? record.messages.length : 0;
    const units = [ranges ? `${ranges} range${ranges === 1 ? "" : "s"}` : "", messages ? `${messages} message${messages === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    return [topic, units].filter(Boolean).join(" · ");
  },
  render: ({ args, result, status, isError }) => {
    const topic = stringArg(args, ["topic"]);
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        <ToolMeta icon={<Archive size={12} />} label="context" value={topic} />
        <ArgsSection args={args} preferredKeys={["topic", "ranges", "messages"]} />
        {out && (
          <Section label={isError ? "error" : "result"}>
            <CodeBlock>{out}</CodeBlock>
          </Section>
        )}
      </>
    );
  },
};

export const skillTool: ToolRenderer = {
  id: "skill",
  summarize: ({ args }) => stringArg(args, ["name", "skill", "path"]) ?? formatHeaderArgs(args),
  render: ({ args, result, status, isError }) => {
    const name = stringArg(args, ["name", "skill", "path"]);
    const out = typeof result === "string" ? result : resultText(result, status);
    return (
      <>
        <ToolMeta icon={<Sparkles size={12} />} label="skill" value={name} />
        <ArgsSection args={args} preferredKeys={["name", "skill", "path"]} />
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

function ToolMeta({ icon, label, value }: { icon: ReactNode; label: string; value?: string }): ReactNode {
  if (!value) return null;
  return (
    <Section label={label}>
      <div className="tool__path">
        {icon}
        <code>{truncate(value, 240)}</code>
      </div>
    </Section>
  );
}

function ArgsSection({ args, preferredKeys }: { args: unknown; preferredKeys?: readonly string[] }): ReactNode {
  const summary = formatHeaderArgs(args, preferredKeys);
  if (!summary) return null;
  return (
    <Section label="args">
      <CodeBlock>{summary}</CodeBlock>
    </Section>
  );
}

function formatQuestions(questions: unknown[]): string {
  return questions
    .map((q, i) => {
      const record = typeof q === "object" && q !== null ? (q as Record<string, unknown>) : undefined;
      const label = typeof record?.label === "string" ? record.label : `Question ${i + 1}`;
      const prompt = typeof record?.prompt === "string" ? ` — ${record.prompt}` : "";
      const choices = Array.isArray(record?.choices)
        ? record.choices
            .map((choice) => {
              if (typeof choice !== "object" || choice === null) return undefined;
              const c = choice as Record<string, unknown>;
              return typeof c.label === "string" ? c.label : typeof c.value === "string" ? c.value : undefined;
            })
            .filter(Boolean)
            .join(" / ")
        : "";
      return `${i + 1}. ${label}${prompt}${choices ? `\n   choices: ${choices}` : ""}`;
    })
    .join("\n");
}

function formatSubagentTasks(tasks: unknown[]): string {
  return tasks
    .map((task, i) => {
      if (typeof task !== "object" || task === null) return `${i + 1}. ${String(task)}`;
      const record = task as Record<string, unknown>;
      const id = typeof record.id === "string" ? `${record.id}: ` : "";
      const text = typeof record.task === "string" ? record.task : formatHeaderArgs(record);
      return `${i + 1}. ${id}${truncate(text, 260)}`;
    })
    .join("\n");
}

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
