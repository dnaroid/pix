import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTaskCommands } from "./commands.js";
import { parseProjectTasksParams, runProjectTasks } from "./engine.js";
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from "./schema.js";

export default function projectTasks(pi: ExtensionAPI): void {
  registerTaskCommands(pi);
  pi.registerTool({
    name: "project_tasks",
    label: "Project Tasks",
    description: "Read/write saved project tasks in cwd/.pi/tasks.sqlite (not session todo). list returns compact tasks with optional status/priority/type filters; get returns a full task by id. update changes only status, priority, title and description, preserving type, links and sessionId. create requires type and title or description, defaults to todo/medium, and is allowed ONLY on an explicit user request to create a new task. Status changes require explicit user authorization: a task launch prompt may authorize final done/failed for its specific task id; otherwise ask for confirmation. Writes validate the version-1 SQLite schema and use transactions with optimistic revisions for only the targeted task. Deletion is user-only via /task delete, not available in this tool. Task text returned to the agent enters its model context.",
    promptSnippet: "Use project_tasks for saved project tasks, not session-local planning. Create only when the user explicitly requests a new task. Status updates require confirmation unless the current task launch prompt explicitly authorizes final done/failed for that task id.",
    promptGuidelines: [
      "Use list/get to inspect current project tasks. This tool uses session cwd and never reads attachments, initializes IDX, or runs another model.",
      "Call create ONLY when the user explicitly asks to create a new project task. Never create tasks on your own initiative or convert your session todo plan into project tasks automatically.",
      "A task launch prompt explicitly authorizing final outcomes permits update to done after successful completion/verification or failed when the task could not be completed, only for its specified task id, without asking again. A transient error while retrying is not a final failure. Otherwise propose a status and wait for explicit user confirmation before updating it. Authorization for one task never permits status changes to other tasks.",
      "update accepts only status, priority, title and description; type, links, sessionId, id and createdAt cannot be changed. Omitted fields are preserved. An empty title requires a nonempty remaining description.",
      "Malformed, unsupported, redirected or oversized storage is an error, not permission to overwrite it. Missing storage lists as empty; only an explicit create initializes it. Successful writes preserve other task rows and fields in .pi/tasks.sqlite. Never directly edit task storage to bypass consent or validation.",
    ],
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "get", "update", "create"], description: "Operation; create only on explicit user request." },
        id: { type: "string", minLength: 1, maxLength: 128, description: "Required for get/update." },
        title: { type: "string", maxLength: 200, description: "create/update: may be empty only with nonempty description." },
        description: { type: "string", maxLength: 10000, description: "create/update: full description; omitted means preserve on update." },
        type: { type: "string", enum: [...TASK_TYPES], description: "list filter or required create type; not editable by update." },
        status: { type: "string", enum: [...TASK_STATUSES], description: "list filter or create/update value; create defaults to todo. Requires confirmation unless a task launch prompt explicitly authorizes final done/failed for this id." },
        priority: { type: "string", enum: [...TASK_PRIORITIES], description: "list filter or create/update value; create defaults to medium." },
      },
      required: ["op"],
      additionalProperties: false,
    },
    async execute(_id, params, signal, _update, ctx) {
      try {
        const response = await runProjectTasks(ctx.cwd, parseProjectTasksParams(params), signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: response };
      } catch (error) {
        return { content: [{ type: "text" as const, text: signal?.aborted ? "project_tasks cancelled."
          : error instanceof Error ? error.message : "project_tasks unavailable; check task storage and retry." }],
          isError: true, details: { valid: false, cancelled: signal?.aborted ?? false } };
      }
    },
  });
}
