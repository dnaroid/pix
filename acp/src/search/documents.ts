import { createHash } from "node:crypto";
import type { LocalSearchHit, SearchSetting } from "./contract.js";

export interface SearchDocument {
  readonly hit: LocalSearchHit;
  readonly text: string;
  readonly chunks: readonly string[];
}
export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");
// Bounded even for dense multilingual text; overlap preserves words crossing a boundary.
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += 1800) chunks.push(text.slice(start, start + 2000));
  return chunks;
}
export function settingsDocuments(settings: readonly SearchSetting[]): SearchDocument[] {
  const unique = new Map<string, SearchDocument>();
  for (const s of settings) {
    const text = [s.section, s.label, s.description, ...s.synonyms].join("\n");
    unique.set(s.id, { text, chunks: chunkText(text), hit: { kind: "settings", id: `settings:${s.id}`,
      fieldId: s.id, section: s.section, title: s.label, snippet: s.description.slice(0, 240), score: 0 } });
  }
  return [...unique.values()];
}
export function lexicalScore(text: string, query: string): number {
  const haystack = text.normalize("NFKC").toLocaleLowerCase();
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  if (!needle) return 0;
  if (haystack.includes(needle)) return 2;
  const tokens = [...new Set(needle.match(/[\p{L}\p{N}_]+/gu) ?? [])];
  return tokens.length ? tokens.filter(token => haystack.includes(token)).length / tokens.length : 0;
}
export function snippet(text: string, query: string): string {
  const at = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const start = Math.max(0, at - 70);
  return `${start ? "…" : ""}${text.slice(start, start + 240)}`;
}
