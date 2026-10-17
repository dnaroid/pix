// Model-authored quick-choice blocks: a closed ```pix-actions fence whose body
// is a GFM task list. Rendered as checkboxes in the latest assistant message.

import type { TranscriptDisplayItem } from "./transcript-types";

export const CHOICE_ACTIONS_LANGUAGE = "pix-actions";
export const MIN_CHOICE_ACTIONS = 2;
export const MAX_CHOICE_ACTIONS = 8;
export const MAX_CHOICE_ACTION_CHARS = 300;
export const MAX_CHOICE_SUBMIT_LABEL_CHARS = 40;
export const DEFAULT_CHOICE_SUBMIT_LABEL = "Continue";

export interface ChoiceActionItem {
  readonly label: string;
  readonly checked: boolean;
}

export interface ChoiceActions {
  readonly submitLabel: string;
  readonly items: readonly ChoiceActionItem[];
}

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+?)\s*$/;

/**
 * Returns undefined for anything that is not a well-formed block, so the
 * caller can keep it as an ordinary (escaped) code fence.
 */
export function parseChoiceActions(info: string, body: string): ChoiceActions | undefined {
  const items: ChoiceActionItem[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(ITEM);
    if (!match?.[2] || match[2].length > MAX_CHOICE_ACTION_CHARS) return undefined;
    items.push({ label: match[2], checked: match[1] !== " " });
  }
  if (items.length < MIN_CHOICE_ACTIONS || items.length > MAX_CHOICE_ACTIONS) return undefined;
  const rawLabel = info.trim().replace(/^\S+\s*/, "").replace(/^(["'])(.*)\1$/, "$2").trim();
  const submitLabel = rawLabel && rawLabel.length <= MAX_CHOICE_SUBMIT_LABEL_CHARS
    ? rawLabel
    : DEFAULT_CHOICE_SUBMIT_LABEL;
  return { submitLabel, items };
}

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

/** The user message sent when the choices are submitted. */
export function choiceActionsPrompt(submitLabel: string, items: readonly ChoiceActionItem[], selected: readonly number[]): string {
  const lines = [...new Set(selected)]
    .filter((index) => index >= 0 && index < items.length)
    .sort((a, b) => a - b)
    .map((index) => `${index + 1}. ${items[index]!.label}`);
  if (!lines.length) throw new Error("Select at least one option.");
  return `${submitLabel}:\n${lines.join("\n")}`;
}
