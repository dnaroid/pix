import { describe, expect, it } from "vitest";
import { choiceActionsPresentation, latestChoiceActionsMessageId } from "./choice-actions-replies";
import type { MessageItem } from "./transcript-types";

function message(id: string, role: MessageItem["role"], text: string): MessageItem {
  return { type: "message", id, role, text, attachments: [] };
}

const choiceActionsReplies = (items: MessageItem[]) => choiceActionsPresentation(items).replies;

const block = "```pix-actions Далее\n- [x] Первый\n- [ ] Второй\n- [ ] Третий\n```";
const source = message("a", "assistant", block);

describe("quick-choice visual replies", () => {
  it("hides the matched source block, including after history reload", () => {
    const items = [source, message("u", "user", "Далее:\n2. Второй")];
    for (const history of [items, JSON.parse(JSON.stringify(items))]) {
      const presentation = choiceActionsPresentation(history);
      expect(presentation.answeredBlocks.get("a")).toEqual(new Set([0]));
      expect(presentation.replies.has("u")).toBe(true);
    }
    expect(choiceActionsPresentation([source]).answeredBlocks.size).toBe(0);
  });

  it("keeps unanswered, altered and ambiguous source blocks visible", () => {
    const user = message("u", "user", "Далее:\n2. Второй");
    const other = block.replace("Далее", "Другое");
    const html = "```pix-html\n<p>Preview</p>\n```";
    const multiple = message("a", "assistant", `${html}\n${other}\n${block}`);
    expect(choiceActionsPresentation([multiple, user]).answeredBlocks.get("a")).toEqual(new Set([1]));
    expect(choiceActionsPresentation([source, message("u", "user", "Something else")]).answeredBlocks.size).toBe(0);
    expect(choiceActionsPresentation([message("a", "assistant", `${block}\n${block}`), user]).answeredBlocks.size).toBe(0);
    expect(choiceActionsPresentation([source, user, message("a2", "assistant", block)]).answeredBlocks.has("a2")).toBe(false);
  });

  it("shows actual selected and unselected items rather than recommended defaults", () => {
    const user = message("u", "user", "Далее:\n2. Второй\n3. Третий");
    expect(choiceActionsReplies([source, user]).get("u")).toEqual({
      submitLabel: "Далее",
      items: [
        { label: "Первый", checked: false },
        { label: "Второй", checked: true },
        { label: "Третий", checked: true },
      ],
    });
    expect(user.text).toBe("Далее:\n2. Второй\n3. Третий");
    // Reconstruction uses persisted text only, not the window's selection cache.
    expect(choiceActionsReplies(JSON.parse(JSON.stringify([source, user]))).get("u")?.items[0]?.checked).toBe(false);
  });

  it("does not convert ordinary lists, altered payloads or missing source blocks", () => {
    for (const text of [
      "Далее:\n2. Другой", "Другой заголовок:\n2. Второй", "Далее:\n2. Второй\nИ ещё",
      "Далее:\n2. Второй\n2. Второй", "Далее:\n3. Третий\n2. Второй", "Далее:\n9. Девятый", "Далее:",
    ]) {
      expect(choiceActionsReplies([source, message("u", "user", text)]).size).toBe(0);
    }
    expect(choiceActionsReplies([message("u", "user", "Далее:\n2. Второй")]).size).toBe(0);
  });

  it("matches only the latest checklist since the previous user message and the first reply", () => {
    const user = message("u", "user", "Далее:\n2. Второй");
    expect(choiceActionsReplies([source, message("s", "system", "notice"), user]).has("u")).toBe(true);
    expect(choiceActionsReplies([source, message("t", "thought", "thinking"), user]).has("u")).toBe(true);
    // A block-less reply after the checklist (the agent kept working) keeps it answerable.
    expect(choiceActionsReplies([source, message("a2", "assistant", "Different reply"), user]).has("u")).toBe(true);
    const otherBlock = block.replace("Далее", "Другое");
    expect(choiceActionsReplies([source, message("a2", "assistant", otherBlock), user]).size).toBe(0);
    expect(choiceActionsReplies([source, message("u0", "user", "Something else"), user]).size).toBe(0);
    expect(choiceActionsReplies([source, user, message("u2", "user", user.text)]).has("u2")).toBe(false);
  });

  it("handles multiple blocks but declines ambiguous matches", () => {
    const user = message("u", "user", "Далее:\n2. Второй");
    const other = block.replace("Далее", "Другое");
    expect(choiceActionsReplies([message("a", "assistant", `${other}\n${block}`), user]).has("u")).toBe(true);
    expect(choiceActionsReplies([message("a", "assistant", `${block}\n${block}`), user]).size).toBe(0);
  });

  it("keeps receipts independent across turns", () => {
    const replies = choiceActionsReplies([
      source, message("u", "user", "Далее:\n2. Второй"),
      message("a2", "assistant", block), message("u2", "user", "Далее:\n1. Первый"),
    ]);
    expect(replies.get("u")?.items.map((item) => item.checked)).toEqual([false, true, false]);
    expect(replies.get("u2")?.items.map((item) => item.checked)).toEqual([true, false, false]);
  });
});

describe("quick-choice presentation while streaming", () => {
  it("parses an unchanged assistant message once and re-parses a replaced snapshot", () => {
    const user = message("u", "user", "Далее:\n2. Второй");
    const first = choiceActionsPresentation([source, user]);
    const again = choiceActionsPresentation([source, user]);
    expect(again.answeredBlocks.get("a")).toEqual(first.answeredBlocks.get("a"));
    const edited = { ...source, text: block.replace("Далее", "Другое") };
    expect(choiceActionsPresentation([edited, user]).answeredBlocks.size).toBe(0);
  });

  it("keeps the latest checklist active when the agent keeps replying after it", () => {
    const tail = [source, message("t", "thought", "ran"), message("a2", "assistant", "Done, continuing.")];
    expect(latestChoiceActionsMessageId(tail)).toBe("a");
    expect(latestChoiceActionsMessageId([...tail, message("a3", "assistant", block)])).toBe("a3");
    expect(latestChoiceActionsMessageId([...tail, message("u", "user", "next")])).toBeUndefined();
    expect(latestChoiceActionsMessageId([source, message("u", "user", "x"), message("a2", "assistant", "plain")])).toBeUndefined();
    expect(latestChoiceActionsMessageId([message("a2", "assistant", "plain")])).toBeUndefined();
    const reply = message("u", "user", "Далее:\n2. Второй");
    expect(choiceActionsPresentation([...tail, reply]).answeredBlocks.get("a")).toEqual(new Set([0]));
  });
});
