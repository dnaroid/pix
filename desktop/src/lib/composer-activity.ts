import type { AgentControlState } from "./agent-control";
import { activityGroupHeading } from "./transcript-presentation";
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
  const heading = activityGroupHeading(entries.reverse());
  if (heading.active) return { action: heading.action, moreCount: heading.moreCount };
  // No evidence of a specific tool or thinking phase: don't invent one.
  return { action: "Working", moreCount: 0 };
}
