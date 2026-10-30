import { readFile } from "node:fs/promises";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { desktopSearchConfigPath, semanticSearchConfigPath } from "../search/config.js";
import type { KnowledgeReportLanguage } from "./contract.js";

export interface KnowledgeReportConfigPaths {
  readonly desktopPath?: string;
  readonly suitePath?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function configuredLanguage(path: string): Promise<KnowledgeReportLanguage | undefined> {
  try {
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(await readFile(path, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length || !record(value) || !record(value.knowledgeCheck)) return undefined;
    const language = value.knowledgeCheck.reportLanguage;
    return language === "en" || language === "ru" ? language : undefined;
  } catch { return undefined; }
}

/** Global user preferences only. Reading never creates, merges or repairs project configuration. */
export async function loadKnowledgeReportLanguage(paths: KnowledgeReportConfigPaths = {}): Promise<KnowledgeReportLanguage> {
  const desktop = await configuredLanguage(paths.desktopPath ?? desktopSearchConfigPath());
  if (desktop) return desktop;
  return await configuredLanguage(paths.suitePath ?? semanticSearchConfigPath()) ?? "en";
}
