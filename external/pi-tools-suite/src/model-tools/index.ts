import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Type, type TSchema } from "typebox";
import { CODEX_ALIAS_TOOL_DESCRIPTIONS, REPO_DISCOVERY_TOOL_NAMES, claudeAliasToolDescriptions } from "../tool-descriptions";
import { hasIndexedProjectRoot } from "../lib/project.js";
import { applyPatch } from "./apply-patch";
import { isPathInside } from "./path-utils";
import {
  detectModelProfile,
  prepareApplyPatchArgs,
  selectSuitableToolsForModel,
  toEditArgs,
  toGrepArgs,
  toReadArgs,
  toShellCommand,
  toWriteArgs,
  type ModelProfile,
} from "./tool-args";

const CLAUDE_ALIAS_TOOL_DESCRIPTIONS = claudeAliasToolDescriptions(false);
const CLAUDE_ALIAS_TOOLS = Object.values(CLAUDE_ALIAS_TOOL_DESCRIPTIONS).map((tool) => tool.name);
const CODEX_ALIAS_TOOLS = ["read", ...Object.values(CODEX_ALIAS_TOOL_DESCRIPTIONS).map((tool) => tool.name)];
const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const LEGACY_MANAGED_TOOLS = ["LS", "shell_command"];
const MANAGED_TOOLS = new Set([...CLAUDE_ALIAS_TOOLS, ...CODEX_ALIAS_TOOLS, ...BUILTIN_TOOLS, ...LEGACY_MANAGED_TOOLS]);
const REPO_DISCOVERY_TOOL_NAME_SET = new Set(REPO_DISCOVERY_TOOL_NAMES);
const MAX_BUILTIN_DEFINITIONS = 64;

type ShellAliasInput = {
  command?: string;
  description?: string;
  cwd?: string;
  workdir?: string;
  timeout?: number;
  timeout_ms?: number;
  run_in_background?: boolean;
};

type BashToolDefinition = ReturnType<typeof createBashToolDefinition>;
type AnyToolDefinition = ToolDefinition<any, any, any>;
type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];
type RenderContext = {
  args: any;
  cwd: string;
  [key: string]: any;
};
type RenderTheme = Parameters<NonNullable<BashToolDefinition["renderCall"]>>[1];

const builtinDefinitions = new Map<string, AnyToolDefinition>();

function timeoutSeconds(input: { timeout?: number; timeout_ms?: number }): number | undefined {
  if (typeof input.timeout === "number") return input.timeout;
  if (typeof input.timeout_ms === "number") return Math.max(1, Math.ceil(input.timeout_ms / 1000));
  return undefined;
}

function createBuiltinDefinition(name: BuiltinToolName, cwd: string): AnyToolDefinition {
  switch (name) {
    case "read":
      return createReadToolDefinition(cwd);
    case "edit":
      return createEditToolDefinition(cwd);
    case "write":
      return createWriteToolDefinition(cwd);
    case "bash":
      return createBashToolDefinition(cwd);
    case "grep":
      return createGrepToolDefinition(cwd);
    case "find":
      return createFindToolDefinition(cwd);
    case "ls":
      return createLsToolDefinition(cwd);
  }
}

function getRenderDefinition(name: BuiltinToolName, cwd: string): AnyToolDefinition {
  const key = `${name}:${cwd}`;
  const existing = builtinDefinitions.get(key);
  if (existing) {
    builtinDefinitions.delete(key);
    builtinDefinitions.set(key, existing);
    return existing;
  }
  const definition = createBuiltinDefinition(name, cwd);
  if (builtinDefinitions.size >= MAX_BUILTIN_DEFINITIONS) {
    const oldestKey = builtinDefinitions.keys().next().value;
    if (oldestKey) builtinDefinitions.delete(oldestKey);
  }
  builtinDefinitions.set(key, definition);
  return definition;
}

function toBashRenderArgs(input: ShellAliasInput): { command: string; timeout?: number } {
  return { command: toShellCommand(input), timeout: timeoutSeconds(input) };
}

function withRenderArgs(context: unknown, args: unknown): RenderContext {
  return { ...(context as RenderContext), args };
}

function replaceRenderedTitle(text: string, builtinName: BuiltinToolName, aliasLabel: string): string {
  return aliasLabel === builtinName ? text : text.replace(builtinName, aliasLabel);
}

function applyAliasToolTitle(component: unknown, builtinName: BuiltinToolName, aliasLabel: string): boolean {
  if (aliasLabel === builtinName || !component || typeof component !== "object") return false;
  const target = component as { text?: unknown; setText?: (text: string) => void; children?: unknown[]; invalidate?: () => void };
  if (typeof target.text === "string") {
    const next = replaceRenderedTitle(target.text, builtinName, aliasLabel);
    if (next !== target.text) {
      if (typeof target.setText === "function") target.setText(next);
      else target.text = next;
      return true;
    }
    return false;
  }
  let changed = false;
  for (const child of target.children ?? []) changed = applyAliasToolTitle(child, builtinName, aliasLabel) || changed;
  if (changed) target.invalidate?.();
  return changed;
}

function renderAliasCall(
  name: BuiltinToolName,
  args: unknown,
  theme: RenderTheme,
  context: unknown,
  aliasLabel: string = name,
) {
  const renderContext = context as RenderContext;
  const renderCall = getRenderDefinition(name, renderContext.cwd).renderCall;
  if (!renderCall) throw new Error(`${name} renderer is unavailable`);
  const component = renderCall(args, theme, withRenderArgs(renderContext, args) as any);
  applyAliasToolTitle(component, name, aliasLabel);
  return component;
}

function renderAliasResult(
  name: BuiltinToolName,
  args: unknown,
  result: unknown,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context: unknown,
  aliasLabel: string = name,
) {
  const renderContext = context as RenderContext;
  const renderResult = getRenderDefinition(name, renderContext.cwd).renderResult;
  if (!renderResult) throw new Error(`${name} renderer is unavailable`);
  const component = renderResult(
    result as Parameters<NonNullable<AnyToolDefinition["renderResult"]>>[0],
    options,
    theme,
    withRenderArgs(renderContext, args) as any,
  );
  applyAliasToolTitle((renderContext.state as { callComponent?: unknown } | undefined)?.callComponent, name, aliasLabel);
  applyAliasToolTitle(component, name, aliasLabel);
  return component;
}

function renderShellAliasCall(args: ShellAliasInput, theme: RenderTheme, context: unknown) {
  return renderAliasCall("bash", toBashRenderArgs(args), theme, context, "shell");
}

function renderShellAliasResult(result: unknown, options: ToolRenderResultOptions, theme: RenderTheme, context: unknown) {
  const args = toBashRenderArgs((context as RenderContext).args as ShellAliasInput);
  return renderAliasResult("bash", args, result, options, theme, context, "shell");
}

async function resolveWorkdir(ctx: ExtensionContext, workdir: string | undefined): Promise<string | undefined> {
  if (!workdir) return undefined;
  const cwdRealPath = await realpath(ctx.cwd);
  const absolutePath = resolve(ctx.cwd, workdir);
  const workdirRealPath = await realpath(absolutePath);
  if (isPathInside(cwdRealPath, workdirRealPath)) return workdirRealPath;
  throw new Error(`Working directory escapes workspace: ${workdir}`);
}

type BuiltinAliasOptions<Input> = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  builtinName: BuiltinToolName;
  toArgs: (params: Input) => unknown;
  renderShell?: "self";
  validate?: (params: Input) => void;
};

function registerBuiltinAlias<Input>(pi: ExtensionAPI, options: BuiltinAliasOptions<Input>): void {
  pi.registerTool(
    defineTool({
      name: options.name,
      label: options.label,
      description: options.description,
      parameters: options.parameters,
      renderShell: options.renderShell,
      renderCall: (params, theme, context) =>
        renderAliasCall(options.builtinName, options.toArgs(params as Input), theme, context, options.label),
      renderResult: (result, renderOptions, theme, context) =>
        renderAliasResult(
          options.builtinName,
          options.toArgs((context as RenderContext).args as Input),
          result,
          renderOptions,
          theme,
          context,
          options.label,
        ),
      async execute(id, params, signal, onUpdate, ctx) {
        const input = params as Input;
        options.validate?.(input);
        return createBuiltinDefinition(options.builtinName, ctx.cwd).execute(
          id,
          options.toArgs(input),
          signal,
          onUpdate,
          ctx,
        );
      },
    }),
  );
}

function registerClaudeAliases(pi: ExtensionAPI, repoDiscovery: boolean): void {
  const descriptions = claudeAliasToolDescriptions(repoDiscovery);

  registerBuiltinAlias(pi, {
    ...descriptions.Read,
    builtinName: "read",
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to the file to read" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    toArgs: toReadArgs,
  });

  registerBuiltinAlias(pi, {
    ...descriptions.Edit,
    builtinName: "edit",
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to the file to edit" }),
      old_string: Type.String({ description: "Exact text to replace" }),
      new_string: Type.String({ description: "Replacement text" }),
      replace_all: Type.Optional(Type.Boolean({ description: "Not supported by this adapter" })),
    }),
    renderShell: "self",
    toArgs: toEditArgs,
    validate: (params: { replace_all?: boolean }) => {
      if (params.replace_all) throw new Error("Edit.replace_all is not supported by the Pi edit adapter");
    },
  });

  registerBuiltinAlias(pi, {
    ...descriptions.Write,
    builtinName: "write",
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to the file to write" }),
      content: Type.String({ description: "Complete file contents" }),
    }),
    toArgs: toWriteArgs,
  });

  registerBuiltinAlias(pi, {
    ...descriptions.Bash,
    builtinName: "bash",
    parameters: Type.Object({
      command: Type.String({ description: "Command to execute" }),
      description: Type.Optional(Type.String({ description: "Short command description" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Unsupported by this adapter; omit it." })),
    }),
    toArgs: toBashRenderArgs,
    validate: (params: { run_in_background?: boolean }) => {
      if (params.run_in_background) throw new Error("Bash.run_in_background is not supported by this adapter");
    },
  });

  registerBuiltinAlias(pi, {
    ...descriptions.Grep,
    builtinName: "grep",
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern" }),
      path: Type.Optional(Type.String({ description: "File or directory to search" })),
      glob: Type.Optional(Type.String({ description: "Glob filter" })),
      case_sensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive search" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat pattern as regex" })),
      before_context: Type.Optional(Type.Number({ description: "Lines before each match" })),
      after_context: Type.Optional(Type.Number({ description: "Lines after each match" })),
      context: Type.Optional(Type.Number({ description: "Lines around each match" })),
      max_count: Type.Optional(Type.Number({ description: "Maximum matches" })),
      limit: Type.Optional(Type.Number({ description: "Maximum matches" })),
    }),
    toArgs: toGrepArgs,
  });

  registerBuiltinAlias(pi, {
    ...descriptions.Glob,
    builtinName: "find",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern" }),
      path: Type.Optional(Type.String({ description: "Directory to search" })),
    }),
    toArgs: (params) => params,
  });

}

async function runShellAlias(
  id: string,
  input: ShellAliasInput,
  signal: AbortSignal | undefined,
  onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3],
  ctx: ExtensionContext,
) {
  const command = toShellCommand(input);
  if (!command) throw new Error("Missing shell command");
  const workdir = await resolveWorkdir(ctx, input.cwd ?? input.workdir);
  const tool = createBashToolDefinition(
    ctx.cwd,
    workdir ? { spawnHook: (spawnContext) => ({ ...spawnContext, cwd: workdir }) } : undefined,
  );
  return tool.execute(id, { command, timeout: timeoutSeconds(input) }, signal, onUpdate, ctx);
}

function registerCodexAliases(pi: ExtensionAPI): void {
  const shellParameters = Type.Object({
    command: Type.String({ description: "The shell script to execute in the user's default shell" }),
    workdir: Type.Optional(Type.String({ description: "Working directory" })),
    cwd: Type.Optional(Type.String({ description: "Working directory" })),
    timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
  });

  pi.registerTool(
    defineTool({
      ...CODEX_ALIAS_TOOL_DESCRIPTIONS.shellCommand,
      parameters: shellParameters,
      renderCall: renderShellAliasCall,
      renderResult: renderShellAliasResult,
      async execute(id, params, signal, onUpdate, ctx) {
        return runShellAlias(id, params, signal, onUpdate, ctx);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      ...CODEX_ALIAS_TOOL_DESCRIPTIONS.applyPatch,
      parameters: Type.Object({
        input: Type.String({ description: "Complete patch text: either a unified diff or a Begin Patch block" }),
      }),
      prepareArguments: prepareApplyPatchArgs,
      executionMode: "sequential",
      async execute(_id, params, signal, _onUpdate, ctx) {
        const result = await applyPatch(ctx.cwd, params.input, signal);
        return { content: [{ type: "text", text: result.summary }], details: result };
      },
    }),
  );
}

function toolsForProfile(profile: ModelProfile): string[] | undefined {
  if (profile === "claude") return CLAUDE_ALIAS_TOOLS;
  if (profile === "codex") return CODEX_ALIAS_TOOLS;
  return undefined;
}

function activeRepoDiscoveryTools(activeTools: string[], baseTools: string[]): string[] {
  const availableTools = new Set([...activeTools, ...baseTools]);
  return REPO_DISCOVERY_TOOL_NAMES.filter((tool) => availableTools.has(tool));
}

function sameTools(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

function applyToolProfile(pi: ExtensionAPI, model: unknown, baseTools: string[]): void {
	const targetTools = toolsForProfile(detectModelProfile(model));
	const preserveSelection = shouldPreserveSelection();
	const active = pi.getActiveTools();
	const repoTools = activeRepoDiscoveryTools(active, baseTools);
	const preserved = active.filter((tool) => !MANAGED_TOOLS.has(tool) && !REPO_DISCOVERY_TOOL_NAME_SET.has(tool));
	const baseWithoutRepoTools = baseTools.filter((tool) => !REPO_DISCOVERY_TOOL_NAME_SET.has(tool));
	const selectedTargetTools = preserveSelection
		? selectSuitableToolsForModel(model, active.filter((tool) => MANAGED_TOOLS.has(tool)))
		: targetTools;
	const next = selectedTargetTools ? [...repoTools, ...preserved, ...selectedTargetTools] : [...repoTools, ...preserved, ...baseWithoutRepoTools];
	const nextTools = [...new Set(next)];
	if (!sameTools(active, nextTools)) pi.setActiveTools(nextTools);
}

function shouldPreserveSelection(env: NodeJS.ProcessEnv = process.env): boolean {
	return [env.PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION, env.MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION]
		.some((value) => typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim()));
}

export default function modelTools(pi: ExtensionAPI): void {
  registerClaudeAliases(pi, hasIndexedProjectRoot());
  registerCodexAliases(pi);

  let baseTools: string[] = [];

  pi.on("session_start", (_event, ctx) => {
    baseTools = pi.getActiveTools().filter((tool) => !MANAGED_TOOLS.has(tool));
    applyToolProfile(pi, ctx.model, baseTools);
  });

  pi.on("model_select", (event) => {
    applyToolProfile(pi, event.model, baseTools);
  });
}

export { applyPatch, parseApplyPatch } from "./apply-patch";
export { detectModelProfile, prepareApplyPatchArgs, selectSuitableToolsForModel, toGrepArgs, toShellCommand } from "./tool-args";
