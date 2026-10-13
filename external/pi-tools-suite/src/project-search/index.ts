import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSemanticConsentCommand } from "./semantic-command.js";
import { registerSavedTaskEmbeddingSync } from "./semantic-task-sync.js";
import { registerSessionChunkSync } from "./semantic-session-chunks.js";
import { registerSearchIndexCommand } from "./index-command.js";
import { REPOSITORY_DISCOVERY_GUIDELINES } from "../tool-descriptions.js";
import { formatProjectSearch, INDEX_SEARCH_MODES, parseProjectSearchParams, PROJECT_SEARCH_SOURCES, searchProject } from "./engine.js";

/**
 * Available in ordinary Pi, Pix Desktop and TUI without a separate indexing CLI.
 * The hosting agent synthesizes answers; this tool never invokes Jev or another LLM.
 */
export default function projectSearch(pi: ExtensionAPI): void {
  const refreshTasks = registerSavedTaskEmbeddingSync(pi);
  registerSessionChunkSync(pi);
  registerSemanticConsentCommand(pi, refreshTasks);
  registerSearchIndexCommand(pi);
  pi.registerTool({
    name: "project_search",
    label: "Project Search",
    description: "Project search across Sessions, Tasks, Git commits, Code and Knowledge. Returns one ranked result within 60 s. Code/Knowledge use native local FTS5; hybrid/semantic modes use the global provider configured in ~/.config/pi/pi-tools-suite.jsonc, with repository vectors in .pi/search/code.sqlite and knowledge.sqlite. Public user/assistant session text is automatically indexed on startup and changes. This may upload session/code/document chunks, relative paths/headings and queries and incur costs; indexing is bounded and reports partial coverage. indexMode=lexical avoids all embedding calls. History vectors use source-local sessions.sqlite, tasks.sqlite and git-commits.sqlite under .pi/search/. Explicit global provider configuration authorizes all sources and projects; no per-source or per-project opt-ins. Never modifies canonical tasks/sessions/Git. Use sources=['code','knowledge'] for repository search; pathPrefix, dedupeFile and includeContent work natively. Results are evidence pointers, not answers; read the original sources for context. Excerpts may enter the calling model context.",
    promptSnippet: "Start focused code-path lookup or diagnosis with project_search, including tracing one mechanism or finding its implementation. Use sources=['code','knowledge']; first pass maxFiles=3, no includeContent; then read returned ranges. For general discovery, search the primary contract and relevant implementation/tests, then read sources. For session/task/commit history choose corresponding sources. Hybrid/semantic searches can index configured repository chunks, saved session names, public session message chunks and Git commits, including external provider costs; task search ranks the automatically maintained saved-task cache. Lexical mode makes no provider calls. No second LLM.",
    promptGuidelines: [
      ...REPOSITORY_DISCOVERY_GUIDELINES,
      "Search the current project by default. Set projectPath only for an explicitly requested different project; canonical task/session/Git state is never changed. A configured semantic search can update source-local databases under .pi/search/ and send selected text for embedding.",
      "The tool searches current HEAD history and public user/assistant text chunks on saved session branches. It excludes tool payloads, thinking and attachments. Git patches require patch:<literal>. Session snippets carry message IDs and offsets; read later turns before inferring final decisions.",
      "Code/Knowledge use native FTS5 plus embeddings from the global provider, refreshed on explicit hybrid/semantic searches. Configuration in ~/.config/pi/pi-tools-suite.jsonc itself authorizes semantics across Pi and Desktop. Up to 128 new scoped chunks per search; heed partial-coverage notices. For structural matching use ast_grep, not project_search.",
      "With a globally configured provider, saved tasks and public session message chunks are embedded automatically on startup and changes. Task searches rank current cached vectors. Session searches can fill missing chunk vectors; semantic searches send the query, and Commits may send commit message/author. Missing/invalid provider configuration falls back to lexical results. Never configure providers on the user’s behalf.",
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
          description: "Sources to search. Defaults to all five. Hybrid/semantic may fill missing vectors for globally configured repository/history sources; lexical avoids provider calls, not local file-index updates." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10,
          description: "Maximum combined hits, ranked across selected sources." },
        indexMode: { type: "string", enum: [...INDEX_SEARCH_MODES], default: "hybrid",
          description: "Hybrid fuses lexical and globally configured embeddings; semantic uses available semantic matches, falling back with notice when unavailable. Also controls history modes. Lexical sends nothing to embedding providers." },
        pathPrefix: { type: "string", maxLength: 1024,
          description: "Limit Code/Knowledge to a safe project-relative path prefix. Not applied to sessions, tasks or commits." },
        maxFiles: { type: "integer", minimum: 1, maximum: 50,
          description: "Candidates per Code/Knowledge domain: defaults to 3 (or 1 with includeContent). Maximum 50; final combined results obey limit (max 20)." },
        includeContent: { type: "boolean", default: false, description: "Include bounded matched excerpts; omit on the first search to save tokens." },
        dedupeFile: { type: "boolean", description: "At most one result per file." },
        excludeTests: { type: "boolean", description: "Exclude tests (cannot combine with includeTests)." },
        includeTests: { type: "boolean", description: "Remove the normal test penalty (cannot combine with excludeTests)." },
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
        const response = await searchProject(ctx.cwd, parsed.params, {},
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
