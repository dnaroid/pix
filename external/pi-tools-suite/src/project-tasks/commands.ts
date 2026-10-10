import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseProjectTasksParams, runProjectTasks, type ProjectTasksParams } from "./engine.js";
import { object } from "./schema.js";
import { attachTaskFile } from "./attachments.js";

export const TASK_COMMAND_USAGE = `Usage:
/tasks list [JSON filters: status, priority, type]
/task get <id>
/task add <JSON: type, title and/or description; optional status, priority>
/task update <JSON: id plus title, description, status and/or priority>
/task delete <id>
/task attach <id> <relative-project-file>
Examples: /task add {"type":"idea","title":"Explore caching"}
/task update {"id":"TASK-1","status":"done"}
IDs may be JSON-quoted. Delete removes only the named task.`;

export function parseTaskCommand(command: "tasks" | "task", args: string): ProjectTasksParams {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  const action = match?.[1];
  const rest = match?.[2]?.trim() ?? "";
  const fail = (): never => { throw new Error(TASK_COMMAND_USAGE); };
  const json = (): Record<string, unknown> => {
    try { return object(JSON.parse(rest), "Task command JSON"); }
    catch { return fail(); }
  };
  let input: unknown;
  if (command === "tasks" && action === "list") {
    const fields = rest ? json() : {};
    if ("op" in fields) return fail();
    input = { op: "list", ...fields };
  } else if (command === "task" && (action === "get" || action === "delete") && rest) {
    let id = rest;
    if (rest.startsWith('"')) {
      try { id = JSON.parse(rest); } catch { return fail(); }
    }
    input = { op: action, id };
  } else if (command === "task" && (action === "add" || action === "update") && rest) {
    const fields = json();
    if ("op" in fields) return fail();
    input = { op: action === "add" ? "create" : "update", ...fields };
  } else return fail();
  return parseProjectTasksParams(input, true);
}

/** User-invoked only: never routes commands through a model or an automatic event. */
export function registerTaskCommands(pi: ExtensionAPI): void {
  for (const command of ["tasks", "task"] as const) {
    pi.registerCommand(command, {
      description: command === "tasks" ? "List saved project tasks: /tasks list [JSON filters]"
        : "Get/add/update/delete a saved task. Run /task for usage (JSON mutations).",
      handler: async (args, ctx) => {
        try {
          const attach = command === "task" ? /^attach\s+("(?:[^"\\\\]|\\\\.)*"|\S+)\s+([\s\S]+)$/.exec(args.trim()) : null;
          const response = attach
            ? await attachTaskFile(ctx.cwd, attach[1]!.startsWith('"') ? JSON.parse(attach[1]!) : attach[1]!, attach[2]!.startsWith('"') ? JSON.parse(attach[2]!) : attach[2]!, ctx.signal)
            : await runProjectTasks(ctx.cwd, parseTaskCommand(command, args), ctx.signal);
          ctx.ui.notify(JSON.stringify(response, null, 2), "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : "Task command failed; check storage and retry.", "error");
        }
      },
    });
  }
}
