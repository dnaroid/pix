import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTaskCommands } from "./commands.js";
import { parseProjectTasksParams, runProjectTasks } from "./engine.js";
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from "./schema.js";
import { launchProjectTask } from "./launch.js";
import { diagnosticErrorType, suiteDiagnostics } from "../lib/suite-diagnostics.js";

export default function projectTasks(pi: ExtensionAPI): void {
  registerTaskCommands(pi);
  pi.registerTool({
    name: "project_tasks",
    label: "Project Tasks",
    description: "Read/write/run saved project tasks in cwd/.pi/tasks.sqlite (not session todo). list returns compact tasks with optional status/priority/type filters; get returns a full task by id. run requires id and an explicit user request: in Pix Desktop it uses Tasks Run to launch a separate session (including assigned model, linked plan and attachments), or opens an already-linked session without restarting it; returns sessionId and outcome started/opened before task completion. Other hosts reject run. After an interrupted launch inspect the task before retrying. update changes only status, priority, title and description, preserving type, links and sessionId. create requires type and title or description, defaults to todo/medium, and is allowed ONLY on an explicit user request to create a new task. Status changes require explicit user authorization: a task launch prompt may authorize final done/failed for its specific task id; otherwise ask for confirmation. Writes validate the version-1 SQLite schema and use transactions with optimistic revisions for only the targeted task. Deletion is user-only via /task delete, not available in this tool. Task text returned to the agent enters its model context.",
    promptSnippet: "Use project_tasks for saved project tasks, not session-local planning. Create only when the user explicitly requests a new task; run only when the user asks to execute an existing task in a separate Pix Desktop session. Status updates require confirmation unless the current task launch prompt explicitly authorizes final done/failed for that task id.",
    promptGuidelines: [
      "Use list/get to inspect current project tasks in session cwd. Use run with an existing task id only when the user asks to execute it: Pix Desktop starts a separate normal session using Tasks Run (assigned model, linked plan and attachments included), or opens the already-linked session without sending another prompt. It returns after launch, not after task completion. Other hosts reject run; do not bypass this by editing storage or launching shell processes. After cancellation or a transport error, inspect the task sessionId before retrying: launch may already have happened.",
      "Call create ONLY when the user explicitly asks to create a new project task. Never create tasks on your own initiative or convert your session todo plan into project tasks automatically.",
      "A task launch prompt explicitly authorizing final outcomes permits update to done after successful completion/verification or failed when the task could not be completed, only for its specified task id, without asking again. A transient error while retrying is not a final failure. Otherwise propose a status and wait for explicit user confirmation before updating it. Authorization for one task never permits status changes to other tasks.",
      "update accepts only status, priority, title and description; type, links, sessionId, id and createdAt cannot be changed. Omitted fields are preserved. An empty title requires a nonempty remaining description.",
      "Malformed, unsupported, redirected or oversized storage is an error, not permission to overwrite it. Missing storage lists as empty; only an explicit create initializes it. Successful writes preserve other task rows and fields in .pi/tasks.sqlite. Never directly edit task storage to bypass consent or validation.",
    ],
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "get", "update", "create", "run"], description: "Operation; create/run only on explicit user request. run starts or opens a task's Pix Desktop session." },
        id: { type: "string", minLength: 1, maxLength: 128, description: "Required for get/update/run." },
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
        const parsed = parseProjectTasksParams(params);
        const response = parsed.op === "run"
          ? { op: "run", id: parsed.id!, ...await launchProjectTask(parsed.id!, ctx.sessionManager.getSessionId(), signal) }
          : await runProjectTasks(ctx.cwd, parsed, signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: response };
      } catch (error) {
        if (!signal?.aborted) suiteDiagnostics.report("warn", "project-tasks", "project-tasks:tool-failed", ctx.cwd, { errorType: diagnosticErrorType(error) }, ctx);
        return { content: [{ type: "text" as const, text: signal?.aborted ? (params.op === "run"
          ? "Task launch cancelled; it may already have started. Inspect the task sessionId before retrying." : "project_tasks cancelled.")
          : error instanceof Error ? error.message : "project_tasks unavailable; check task storage and retry." }],
          isError: true, details: { valid: false, cancelled: signal?.aborted ?? false } };
      }
    },
  });
}
