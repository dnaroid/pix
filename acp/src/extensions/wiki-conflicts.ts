import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initializedProjectWiki } from "../knowledge/wiki-findings-scan.js";
import {
  ACTIONS, DECIDE_VERDICTS, DEFAULT_LIMIT, KINDS, MAX_IDS, MAX_LIMIT, MIN_ID_PREFIX, STATUSES,
  decideWikiConflict, defaultWikiPageCheck, listWikiConflicts, parseWikiConflictsParams, recheckWikiPage,
  type WikiPageCheck,
} from "./wiki-conflicts-actions.js";

/**
 * Agent tool over saved Wiki contradiction reports. It is active only for runs
 * whose project has an initialized Wiki; activation is re-evaluated every run.
 */

export const WIKI_CONFLICTS_TOOL = "wiki_conflicts";
export { compactWikiFinding, parseWikiConflictsParams } from "./wiki-conflicts-actions.js";

export interface WikiConflictsExtensionOptions {
  /** Test seam for `recheck`; defaults to the Desktop knowledge-check service. */
  readonly check?: () => Promise<WikiPageCheck>;
}

async function wikiReady(cwd: string): Promise<boolean> {
  try { return !!await initializedProjectWiki(cwd); } catch { return false; }
}

export function createWikiConflictsExtension(options: WikiConflictsExtensionOptions = {}) {
  return function wikiConflictsExtension(pi: ExtensionAPI): void {
    pi.registerTool({
      name: WIKI_CONFLICTS_TOOL,
      label: "Wiki conflicts",
      description: "Contradictions and uncertainties found by Pix Wiki consistency checks, from reports saved in project Wiki pages. "
        + "action=list (default): findings with canonical sides a/b (path, lines, quote), quoteChanged (sides whose quote no longer occurs in the current page), "
        + "explanation, status (open, fix-pending = fix verdict awaiting recheck, decided = false positive/deferred, stale = no longer in a current report), decision and totals; "
        + "filter by status/kind/path or ids (full id or hex prefix). "
        + "action=decide: record a verdict for one finding id in every report containing it: side-a / side-b (that side is correct; the other was fixed), "
        + "different-scope, false-positive (note required), deferred, or clear to remove the decision. "
        + "action=recheck: run the configured Wiki consistency check (paid model call) on one Wiki page and save its report; refuses to overwrite a page edited during the check.",
      promptSnippet: "Use wiki_conflicts to see, decide and recheck known contradictions in the project Wiki.",
      promptGuidelines: [
        "wiki_conflicts: never edit the `<!-- pix:wiki-report ... -->` or `<!-- pix:wiki-check ... -->` metadata lines in Wiki pages.",
        "wiki_conflicts decide: record side-a/side-b/different-scope only after the fix is actually written; false-positive and deferred only on the user's explicit decision.",
        "wiki_conflicts recheck: costs a model call per page; use it once after finishing a page's fixes, not after every edit. A fix is confirmed only when the recheck no longer reports the finding.",
      ],
      defaultActive: false,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS], description: "list (default), decide or recheck." },
          status: { type: "string", enum: [...STATUSES], description: "list: default open (includes fix-pending); with ids default all. all returns every status." },
          kind: { type: "string", enum: [...KINDS], description: "list: conflict, uncertainty, or internal (both sides on one page)." },
          path: { type: "string", maxLength: 1024, description: "list: Wiki folder or page prefix matching either side. recheck: the Wiki page to check." },
          ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_IDS, description: `list: finding ids or hex prefixes (≥${MIN_ID_PREFIX} chars).` },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `list: maximum findings returned (default ${DEFAULT_LIMIT}).` },
          id: { type: "string", maxLength: 64, description: `decide: finding id or unique hex prefix (≥${MIN_ID_PREFIX} chars).` },
          verdict: { type: "string", enum: [...DECIDE_VERDICTS], description: "decide: side-a/side-b refer to sides a/b from list." },
          note: { type: "string", maxLength: 1000, description: "decide: rationale; required for false-positive." },
        },
        additionalProperties: false,
      },
      async execute(_id, params, signal, _update, ctx) {
        try {
          const request = parseWikiConflictsParams(params);
          const wiki = await initializedProjectWiki(ctx.cwd);
          if (!wiki) throw new Error("The project Wiki is not initialized.");
          const owned = signal ?? new AbortController().signal;
          const response = request.action === "decide" ? await decideWikiConflict(wiki, request, owned)
            : request.action === "recheck" ? await recheckWikiPage(wiki, request, await (options.check ?? defaultWikiPageCheck)(), owned)
              : await listWikiConflicts(wiki, request, owned);
          return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: response };
        } catch (error) {
          const message = signal?.aborted ? "wiki_conflicts cancelled." : error instanceof Error ? error.message : "wiki_conflicts failed.";
          return { content: [{ type: "text" as const, text: message }], isError: true, details: { error: message } };
        }
      },
    });

    // Re-evaluated every run: the Wiki can be initialized or removed while a session is open.
    pi.on("before_agent_start", async (event) => {
      const ready = await wikiReady(event.systemPromptOptions.cwd);
      const active = pi.getActiveTools();
      const has = active.includes(WIKI_CONFLICTS_TOOL);
      if (ready && !has) pi.setActiveTools([...active, WIKI_CONFLICTS_TOOL]);
      else if (!ready && has) pi.setActiveTools(active.filter(name => name !== WIKI_CONFLICTS_TOOL));
    });
  };
}

export default createWikiConflictsExtension();
