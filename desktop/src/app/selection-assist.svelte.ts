import type { AcpClient } from "../lib/acp-client";
import type { SelectionAssistTarget } from "../lib/selection-assist-target";

export interface SelectionAssistOptions {
  client: () => AcpClient | null;
  workspace: () => string;
  report: (error: unknown, source?: string) => void;
}

export type SelectionAssistStatus = "idle" | "loading" | "streaming" | "done" | "error";

/** One popover at a time; a newer request or close aborts the previous one. */
export function createSelectionAssistStore(options: SelectionAssistOptions) {
  const state = $state({
    status: "idle" as SelectionAssistStatus,
    target: null as SelectionAssistTarget | null,
    result: "",
    error: "",
  });
  let controller: AbortController | null = null;

  function close(): void {
    controller?.abort();
    controller = null;
    state.status = "idle";
    state.target = null;
    state.result = "";
    state.error = "";
  }

  async function run(target: SelectionAssistTarget): Promise<void> {
    close();
    const client = options.client();
    const cwd = options.workspace();
    state.target = target;
    if (!client || !cwd) {
      state.status = "error";
      state.error = "Pix is not connected to a workspace.";
      return;
    }
    const own = new AbortController();
    controller = own;
    state.status = "loading";
    try {
      const text = await client.selectionAssist({
        cwd, action: target.action, text: target.text,
        ...(target.context ? { context: target.context } : {}),
        ...(target.path ? { path: target.path } : {}),
      }, own.signal, (delta) => {
        if (controller !== own) return;
        if ("reset" in delta) state.result = "";
        else state.result += delta.text;
        if (state.status === "loading" && state.result) state.status = "streaming";
        else if (!state.result) state.status = "loading";
      });
      if (controller !== own) return;
      state.result = text;
      state.status = "done";
    } catch (error) {
      if (controller !== own || own.signal.aborted) return;
      state.error = error instanceof Error ? error.message : String(error);
      state.status = "error";
      options.report(error, `frontend:selection-assist:${target.action}`);
    } finally {
      if (controller === own) controller = null;
    }
  }

  return { state, run, close };
}

export type SelectionAssistStore = ReturnType<typeof createSelectionAssistStore>;
