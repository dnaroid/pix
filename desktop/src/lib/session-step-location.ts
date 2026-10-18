import type { SessionTodoTask } from "./session-todos";
import { groupTranscriptItems } from "./transcript-presentation";
import type { TranscriptItem } from "./transcript-types";

/**
 * Where a session step (todo task) started in the loaded transcript.
 * `older` means no plan boundary was reached: the start may be in history
 * that is not loaded yet. `missing` means the current plan began in the
 * loaded transcript and this step has no matching todo call.
 */
export type SessionStepLocation =
  | { readonly kind: "found"; readonly itemId: string }
  | { readonly kind: "older" }
  | { readonly kind: "missing" };

type TodoInput = {
  readonly action?: unknown;
  readonly id?: unknown;
  readonly status?: unknown;
  readonly subject?: unknown;
  readonly replace?: unknown;
  readonly items?: unknown;
};

function todoInput(item: TranscriptItem): TodoInput | undefined {
  if (item.type !== "tool" || item.name?.toLowerCase() !== "todo" || item.status === "failed") return undefined;
  const input = item.rawInput;
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input as TodoInput : undefined;
}

function records(value: unknown): TodoInput[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is TodoInput => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

/**
 * Scan todo calls newest-first. The newest call that set the step to
 * `in_progress` wins; if the step was never started after its creation, the
 * creating call is used. A replacing create/import or a clear ends the scan:
 * older calls belong to a superseded plan whose ids may collide.
 */
export function locateSessionStepStart(
  items: readonly TranscriptItem[],
  task: Pick<SessionTodoTask, "id" | "subject">,
): SessionStepLocation {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const input = todoInput(item);
    if (!input) continue;
    const action = input.action;
    if (action === "update" && input.id === task.id && input.status === "in_progress") {
      return { kind: "found", itemId: item.id };
    }
    if (action === "batch_update" && records(input.items).some((entry) => entry.id === task.id && entry.status === "in_progress")) {
      return { kind: "found", itemId: item.id };
    }
    const replace = input.replace === true;
    if (action === "create" && input.subject === task.subject) return { kind: "found", itemId: item.id };
    if (action === "batch_create") {
      const created = records(input.items);
      const indexed = replace ? created[task.id - 1] : undefined;
      if (indexed?.subject === task.subject || created.some((entry) => entry.subject === task.subject)) {
        return { kind: "found", itemId: item.id };
      }
    }
    if (action === "clear" || (replace && (action === "create" || action === "batch_create" || action === "import"))) {
      return { kind: "missing" };
    }
  }
  return { kind: "older" };
}

/** Display id of the collapsed activity group that renders a transcript item. */
export function activityGroupIdFor(items: readonly TranscriptItem[], itemId: string): string | undefined {
  for (const display of groupTranscriptItems(items)) {
    if (display.type === "activity-group" && display.entries.some((entry) => entry.id === itemId)) return display.id;
  }
  return undefined;
}
