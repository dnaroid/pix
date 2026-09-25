/// <reference types="vite/client" />

export interface BuiltinAgentCatalogEntry {
  readonly name: string;
  readonly icon?: string;
  readonly description?: string;
}

const BUILTIN_AGENT_SOURCES = import.meta.glob(
  "../../../external/pi-tools-suite/src/async-subagents/agents/*.md",
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

/**
 * Build-time discovery keeps Desktop Settings aligned with the bundled agent
 * Markdown files without a second hand-maintained role-name list. Vite embeds
 * the tiny metadata source in the frontend bundle; runtime filesystem access is
 * not required.
 */
export const BUILTIN_AGENT_CATALOG: readonly BuiltinAgentCatalogEntry[] = Object.entries(BUILTIN_AGENT_SOURCES)
  .flatMap(([file, source]) => hasFrontmatter(source) ? [{
    name: file.slice(file.lastIndexOf("/") + 1, -3),
    icon: frontmatterScalar(source, "icon"),
    description: frontmatterScalar(source, "description"),
  }] : [])
  .sort((left, right) => left.name.localeCompare(right.name));

function hasFrontmatter(source: string): boolean {
  const normalized = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  return normalized.startsWith("---\n") && normalized.indexOf("\n---", 4) >= 0;
}

function frontmatterScalar(source: string, key: string): string | undefined {
  const normalized = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const prefix = `${key}:`;
  const line = normalized.slice(4, end).split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) return undefined;
  const value = line.slice(prefix.length).trim();
  if (!value) return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
