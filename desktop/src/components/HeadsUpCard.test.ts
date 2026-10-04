import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import HeadsUpCard from "./HeadsUpCard.svelte";

describe("Heads up card", () => {
  it("escapes findings and does not automatically open evidence or submit", () => {
    const html = render(HeadsUpCard, { props: {
      notice: { id: "note", title: '<img src=x onerror="evil()">', consequence: "<script>evil()</script>", evidence: [{ id: "entry", text: "<script>hidden()</script>" }], createdAt: 1, expiresAt: 30001 },
      snapshot: { version: 1, instanceId: "runtime", revision: 1, enabled: true, model: "provider/model", phase: "idle", checks: 1, inputTokens: 2, outputTokens: 3, notice: null },
      onFeedback: () => {}, onDiscuss: () => {},
    } }).body;
    expect(html).toContain("&lt;img"); expect(html).not.toContain("<script>"); expect(html).not.toContain("hidden()");
    expect(html).toContain('aria-expanded="false"'); expect(html).not.toContain('type="submit"');
  });
  it("exposes accessible previous/next controls and the selected position", () => {
    const notice = { id: "note-b", title: "B", consequence: "Second", evidence: [{ id: "entry", text: "Evidence" }], createdAt: 1, expiresAt: 30001 };
    const html = render(HeadsUpCard, { props: {
      notice,
      notices: [{ ...notice, id: "note-a" }, notice, { ...notice, id: "note-c" }],
      snapshot: { version: 1, instanceId: "runtime", revision: 1, enabled: true, model: "provider/model", phase: "idle", checks: 1, inputTokens: 2, outputTokens: 3, notice },
      onFeedback: () => {}, onDiscuss: () => {}, onNavigate: () => {},
    } }).body;
    expect(html).toContain("2 / 3");
    expect(html).toContain('aria-label="Previous observer notice"');
    expect(html).toContain('aria-label="Next observer notice"');
  });
});
