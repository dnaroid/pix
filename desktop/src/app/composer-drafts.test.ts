import { describe, expect, it } from "vitest";
import type { Attachment } from "../lib/attachments";
import { createComposerDraftStore } from "./composer-drafts";

function attachment(id: string): Attachment {
  return { id, name: `${id}.txt`, kind: "file", mimeType: "text/plain" };
}

describe("composer draft store", () => {
  it("isolates text and attachments per conversation owner", () => {
    let text = "session A";
    let attachments = [attachment("a")];
    const drafts = createComposerDraftStore({
      workspace: () => "/workspace",
      promptText: () => text,
      promptAttachments: () => attachments,
      setPromptText: (next) => { text = next; },
      replacePromptAttachments: (next) => { attachments = [...next]; },
    });

    drafts.switchTo("a", "b");
    expect(text).toBe("");
    expect(attachments).toEqual([]);

    text = "session B";
    attachments = [attachment("b")];
    drafts.switchTo("b", "a");
    expect(text).toBe("session A");
    expect(attachments.map((item) => item.id)).toEqual(["a"]);

    drafts.switchTo("a", "b");
    expect(text).toBe("session B");
    expect(attachments.map((item) => item.id)).toEqual(["b"]);
  });

  it("can reset a reused draft tab without leaking the previous draft", () => {
    let text = "old";
    let attachments = [attachment("old")];
    const drafts = createComposerDraftStore({
      workspace: () => "/workspace",
      promptText: () => text,
      promptAttachments: () => attachments,
      setPromptText: (next) => { text = next; },
      replacePromptAttachments: (next) => { attachments = [...next]; },
    });

    drafts.save("draft");
    text = "session";
    attachments = [];
    drafts.switchTo("session", "draft", { resetTarget: true });

    expect(text).toBe("");
    expect(attachments).toEqual([]);
  });
});
