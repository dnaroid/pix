// Model-authored quick-choice blocks: a closed ```pix-actions fence whose body
// is a GFM task list. Rendered as checkboxes; the latest one of a settled turn is interactive.
// The parser/prompt contract is shared with the Pix TUI.

export {
  CHOICE_ACTIONS_LANGUAGE,
  DEFAULT_CHOICE_SUBMIT_LABEL,
  MAX_CHOICE_ACTION_CHARS,
  MAX_CHOICE_ACTIONS,
  MAX_CHOICE_SUBMIT_LABEL_CHARS,
  MIN_CHOICE_ACTIONS,
  choiceActionsPrompt,
  type ChoiceActionItem,
  type ChoiceActions,
} from "../../../src/bundled-extensions/choice-actions/contract";

import { parseChoiceActions as parseChecklist, type ChoiceActions } from "../../../src/bundled-extensions/choice-actions/contract";
import { parseJsonChoiceActions } from "./choice-actions-json";

export function parseChoiceActions(info: string, body: string): ChoiceActions | undefined {
  return parseChecklist(info, body) ?? parseJsonChoiceActions(body);
}
