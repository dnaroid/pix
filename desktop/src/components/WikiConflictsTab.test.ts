import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import { createWikiConflictsInbox } from "../app/wiki-conflicts-inbox.svelte";
import type { WikiFinding } from "../lib/wiki-conflicts-index";
import type { WikiFindingsSnapshot } from "./wiki-consistency-tree-state.svelte";
import WikiConflictsList from "./WikiConflictsList.svelte";
import list from "./WikiConflictsList.svelte?raw";
import WikiConflictsTab from "./WikiConflictsTab.svelte";
import tab from "./WikiConflictsTab.svelte?raw";
import compareSource from "./WikiConflictCompare.svelte?raw";

const citation = (path: string, quote: string, startLine = 1, endLine = startLine): KnowledgeCitation => ({ path, quote, startLine, endLine });
const finding = (id: string, extra: Partial<WikiFinding> = {}): WikiFinding => ({
  id, kind: "conflict", internal: false,
  draft: citation("wiki/a.md", "Claim A."), existing: citation("wiki/b.md", "Claim B.", 3),
  explanation: "Rules differ.", reportPath: "wiki/a.md", checkedAt: "2026-10-30T00:00:00.000Z",
  current: true, modelRef: "test/judge", reportPaths: ["wiki/a.md"], stale: false, decisionPartial: false, ...extra,
});
const inboxFor = (snapshot: WikiFindingsSnapshot | null) => createWikiConflictsInbox({ snapshot: () => snapshot });
const tabHtml = (inbox: ReturnType<typeof inboxFor>, onShowList?: () => void) => render(WikiConflictsTab, { props: {
  inbox, read: async () => "", reportError: () => {}, onShowList,
} }).body;
const listHtml = (inbox: ReturnType<typeof inboxFor>) => render(WikiConflictsList, { props: { inbox, onReveal: () => {} } }).body;
const selected = (body: string) => body.match(/<div[^>]*role="option"[^>]*aria-selected="true"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";

describe("Wiki Conflicts sidebar list and comparison tab", () => {
  it("distinguishes no Wiki, scanning and a complete empty projection with a coverage caveat", () => {
    for (const html of [listHtml, tabHtml]) {
      expect(html(inboxFor(null))).toContain("This project has no Wiki configured.");
      expect(html(inboxFor({ findings: [], truncated: false, complete: false }))).toContain("Reading saved Wiki reports…");
      const empty = html(inboxFor({ findings: [], truncated: false, complete: true }));
      expect(empty).toContain("Saved reports contain no findings.");
      expect(empty).toContain("Only pages that have been checked are included.");
    }
  });

  it("lists findings in the sidebar and shows only the comparison in the tab", () => {
    const inbox = inboxFor({ complete: true, truncated: false, findings: [
      finding("one", { explanation: "First rule." }),
      finding("two", { explanation: "Second rule." }),
      finding("old", { explanation: "Old rule.", stale: true }),
    ] });
    const sidebar = listHtml(inbox);
    expect(selected(sidebar)).toContain("First rule.");
    expect(sidebar).not.toContain("Old rule.");
    expect(sidebar).toContain('role="listbox"');
    expect(sidebar).toMatch(/aria-activedescendant="[^"]+"/);

    const body = tabHtml(inbox, () => {});
    expect(body).toContain("data-wiki-conflict-compare");
    expect(body).not.toContain('role="listbox"');
    expect(body).toContain("1 of 2");
    expect(body).toContain("data-wiki-conflicts-show-list");
    inbox.move(1);
    expect(tabHtml(inbox)).toContain("2 of 2");
    expect(selected(listHtml(inbox))).toContain("Second rule.");
  });

  it("applies an entry request as a branch filter and shows a requested stale finding", () => {
    const inbox = inboxFor({ complete: true, truncated: false, findings: [
      finding("one", { explanation: "First rule." }),
      finding("two", { explanation: "Other rule.", draft: citation("docs/x.md", "X."), existing: citation("docs/y.md", "Y."), stale: true }),
    ] });
    inbox.apply({ path: "docs" });
    const branch = listHtml(inbox);
    expect(branch).toContain("data-wiki-branch-filter");
    expect(branch).not.toContain("First rule.");
    expect(branch).toContain("No findings match the selected filters.");
    inbox.apply({ findingId: "two" });
    expect(selected(listHtml(inbox))).toContain("Other rule.");
    inbox.reset();
    expect(inbox).toMatchObject({ branch: "", status: "open", kind: "all", groupBy: "pair" });
  });

  it("uses the saved report language and renders model prose as text", () => {
    const inbox = inboxFor({ complete: false, truncated: false, findings: [
      finding("ru", { reportLanguage: "ru", explanation: "<b>Правила</b> расходятся." }),
    ] });
    expect(tabHtml(inbox)).toContain("Противоречия Wiki");
    const body = listHtml(inbox);
    expect(body).not.toContain("<b>Правила</b>");
    expect(body).toContain("&lt;b>Правила&lt;/b> расходятся.");
    expect(body).toContain("Часть Wiki пока не прочитана");
  });

  it("shows the verdict bar only when decisions can be written, with the saved verdict and a partial warning", () => {
    const decided = finding("one", {
      decision: { findingId: "one", verdict: "false-positive", note: "Different modes.", at: "2026-10-30T01:00:00.000Z" },
      decisionPartial: true,
    });
    const inbox = inboxFor({ complete: true, truncated: false, findings: [decided] });
    inbox.apply({ findingId: "one" });
    expect(tabHtml(inbox)).not.toContain("data-wiki-decision-bar");
    const body = render(WikiConflictsTab, { props: {
      inbox, read: async () => "", reportError: () => {}, onDecide: async () => {},
    } }).body;
    expect(body).toContain("data-wiki-decision-bar");
    for (const verdict of ["side-a", "side-b", "different-scope", "false-positive", "deferred"]) {
      expect(body).toContain(`data-wiki-verdict="${verdict}"`);
    }
    expect(body).toContain("a.md is right");
    expect(body).toContain("b.md is right");
    expect(body).toMatch(/aria-pressed="true"[^>]*data-wiki-verdict="false-positive"/u);
    // The rationale is a permanent optional field (filled from the decision on mount); side buttons sit in the columns.
    expect(body).toContain("data-wiki-decision-note");
    expect(body).toContain("Optional: why this decision");
    expect(body).toContain("data-wiki-column-verdict");
    expect(body).toContain("data-wiki-clear-decision");
    expect(body).toContain("data-wiki-decision-partial");
  });

  it("offers «Create task» only for an unlinked deferred finding and «Open task» once it is linked", () => {
    const deferred = (extra: Record<string, string> = {}) => finding("one", {
      decision: { findingId: "one", verdict: "deferred", at: "2026-10-30T01:00:00.000Z", ...extra },
    });
    const body = (target: WikiFinding, tasks = true) => {
      const inbox = inboxFor({ complete: true, truncated: false, findings: [target] });
      inbox.apply({ findingId: "one" });
      return render(WikiConflictsTab, { props: {
        inbox, read: async () => "", reportError: () => {}, onDecide: async () => {},
        ...(tasks ? { onCreateTask: async () => {}, onOpenTask: () => {} } : {}),
      } }).body;
    };
    expect(body(deferred())).toContain("data-wiki-create-task");
    expect(body(deferred())).not.toContain("data-wiki-open-task");
    expect(body(deferred({ taskId: "task-1" }))).toContain("data-wiki-open-task");
    expect(body(deferred({ taskId: "task-1" }))).not.toContain("data-wiki-create-task");
    expect(body(deferred(), false)).not.toContain("data-wiki-create-task");
    expect(body(finding("one", { decision: { findingId: "one", verdict: "side-a", at: "2026-10-30T01:00:00.000Z" } })))
      .not.toContain("data-wiki-create-task");
  });

  it("wires inline editing, dates and reload after a saved edit", () => {
    expect(tab).toContain("if (saved) compare.reload()");
    expect(tab).toContain("draftDates={compare.draftDates}");
    expect(compareSource).toContain("data-wiki-edit-side");
    expect(compareSource).toContain("data-wiki-side-editor");
    expect(compareSource).toContain("!finding.stale && side.state === \"ready\" && side.block");
    expect(compareSource).toContain("data-wiki-side-dates");
  });

  it("keeps keyboard navigation inside one listbox tab stop and discards superseded reads", () => {
    expect(list).toContain('event.key === "j"');
    expect(list).toContain('event.key === "]"');
    expect(list).toContain('tabindex="-1"');
    expect(tab).toContain("onDestroy(compare.dispose)");
  });

  it("collects a basket of current findings, drops stale and vanished ones and clears on reset", () => {
    let findings = [finding("one", { draft: citation("wiki/a.md", "A."), existing: citation("wiki/b.md", "B.") }),
      finding("two", { draft: citation("wiki/a.md", "A2."), existing: citation("wiki/c.md", "C.") }),
      finding("old", { stale: true })];
    const inbox = createWikiConflictsInbox({ snapshot: () => ({ complete: true, truncated: false, findings }) });
    inbox.toggleBasket(findings[0]!);
    inbox.toggleBasket(findings[1]!);
    inbox.toggleBasket(findings[2]!);
    expect(inbox.basket.map(item => item.id)).toEqual(["one", "two"]);
    expect(inbox.basketPages).toBe(3);
    expect(inbox.inBasket(findings[2]!)).toBe(false);
    inbox.toggleBasket(findings[0]!);
    expect(inbox.basket.map(item => item.id)).toEqual(["two"]);
    inbox.toggleBasket(findings[0]!);
    inbox.clearBasket(["two"]);
    expect(inbox.basket.map(item => item.id)).toEqual(["one"]);
    inbox.reset();
    expect(inbox.basket).toEqual([]);
  });

  it("caps the basket at the batch limit", () => {
    const findings = Array.from({ length: 51 }, (_, index) => finding(`f${index}`));
    const inbox = createWikiConflictsInbox({ snapshot: () => ({ complete: true, truncated: false, findings }) });
    for (const item of findings) inbox.toggleBasket(item);
    expect(inbox.basket).toHaveLength(50);
    expect(inbox.basketFull).toBe(true);
    expect(inbox.inBasket(findings[50]!)).toBe(false);
  });

  it("renders basket checkboxes, summary and the batch action only when it can start", () => {
    const inbox = inboxFor({ complete: true, truncated: false, findings: [finding("one"), finding("two")] });
    expect(listHtml(inbox)).toContain("data-wiki-basket-toggle");
    expect(listHtml(inbox)).not.toContain("data-wiki-basket-summary");
    expect(tabHtml(inbox)).not.toContain("data-wiki-basket-bar");
    inbox.toggleBasket(inbox.findings[0]!);
    expect(listHtml(inbox)).toContain("Basket: 1 finding · 2 pages");
    const withAction = render(WikiConflictsTab, { props: {
      inbox, read: async () => "", reportError: () => {}, onResolveBasket: async () => null,
    } }).body;
    expect(withAction).toContain("data-wiki-basket-bar");
    expect(withAction).toContain("data-wiki-basket-resolve");
    expect(withAction).toContain("data-wiki-basket-toggle-compare");
    expect(tabHtml(inbox)).not.toContain("data-wiki-basket-resolve");
    expect(list).toContain('event.key === " "');
    expect(tab).toContain("inbox.clearBasket(outcome.sent)");
  });
});
