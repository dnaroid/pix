import { queryUniversalSearch, type SearchSources, type UnifiedSearchResult } from "./universal-search";

type WikiSearchSources = Required<Pick<SearchSources, "selection" | "repository">>;

/** Reuse Knowledge's progressive lexical/hybrid search, scoped before retrieval/uploads. */
export function queryProjectWiki(
  sources: WikiSearchSources,
  workspace: string,
  path: string,
  query: string,
  signal: AbortSignal,
  onUpdate?: (result: UnifiedSearchResult) => void,
): Promise<UnifiedSearchResult> {
  return queryUniversalSearch({
    selection: sources.selection,
    repository: async (workspace, request, signal) => {
      const response = await sources.repository(workspace, {
        ...request, sources: ["knowledge"], pathPrefix: path, dedupeFile: true,
      }, signal);
      return {
        ...response,
        hits: response.hits.filter(hit => hit.kind === "knowledge" && hit.path.startsWith(`${path}/`)),
      };
    },
  }, workspace, query, ["knowledge"], [], signal, onUpdate);
}
