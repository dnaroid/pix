import { readFile } from "node:fs/promises";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { PixThinkingLevel } from "../acp/default-model.js";
import { parseModelRef } from "../acp/pix-settings.js";
import { desktopSearchConfigPath, semanticSearchConfigPath } from "../search/config.js";
import type { KnowledgeReportConfigPaths } from "./preferences.js";
import { KnowledgeReportError } from "./report-language.js";

export interface KnowledgeModelPreferences {
  readonly modelRef: string;
  readonly thinking: PixThinkingLevel;
}

const THINKING = new Set<PixThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const inherited = (value: unknown): boolean => value === undefined || (typeof value === "string" && !value.trim());

async function configuredJudge(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw new KnowledgeReportError("judgeConfigInvalid");
  }
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length || !record(value) || (value.knowledgeCheck !== undefined && !record(value.knowledgeCheck))) {
    throw new KnowledgeReportError("judgeConfigInvalid");
  }
  return record(value.knowledgeCheck) ? value.knowledgeCheck : {};
}

/** User-global judge only. Never inherit Search, session defaults or project-supplied models. */
export async function loadKnowledgeModelPreferences(
  _cwd: string,
  paths: KnowledgeReportConfigPaths = {},
): Promise<KnowledgeModelPreferences> {
  const desktop = await configuredJudge(paths.desktopPath ?? desktopSearchConfigPath());
  const suite = inherited(desktop.modelRef) || inherited(desktop.thinking)
    ? await configuredJudge(paths.suitePath ?? semanticSearchConfigPath()) : {};
  const model = inherited(desktop.modelRef) ? suite.modelRef : desktop.modelRef;
  const effort = inherited(desktop.thinking) ? suite.thinking : desktop.thinking;
  if (inherited(model)) throw new KnowledgeReportError("selectModel");
  if (typeof model !== "string" || model.trim().length > 256 || !/^[^\s/:]+\/[^\s:]+$/u.test(model.trim())) {
    throw new KnowledgeReportError("judgeConfigInvalid");
  }
  const modelRef = model.trim(), parsed = parseModelRef(modelRef);
  // Reasoning has its own independently inherited setting; do not silently ignore a suffix.
  if (!parsed || parsed.thinkingLevel !== undefined) throw new KnowledgeReportError("judgeConfigInvalid");
  const thinking = inherited(effort) ? "low" : effort;
  if (typeof thinking !== "string" || !THINKING.has(thinking as PixThinkingLevel)) {
    throw new KnowledgeReportError("judgeConfigInvalid");
  }
  return { modelRef, thinking: thinking as PixThinkingLevel };
}
