import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import type { WikiFinding } from "../lib/wiki-conflicts-index";
import type { ProjectTaskDraft } from "./project-tasks.svelte";
import { wikiDecisionInput, type WikiFindingDecisionInput } from "./wiki-finding-decision";

const MAX_TITLE_CHARS = 200;
const MAX_QUOTE_CHARS = 2_000;

const location = (citation: KnowledgeCitation) =>
  `${citation.path}:L${citation.startLine}${citation.endLine === citation.startLine ? "" : `–${citation.endLine}`}`;
const clip = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const quoted = (quote: string) => clip(quote.trim(), MAX_QUOTE_CHARS).split(/\r\n?|\n/u).map(line => `> ${line}`).join("\n");

/** Project task for a deferred finding: both sides, the explanation and the finding identity. */
export function wikiFindingTaskDraft(finding: WikiFinding): Omit<ProjectTaskDraft, "id"> {
  const ru = finding.reportLanguage === "ru";
  const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const subject = finding.internal ? fileName(finding.draft.path)
    : `${fileName(finding.draft.path)} ↔ ${fileName(finding.existing.path)}`;
  const kind = finding.kind === "conflict"
    ? ru ? "Разрешить противоречие Wiki" : "Resolve Wiki conflict"
    : ru ? "Уточнить неопределённость Wiki" : "Clarify Wiki uncertainty";
  const description = [
    finding.explanation.trim(),
    "",
    `${location(finding.draft)}`,
    quoted(finding.draft.quote),
    "",
    `${location(finding.existing)}`,
    quoted(finding.existing.quote),
    "",
    `${ru ? "Находка" : "Finding"}: ${finding.id}`,
  ].join("\n");
  return {
    title: clip(`${kind}: ${subject}`, MAX_TITLE_CHARS),
    description: clip(description, 10_000),
    type: finding.kind === "conflict" ? "bug" : "improvement",
    links: [...new Set([finding.draft.path, finding.existing.path])],
  };
}

export interface WikiFindingTaskOptions {
  /** Ensures the project task list is loaded; false when tasks cannot be written now. */
  readonly prepare: () => Promise<boolean>;
  readonly newId: () => string;
  readonly create: (draft: ProjectTaskDraft) => Promise<boolean>;
  /** Records the deferred verdict with the task link; false when it was not saved. */
  readonly decide: (finding: WikiFinding, decision: WikiFindingDecisionInput) => Promise<boolean>;
  readonly open: (taskId: string) => void | Promise<void>;
  /** The project that owned the click is still open. */
  readonly isCurrent: () => boolean;
}

/**
 * Explicit «Create task» for a deferred finding. The task is created first, so a
 * saved link never points to a missing task; a failed link leaves a normal task.
 * Returns the created task id, or null when nothing was created.
 */
export async function createWikiFindingTask(finding: WikiFinding, options: WikiFindingTaskOptions): Promise<string | null> {
  const ru = finding.reportLanguage === "ru";
  if (!(await options.prepare()) || !options.isCurrent()) {
    if (options.isCurrent()) throw new Error(ru ? "Задачи проекта сейчас недоступны. Повторите позже." : "Project tasks are unavailable right now. Try again later.");
    return null;
  }
  const id = options.newId();
  if (!(await options.create({ ...wikiFindingTaskDraft(finding), id }))) {
    if (options.isCurrent()) throw new Error(ru ? "Не удалось создать задачу." : "Could not create the task.");
    return null;
  }
  if (!options.isCurrent()) return id;
  const current = finding.decision?.verdict === "deferred" ? wikiDecisionInput(finding.decision) : { verdict: "deferred" as const };
  await options.decide(finding, { ...current, verdict: "deferred", taskId: id });
  if (options.isCurrent()) await options.open(id);
  return id;
}
