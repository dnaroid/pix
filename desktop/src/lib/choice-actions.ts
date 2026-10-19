// Model-authored quick-choice blocks: a closed ```pix-actions fence whose body
// is a GFM task list. Rendered as checkboxes in the latest assistant message.
// The parser/prompt contract is shared with the Pix TUI.

import type { TranscriptDisplayItem } from "./transcript-types";

export {
  CHOICE_ACTIONS_LANGUAGE,
  DEFAULT_CHOICE_SUBMIT_LABEL,
  MAX_CHOICE_ACTION_CHARS,
  MAX_CHOICE_ACTIONS,
  MAX_CHOICE_SUBMIT_LABEL_CHARS,
  MIN_CHOICE_ACTIONS,
  choiceActionsPrompt,
  parseChoiceActions,
  type ChoiceActionItem,
  type ChoiceActions,
} from "../../../src/bundled-extensions/choice-actions/contract";

/** The final assistant reply, unless a user message follows it. */
export function latestAssistantMessageId(items: readonly TranscriptDisplayItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.type !== "message") continue;
    if (item.role === "user") return undefined;
    if (item.role === "assistant") return item.id;
  }
  return undefined;
}
