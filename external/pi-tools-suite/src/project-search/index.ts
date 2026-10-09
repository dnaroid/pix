import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatProjectSearch, INDEX_CHUNK_TYPES, INDEX_SEARCH_MODES, parseProjectSearchParams, PROJECT_SEARCH_SOURCES, searchProject } from "./engine.js";

/**
 * Available in both Pix Desktop and TUI, independent of the IDX registration gate.
 * The hosting agent synthesizes answers; this tool never invokes Jev or another LLM.
 */
export default function projectSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "project_search",
    label: "Project Search",
    description: "Read-only project search: Sessions (first user/last completed assistant), Tasks, Git commits and changed paths, Code and Knowledge through existing IDX. This is the single focused IDX code/document search tool. For code/knowledge-only lookup choose sources=['code','knowledge']; use pathPrefix, indexMode, chunkTypes, minScore, dedupeFile/dedupeSymbol, test filters and includeContent for bounded detail. Returns ranked evidence references/IDs, never generates an answer or initializes an index. For general behavior/context assembly prefer repo_context. Hybrid/semantic IDX may send the query to the configured embedding provider; indexMode=lexical avoids those calls. Session/task excerpts can be private and enter the calling agent's model context.",
    promptSnippet: "For unknown code/document owners use project_search with sources=['code','knowledge']; first pass maxFiles=3, no includeContent. Read best returned ranges, not whole files. For cross-session/task/commit history use broader sources. General behavior/spec discovery: repo_context. No second LLM or automatic indexing.",
    promptGuidelines: [
      "Search the current project by default. Set projectPath only for an explicitly requested different project; no project state is changed.",
      "The tool searches current HEAD history (including changed paths) and only first/last completed session excerpts. It does not search full transcripts or Git patches unless patch:<literal> is requested.",
      "Code/Knowledge use the existing IDX index only; missing IDX is not permission to initialize or migrate an index. Search mode can be hybrid, semantic, lexical or symbol; lexical avoids query embedding calls.",
      "Use pathPrefix/dedupeFile to narrow; includeContent only for a narrow follow-up (maxFiles=1 is usually enough). Exact identifiers: available Grep/grep or shell with rg. Stop broad search once the owning file is located.",
      "Source hits are evidence pointers, not authoritative conclusions. Read the indicated file/line or commit, and preserve session/task IDs when citing findings. No RAG generation is performed inside the tool.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 2048,
          description: "The text, identifier, past decision or filename to find. Use patch:<literal> for explicit Git changed-line search." },
        sources: { type: "array", minItems: 1, maxItems: PROJECT_SEARCH_SOURCES.length,
          uniqueItems: true, items: { type: "string", enum: [...PROJECT_SEARCH_SOURCES] },
          description: "Sources to search. Defaults to all five; choose sessions/tasks/commits for local-only retrieval." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10,
          description: "Maximum combined hits, ranked across selected sources." },
        indexMode: { type: "string", enum: [...INDEX_SEARCH_MODES], default: "hybrid",
          description: "IDX Code/Knowledge search mode only. Hybrid/semantic may contact the configured embedding provider; lexical does not." },
        pathPrefix: { type: "string", maxLength: 1024,
          description: "IDX-only: limit Code/Knowledge matches to a safe project-relative directory or file prefix. Not applied to sessions, tasks or commits." },
        maxFiles: { type: "integer", minimum: 1, maximum: 50,
          description: "IDX candidates per domain: defaults to 3 (or 1 with includeContent). Max 50 for intentional broad follow-ups; final combined results still obey limit (max 20)." },
        chunkTypes: { type: "array", minItems: 1, maxItems: INDEX_CHUNK_TYPES.length,
          uniqueItems: true, items: { type: "string", enum: [...INDEX_CHUNK_TYPES] },
          description: "IDX-only: restrict code chunks to selected types, api, impl, tests, imports." },
        minScore: { type: "number", minimum: 0, maximum: 1, description: "IDX-only minimum ranked score (0–1)." },
        includeContent: { type: "boolean", default: false, description: "IDX-only: include bounded matched excerpts; omit for the first search to save tokens." },
        includeImports: { type: "boolean", description: "IDX-only: include import/preamble chunks." },
        dedupeFile: { type: "boolean", description: "IDX-only: at most one result per file." },
        dedupeSymbol: { type: "boolean", description: "IDX-only: at most one result per file/symbol." },
        cluster: { type: "boolean", description: "IDX-only: cluster nearby hits." },
        excludeTests: { type: "boolean", description: "IDX-only: exclude tests (cannot combine with includeTests)." },
        includeTests: { type: "boolean", description: "IDX-only: remove the normal test penalty (cannot combine with excludeTests)." },
        projectPath: { type: "string",
          description: "Optional explicitly selected project root, absolute, relative to the session cwd, or ~/; never changes the session cwd." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_id, params, signal, _update, ctx) {
      const parsed = parseProjectSearchParams(params);
      if (!parsed.params) return {
        content: [{ type: "text" as const, text: parsed.error ?? "Invalid project_search request" }],
        isError: true, details: { valid: false },
      };
      try {
        const response = await searchProject(ctx.cwd, parsed.params, { exec: (cmd, argv, options) => pi.exec(cmd, argv, options) },
          signal ?? new AbortController().signal);
        return {
          content: [{ type: "text" as const, text: formatProjectSearch(response) }],
          details: { projectRoot: response.projectRoot, query: response.query,
            sources: response.sources, results: response.hits, notices: response.notices },
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: signal?.aborted
            ? "project_search cancelled." : "project_search unavailable: check the project path and retry." }],
          isError: true, details: { cancelled: signal?.aborted ?? false },
        };
      }
    },
  });
}
