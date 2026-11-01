import {
  DEFAULT_CHOICE_SUBMIT_LABEL,
  MAX_CHOICE_ACTION_CHARS,
  MAX_CHOICE_BUTTONS,
  MAX_CHOICE_SUBMIT_LABEL_CHARS,
  type ChoiceActions,
  type ChoiceActionItem,
} from "../../../src/bundled-extensions/choice-actions/contract";

export const MAX_JSON_ACTIONS_CHARS = 16_384;

/** Narrow compatibility format, never an evaluator or a generic JSON menu. */
export function parseJsonChoiceActions(body: string): ChoiceActions | undefined {
  if (body.length > MAX_JSON_ACTIONS_CHARS || !body.trimStart().startsWith("[")) return undefined;
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { return undefined; } // Ordinary/incomplete JSON remains transcript text.
  if (!Array.isArray(value) || !value.length || value.length > MAX_CHOICE_BUTTONS) return undefined;
  const items: ChoiceActionItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("label") || !keys.includes("prompt")) return undefined;
    const { label, prompt } = entry;
    if (typeof label !== "string" || !label.trim() || label.length > MAX_CHOICE_SUBMIT_LABEL_CHARS || /[\r\n\u0000-\u001f\u007f]/.test(label)) return undefined;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_CHOICE_ACTION_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) return undefined;
    items.push({ label, prompt, checked: false });
  }
  return { submitLabel: DEFAULT_CHOICE_SUBMIT_LABEL, items, buttons: true };
}
