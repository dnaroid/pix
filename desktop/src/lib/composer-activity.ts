import type { AgentControlState } from "./agent-control";
import { activityEntryActive, toolEntryAction } from "./transcript-presentation";
import { toolPresentationName } from "./tool-presentation";
import type { ActivityEntry, TranscriptState } from "./transcript-types";

export interface ComposerActivity {
  readonly action: string;
  readonly moreCount: number;
}

/** Live, active-session presentation only. Never expose historical outcomes. */
export function composerActivity(
  transcript: TranscriptState,
  state: {
    sessionId: string | null;
    running: boolean;
    ready: boolean;
    historyLoading: boolean;
    draft: boolean;
    controlState: AgentControlState;
    waitingForInput: boolean;
  },
): ComposerActivity | undefined {
  if (!state.sessionId || !state.running || !state.ready || state.historyLoading || state.draft
    || state.controlState === "paused" || state.controlState === "continuable") return undefined;
  if (state.waitingForInput) return { action: "Waiting for input", moreCount: 0 };

  // Only the current turn: replayed pending calls before its user boundary
  // must not masquerade as the active session's current work.
  const entries: ActivityEntry[] = [];
  for (let index = transcript.items.length - 1; index >= 0; index -= 1) {
    const item = transcript.items[index];
    if (!item) continue;
    if (item.type === "message" && item.role === "user") break;
    if (item.type === "tool") entries.push(item);
    else if (item.role === "thought") entries.push({ ...item, role: "thought" });
  }
  // Preserve call order and every concurrent entry, even repeated actions.
  const actions = entries.reverse().filter(activityEntryActive).map((entry) => {
    if (entry.type !== "tool") return "Thinking";
    const context = activityContext(entry);
    const action = toolEntryAction(entry);
    return context ? `${action} · ${context}` : action;
  });
  if (actions.length) return { action: actions.join(" • "), moreCount: 0 };
  // No evidence of a specific tool or thinking phase: don't invent one.
  return { action: "Working", moreCount: 0 };
}

/** Only normalized metadata, never raw arguments, commands, URLs, or output. */
function activityContext(tool: Extract<ActivityEntry, { type: "tool" }>): string | undefined {
  if (tool.skillName) return safeLabel(tool.skillName);
  const name = toolPresentationName(tool);
  if (!["read", "read_file", "edit", "multiedit", "write", "apply_patch", "ast_apply",
    "create_file", "update_file", "delete_file", "remove_file", "move_file", "rename_file"].includes(name)
    && !["read", "edit", "mutation", "write"].includes(tool.kind)) return undefined;
  const path = tool.path;
  if (!path || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]|[?#]|:\/\//u.test(path)) return undefined;
  return safeLabel(path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1));
}

function safeLabel(value: string | undefined): string | undefined {
  if (!value || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) return undefined;
  return value.length > 64 ? `${value.slice(0, 61)}…` : value;
}
