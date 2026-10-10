import {
  isClassifiedTaskType, QUICK_TASK_DEFAULT_TYPE, QUICK_TASK_MAX_LENGTH,
  type TaskTypeClassifyRequest, type TaskTypeClassifyResponse,
} from "../../../acp/src/tasks/type-classification-contract";
import { quickTaskDraft } from "./quick-task";

export type TaskTypeClient = {
  classifyTaskType: (request: TaskTypeClassifyRequest, signal?: AbortSignal) => Promise<TaskTypeClassifyResponse>;
};

export type QuickTaskDraft = NonNullable<ReturnType<typeof quickTaskDraft>>;
export type QuickTaskResult =
  | { status: "created"; type: QuickTaskDraft["type"]; fallback: boolean }
  | { status: "failed" | "cancelled" | "busy" | "empty" };

/** Do not retain a pending submission when an ACP transport ignores aborts. */
function cancellableDecision(client: TaskTypeClient, request: TaskTypeClassifyRequest, signal: AbortSignal): Promise<TaskTypeClassifyResponse> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new Error("Task classification cancelled")); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = () => signal.removeEventListener("abort", onAbort);
    try {
      client.classifyTaskType(request, signal).then(
        value => { settle(); resolve(value); },
        error => { settle(); reject(error); },
      );
    } catch (error) { settle(); reject(error); }
  });
}

/** Owns a single explicit submission; cancellation never initiates a new write. */
export class TaskQuickAddController {
  private request?: AbortController;

  get busy(): boolean { return this.request !== undefined; }

  cancel(): void {
    this.request?.abort();
    this.request = undefined;
  }

  async submit(
    text: string,
    workspace: string,
    client: TaskTypeClient | null,
    create: (draft: QuickTaskDraft) => Promise<boolean | void> | boolean | void,
    canCreate: () => boolean = () => true,
  ): Promise<QuickTaskResult> {
    if (this.busy) return { status: "busy" };
    if (!workspace || !text.trim() || text.length > QUICK_TASK_MAX_LENGTH) return { status: "empty" };
    const request = new AbortController();
    this.request = request;
    const isCurrent = () => this.request === request && !request.signal.aborted;
    let type: QuickTaskDraft["type"] = QUICK_TASK_DEFAULT_TYPE;
    let fallback = true;
    try {
      if (client) {
        try {
          const decision = await cancellableDecision(client, { cwd: workspace, text: text.trim() }, request.signal);
          if (isClassifiedTaskType(decision.type) && typeof decision.fallback === "boolean"
            && (!decision.fallback || decision.type === QUICK_TASK_DEFAULT_TYPE)) {
            type = decision.type;
            fallback = decision.fallback;
          }
        } catch {
          // Jev/ACP is optional: the original task is still saved as Feature.
        }
      }
      if (!isCurrent()) return { status: "cancelled" };
      if (!canCreate()) return { status: "cancelled" };
      const draft = quickTaskDraft(text, type);
      if (!draft) return { status: "empty" };
      const saved = await create(draft);
      if (!isCurrent()) return { status: "cancelled" };
      return saved === false ? { status: "failed" } : { status: "created", type, fallback };
    } catch {
      return isCurrent() ? { status: "failed" } : { status: "cancelled" };
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }
}
