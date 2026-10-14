import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSemanticConsentCommand } from "./semantic-command.js";
import { registerSavedTaskEmbeddingSync } from "./semantic-task-sync.js";
import { registerSessionChunkSync } from "./semantic-session-chunks.js";
import { registerSearchIndexCommand } from "./index-command.js";
import { readSourcePolicy, watchSourcePolicy } from "./source-policy.mjs";
import { findProjectRoot } from "../lib/project.js";
import { suiteDiagnostics } from "../lib/suite-diagnostics.js";
import type { ProjectSearchSource } from "./engine.js";
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
  let unwatch: (() => void) | undefined;
  let revision = 0;
  const register = (available: ProjectSearchSource[]) => pi.registerTool({
    name: "project_search",
    label: "Project Search",
    description: `Project search. Enabled sources for this project: ${available.join(", ") || "none"}. Returns ranked evidence pointers within 60 s. Project-local source selection controls indexing and search; disabled caches are retained but not searched. Hybrid/semantic uses the globally configured provider and may upload selected chunks and queries and incur costs. indexMode=lexical avoids embedding calls. Never modifies canonical project data. Read original sources for context; excerpts may enter the calling model context.`,
    promptSnippet: `Start focused lookup with project_search using only enabled sources: ${available.join(", ") || "none (do not call until a source is enabled)"}. First pass maxFiles=3, no includeContent; read returned ranges. Lexical makes no provider calls. No second LLM.`,
    promptGuidelines: [
      "Search the current project by default. Set projectPath only for an explicitly requested different project; canonical project data is never changed. A configured semantic search can update source-local databases under .pi/search/ and send selected text for embedding.",
      "Only enabled project sources may be searched or indexed. Global embedding configuration authorizes uploads but does not override the project selection. For structural matching use ast_grep, not project_search. Never configure providers on the user’s behalf.",
      ...(available.includes("sessions") ? ["Saved session names and public user/assistant text index after one hour of inactivity, never while its agent runs; manual indexing bypasses this delay. Session queries rank cached vectors without embedding documents; preserve session IDs when citing findings."] : []),
      ...(available.includes("commits") ? ["Git patches require patch:<literal>; preserve commit IDs when citing findings."] : []),
      "Use pathPrefix/dedupeFile to narrow; includeContent only for a narrow follow-up (maxFiles=1 is usually enough). Exact identifiers: available Grep/grep or shell with rg. Stop broad search once the owning file is located.",
      "Source hits are evidence pointers, not authoritative conclusions. Read original sources. No RAG generation is performed inside the tool.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 2048,
          description: "The text, identifier, past decision or filename to find." + (available.includes("commits") ? " Use patch:<literal> for explicit Git changed-line search." : "") },
        ...(available.length ? { sources: { type: "array", minItems: 1, maxItems: available.length,
          uniqueItems: true, items: { type: "string", enum: available },
          description: "Sources to search. Defaults to the enabled project sources. Lexical avoids provider calls, not local file-index updates." } } : {}),
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10,
          description: "Maximum combined hits, ranked across selected sources." },
        indexMode: { type: "string", enum: [...INDEX_SEARCH_MODES], default: "hybrid",
          description: "Hybrid fuses lexical and globally configured embeddings; semantic uses available semantic matches, falling back with notice when unavailable. Also controls history modes. Lexical sends nothing to embedding providers." },
        pathPrefix: { type: "string", maxLength: 1024,
          description: "Limit repository results to a safe project-relative path prefix." },
        maxFiles: { type: "integer", minimum: 1, maximum: 50,
          description: "Candidates per repository domain: defaults to 3 (or 1 with includeContent). Maximum 50; final combined results obey limit (max 20)." },
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
        if (!signal?.aborted) suiteDiagnostics.report("warn", "search", "query-failed", ctx.cwd);
        return {
          content: [{ type: "text" as const, text: signal?.aborted
            ? "project_search cancelled." : "project_search unavailable: check the project path and retry." }],
          isError: true, details: { cancelled: signal?.aborted ?? false },
        };
      }
    },
  });
  register(["code"]);
  pi.on("session_start", async (_event, ctx) => {
    unwatch?.();
    const current = ++revision;
    const root = findProjectRoot(ctx.cwd);
    let refreshRevision = 0;
    const refresh = async () => {
      const request = ++refreshRevision;
      const policy = await readSourcePolicy(root);
      if (current === revision && request === refreshRevision) register(PROJECT_SEARCH_SOURCES.filter(source => policy.enabled[source]));
    };
    unwatch = watchSourcePolicy(root, () => { void refresh(); });
    await refresh();
  });
  pi.on("session_shutdown", async () => { revision++; unwatch?.(); unwatch = undefined; });
}
