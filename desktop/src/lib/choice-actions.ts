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
  parseChoiceActions,
  type ChoiceActionItem,
  type ChoiceActions,
} from "../../../src/bundled-extensions/choice-actions/contract";
