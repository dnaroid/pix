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

type ChoiceBlock = { actions: ChoiceActions; blockIndex: number };

// Assistant messages are immutable snapshots: parse each one once instead of
// re-splitting the whole transcript on every streamed frame.
const choiceBlocksByMessage = new WeakMap<object, readonly ChoiceBlock[]>();

function choiceBlocks(item: object, text: string): readonly ChoiceBlock[] {
  let blocks = choiceBlocksByMessage.get(item);
  if (!blocks) {
    blocks = splitHtmlSandboxSegments(text, { actions: true })
      .filter((segment) => segment.type === "actions")
      .map((segment, blockIndex) => ({ actions: segment.actions, blockIndex }));
    choiceBlocksByMessage.set(item, blocks);
  }
  return blocks;
}

/** Derive receipts and their hidden source blocks from persisted text. */
export function choiceActionsPresentation(items: readonly TranscriptDisplayItem[]): {
  replies: ReadonlyMap<string, ChoiceActions>;
  answeredBlocks: ReadonlyMap<string, ReadonlySet<number>>;
} {
  const replies = new Map<string, ChoiceActions>();
  const answeredBlocks = new Map<string, Set<number>>();
  let candidates: { actions: ChoiceActions; messageId: string; blockIndex: number }[] = [];
  for (const item of items) {
    if (item.type !== "message") continue;
    if (item.role === "assistant") {
      candidates = choiceBlocks(item, item.text)
        .map(({ actions, blockIndex }) => ({ actions, messageId: item.id, blockIndex }));
    } else if (item.role === "user") {
      const matches = candidates.flatMap((candidate) => {
        const reply = replySelection(item.text, candidate.actions);
        return reply ? [{ ...candidate, reply }] : [];
      });
      // Ambiguous or missing source blocks stay ordinary Markdown.
      if (matches.length === 1) {
        const match = matches[0]!;
        replies.set(item.id, match.reply);
        const blocks = answeredBlocks.get(match.messageId) ?? new Set<number>();
        blocks.add(match.blockIndex);
        answeredBlocks.set(match.messageId, blocks);
      }
      candidates = [];
    }
  }
  return { replies, answeredBlocks };
}
