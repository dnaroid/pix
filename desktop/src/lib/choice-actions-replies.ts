import { choiceActionsPrompt, type ChoiceActions } from "./choice-actions";
import { splitHtmlSandboxSegments } from "./html-sandbox";
import type { TranscriptDisplayItem } from "./transcript-types";

function replySelection(text: string, actions: ChoiceActions): ChoiceActions | undefined {
  const lines = text.split("\n");
  if (lines.shift() !== `${actions.submitLabel}:` || !lines.length) return undefined;
  const selected: number[] = [];
  for (const line of lines) {
    const match = /^([1-8])\. (.+)$/.exec(line);
    if (!match) return undefined;
    const index = Number(match[1]) - 1;
    if (actions.items[index]?.label !== match[2]) return undefined;
    selected.push(index);
  }
  // Require the exact generated payload, not an arbitrary numbered user list.
  if (choiceActionsPrompt(actions.submitLabel, actions.items, selected) !== text) return undefined;
  return {
    submitLabel: actions.submitLabel,
    items: actions.items.map((item, index) => ({ ...item, checked: selected.includes(index) })),
  };
}

/** Derive a visual receipt from persisted conversation text, without rewriting it. */
export function choiceActionsReplies(items: readonly TranscriptDisplayItem[]): ReadonlyMap<string, ChoiceActions> {
  const replies = new Map<string, ChoiceActions>();
  let candidates: ChoiceActions[] = [];
  for (const item of items) {
    if (item.type !== "message") continue;
    if (item.role === "assistant") {
      candidates = splitHtmlSandboxSegments(item.text, { actions: true })
        .flatMap((segment) => segment.type === "actions" ? [segment.actions] : []);
    } else if (item.role === "user") {
      const matches = candidates.flatMap((actions) => {
        const reply = replySelection(item.text, actions);
        return reply ? [reply] : [];
      });
      // Ambiguous or missing source blocks stay ordinary Markdown.
      if (matches.length === 1) replies.set(item.id, matches[0]!);
      candidates = [];
    }
  }
  return replies;
}
