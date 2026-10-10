import type { GitHistoryEntry } from "./git-workflow";
import { projectTaskDisplayLabel, type ProjectTaskDocument } from "./project-tasks";

export interface TaskSearchHit {
  kind: "tasks";
  id: string;
  taskId: string;
  title: string;
  snippet: string;
  score: number;
  /** Semantic relevance can be valid without visible lexical query terms. */
  semantic?: boolean;
}

export interface CommitSearchHit {
  kind: "commits";
  id: string;
  hash: string;
  title: string;
  snippet: string;
  score: number;
  commit: GitHistoryEntry;
}

function matchScore(query: string, title: string, text: string): number {
  const words = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const label = title.toLocaleLowerCase();
  const content = text.toLocaleLowerCase();
  return words.length ? words.reduce((sum, word) => sum + (label.includes(word) ? 2 : content.includes(word) ? 1 : 0), 0) / (2 * words.length) : 0;
}

export function searchProjectTasks(document: ProjectTaskDocument, query: string, attachmentNames: Readonly<Record<string, readonly string[]>> = {}): TaskSearchHit[] {
  const byId = new Map(document.tasks.map(task => [task.id, task]));
  const backlinks = new Map<string, typeof document.tasks>();
  for (const task of document.tasks) for (const id of task.relatedTaskIds ?? []) {
    const related = backlinks.get(id) ?? [];
    related.push(task);
    backlinks.set(id, related);
  }
  return document.tasks.flatMap(task => {
    const title = projectTaskDisplayLabel(task);
    const references = [
      ...(task.links ?? []),
      ...(task.parentId ? [task.parentId, byId.get(task.parentId)?.title ?? ""] : []),
      ...(task.relatedTaskIds ?? []).flatMap(id => [id, byId.get(id)?.title ?? ""]),
      ...(backlinks.get(task.id) ?? []).flatMap(other => [other.id, other.title]),
      ...(attachmentNames[task.id] ?? []),
      task.sessionId ?? "", task.modelRef ?? "", task.epic ? "epic эпик" : "",
    ].join(" ");
    const score = matchScore(query, title, `${task.id} ${task.description ?? ""} ${task.type} ${task.status} ${task.priority} ${references}`);
    return score ? [{ kind: "tasks" as const, id: `tasks:${task.id}`, taskId: task.id, title, score,
      snippet: `${task.status} · ${task.type} · ${task.priority}${task.description ? `\n${task.description.slice(0, 500)}` : ""}${references ? `\n${references.slice(0, 350)}` : ""}` }] : [];
  }).sort((a, b) => b.score - a.score).slice(0, 20);
}

/** Ranks candidate current-HEAD commit metadata locally. No diffs. */
export function searchRecentCommits(history: readonly GitHistoryEntry[], query: string): CommitSearchHit[] {
  return history.flatMap(commit => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(commit.hash)) return [];
    const score = matchScore(query, commit.subject, `${commit.hash} ${commit.author}`);
    return score ? [{ kind: "commits" as const, id: `commits:${commit.hash}`, hash: commit.hash,
      title: commit.subject, snippet: `${commit.shortHash} · ${commit.author} · ${commit.date}`, score, commit }] : [];
  }).sort((a, b) => b.score - a.score).slice(0, 20);
}
