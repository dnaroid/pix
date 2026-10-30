import { SvelteSet } from "svelte/reactivity";
import type { ProjectFilePreview } from "../lib/project-files";
import type { WikiFinding } from "../lib/wiki-conflicts-index";
import type { ManualKnowledgeCheckInput, ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";

interface Options {
  readonly workspace: () => string;
  readonly wikiPath: () => string | null;
  readonly jobs: () => readonly ProjectKnowledgeJob[];
  readonly read: (workspace: string, wikiPath: string, path: string, signal: AbortSignal) => Promise<ProjectFilePreview>;
  readonly enqueue: (input: ManualKnowledgeCheckInput) => number | undefined;
  readonly reportError: (error: unknown) => void;
}

const activeJob = (job: ProjectKnowledgeJob) => job.state === "queued" || job.state === "running";
const pendingKey = (workspace: string, path: string) => `${workspace}\u0000${path}`;

/**
 * "Recheck" for a Wiki finding: an ordinary manual check of each reporting page's
 * saved body through the existing project queue. Pages already queued, running or
 * being read are skipped, so repeated clicks never create duplicate checks.
 */
export function createWikiConflictsRecheck(options: Options) {
  const reading = new SvelteSet<string>();
  const controllers = new Set<AbortController>();
  let disposed = false;

  function active(workspace: string, path: string): boolean {
    return reading.has(pendingKey(workspace, path))
      || options.jobs().some(job => activeJob(job) && job.workspace === workspace && job.path === path);
  }

  async function recheckPage(workspace: string, wikiPath: string, path: string): Promise<boolean> {
    const key = pendingKey(workspace, path);
    reading.add(key);
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const document = await options.read(workspace, wikiPath, path, controller.signal);
      if (disposed || controller.signal.aborted || options.workspace() !== workspace) return false;
      // Re-check after the read: another entry point may have queued the page meanwhile.
      if (options.jobs().some(job => activeJob(job) && job.workspace === workspace && job.path === path)) return false;
      return options.enqueue({
        path, content: document.content, expectedContent: document.content, persistStamp: true,
      }) !== undefined;
    } catch (error) {
      if (!disposed && !controller.signal.aborted && options.workspace() === workspace) options.reportError(error);
      return false;
    } finally {
      controllers.delete(controller);
      reading.delete(key);
    }
  }

  /** Resolves to the number of newly queued page checks. */
  async function recheck(finding: WikiFinding): Promise<number> {
    const workspace = options.workspace();
    const wikiPath = options.wikiPath();
    if (disposed || !workspace || !wikiPath) return 0;
    const paths = [...new Set(finding.reportPaths)].filter(path => !active(workspace, path));
    const queued = await Promise.all(paths.map(path => recheckPage(workspace, wikiPath, path)));
    return queued.filter(Boolean).length;
  }

  return {
    recheck,
    /** A reporting page of this finding is being read, queued or checked. */
    rechecking(finding: WikiFinding): boolean {
      const workspace = options.workspace();
      return Boolean(workspace) && finding.reportPaths.some(path => active(workspace, path));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers) controller.abort(new Error("Wiki recheck disposed."));
      controllers.clear();
      reading.clear();
    },
  };
}

export type WikiConflictsRecheck = ReturnType<typeof createWikiConflictsRecheck>;
