import {
  DEFAULT_CHOICE_SUBMIT_LABEL,
  MAX_CHOICE_ACTION_CHARS,
  MAX_CHOICE_BUTTONS,
  MAX_CHOICE_SUBMIT_LABEL_CHARS,
  type ChoiceActions,
  type ChoiceActionItem,
} from "../../../src/bundled-extensions/choice-actions/contract";

export const MAX_JSON_ACTIONS_CHARS = 16_384;

// Models sometimes wrap the entries as {"version":1,"actions":[...]} and add
// descriptive string fields. Those fields are accepted but never interpreted.
const OPTIONAL_ENVELOPE_ENTRY_KEYS = new Set(["id", "kind", "risk"]);

function envelopeActions(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const envelope = value as Record<string, unknown>;
  if (keys.length !== 2 || envelope.version !== 1 || !Array.isArray(envelope.actions)) return undefined;
  return envelope.actions;
}

/** Narrow compatibility format, never an evaluator or a generic JSON menu. */
export function parseJsonChoiceActions(body: string): ChoiceActions | undefined {
  const start = body.trimStart()[0];
  if (body.length > MAX_JSON_ACTIONS_CHARS || (start !== "[" && start !== "{")) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { return undefined; } // Ordinary/incomplete JSON remains transcript text.
  const enveloped = !Array.isArray(parsed);
  const value = enveloped ? envelopeActions(parsed) : parsed;
  if (!Array.isArray(value) || !value.length || value.length > MAX_CHOICE_BUTTONS) return undefined;
  const items: ChoiceActionItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    const extra = Object.keys(record).filter((key) => key !== "label" && key !== "prompt");
    if (!("label" in record) || !("prompt" in record)) return undefined;
    if (extra.some((key) => !enveloped || !OPTIONAL_ENVELOPE_ENTRY_KEYS.has(key)
      || typeof record[key] !== "string" || (record[key] as string).length > MAX_CHOICE_SUBMIT_LABEL_CHARS)) return undefined;
    const { label, prompt } = record;
    if (typeof label !== "string" || !label.trim() || label.length > MAX_CHOICE_SUBMIT_LABEL_CHARS || /[\r\n\u0000-\u001f\u007f]/.test(label)) return undefined;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_CHOICE_ACTION_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) return undefined;
    items.push({ label, prompt, checked: false });
  }
  return { submitLabel: DEFAULT_CHOICE_SUBMIT_LABEL, items, buttons: true };
}
