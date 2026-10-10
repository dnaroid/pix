import type { SessionInfo } from "@agentclientprotocol/sdk";
import type { LocalSearchHit, SearchSetting, SessionSearchHit, SettingsSearchHit } from "../../../acp/src/search/contract";
import type { AcpClient } from "./acp-client";
import { rankSearchHits } from "./search-relevance";
import { SETTINGS_SEARCH_CATALOG } from "./settings-search-catalog";
import { queryUniversalSearch, type UnifiedSearchResult } from "./universal-search";

export const INLINE_SEARCH_SETTINGS: readonly SearchSetting[] = SETTINGS_SEARCH_CATALOG.map(entry => ({
  ...entry, description: entry.description ?? "",
}));

export type InlineSearchKind = "settings" | "sessions";
export type InlineSearchClient = Pick<AcpClient, "searchQuery">;

/** Immediate, local-only preview. Submitted queries use the same universal search engine. */
export function previewInlineSearch(kind: "settings", query: string): SettingsSearchHit[];
export function previewInlineSearch(kind: "sessions", query: string, sessions: readonly SessionInfo[]): SessionSearchHit[];
export function previewInlineSearch(kind: InlineSearchKind, query: string, sessions: readonly SessionInfo[] = []): LocalSearchHit[] {
  if (!query.trim()) return [];
  const hits: LocalSearchHit[] = kind === "settings"
    ? INLINE_SEARCH_SETTINGS.map(field => ({
      kind: "settings", id: `settings:${field.id}`, fieldId: field.id, section: field.section,
      title: field.label, snippet: field.description, score: 1,
    }))
    : [...new Map(sessions.map(session => [session.sessionId, session])).values()].map(session => ({
      kind: "sessions", id: `sessions:${session.sessionId}`, sessionId: session.sessionId,
      title: session.title ?? "Untitled conversation",
      snippet: `${session.sessionId} ${session.updatedAt ?? ""}`, score: 1,
    }));
  return rankSearchHits(hits, query, INLINE_SEARCH_SETTINGS, false, true)
    .filter((hit): hit is LocalSearchHit => hit.kind === kind);
}

/** Explicit search: reuses Universal Search's ACP source and unified reranking.
 * Semantic requests follow the same independent consent flags as the dialog. */
export function queryInlineSearch(
  kind: InlineSearchKind, client: InlineSearchClient, workspace: string, query: string, signal: AbortSignal,
  onUpdate?: (result: UnifiedSearchResult) => void,
): Promise<UnifiedSearchResult> {
  return queryUniversalSearch({ local: (request, owner) => client.searchQuery(request, owner) },
    workspace, query, [kind], INLINE_SEARCH_SETTINGS, signal, onUpdate);
}
