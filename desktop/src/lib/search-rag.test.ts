import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { linkRagCitations, ragAnswerParts, ragRequest, ragSource, retrieveRagHits, selectRagHits } from "./search-rag";
import type { SearchHit } from "./universal-search";

const code: SearchHit = { kind: "code", id: "code:src/a.ts:1-2", path: "src/a.ts", startLine: 1,
  endLine: 2, score: 0.8, title: "src/a.ts", snippet: "IDX match", content: "line from index" };
const task: SearchHit = { kind: "tasks", id: "tasks:1", taskId: "1", title: "Implement search",
  snippet: "done", score: 0.7 };
const commit: SearchHit = { kind: "commits", id: "commits:" + "a".repeat(40), hash: "a".repeat(40),
  title: "Add search", snippet: "previous implementation", score: 0.6,
  commit: { hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "Add search", author: "Dev", date: "2026-01-01" } };
const session: SearchHit = { kind: "sessions", id: "sessions:1", sessionId: "1", title: "Search discussion",
  snippet: "First and last", score: 0.5 };

describe("RAG client-side evidence and references", () => {
  it("preserves existing source identities and navigation targets across provider request", () => {
    expect(ragSource(code)).toMatchObject({ id: code.id, kind: "code", path: code.path, startLine: 1, endLine: 2,
      content: "line from index" });
    expect(ragSource(task)).toMatchObject({ id: task.id, kind: "tasks" });
    expect(ragSource(commit)).toMatchObject({ id: commit.id, hash: commit.hash });
    expect(ragSource(session)).toMatchObject({ id: session.id, sessionId: "1" });
    const value = ragRequest("/workspace", "why?", [code, task, commit, session], "test-owner-123");
    expect(value.sources.map(source => source.id)).toEqual([code.id, task.id, commit.id, session.id]);
  });

  it("keeps source diversity and existing relevance order", () => {
    const first = Array.from({ length: 8 }, (_, i) => ({ ...task, id: `tasks:${i}` }));
    expect(selectRagHits([...first, code, commit, session]).map(hit => hit.id))
      .toEqual(["tasks:0", "tasks:1", "tasks:2", "tasks:3", code.id, commit.id, session.id]);
    expect(selectRagHits([code, task], 1)).toEqual([code]);
  });

  it("only linkifies valid cited source numbers through safe internal markdown anchors", () => {
    const text = "Fixes **cancellation** [1]. Other reference [3] unavailable.";
    const markdown = linkRagCitations(text, 2);
    expect(markdown).toContain("[[1]](#pix-rag-source-1)");
    expect(markdown).toContain("[3]");
    const html = renderMarkdown(markdown, { headingAnchors: true });
    expect(html).toContain('data-markdown-anchor="pix-rag-source-1"');
    expect(html).not.toContain('data-markdown-anchor="pix-rag-source-3"');
    expect(html).toContain("<strong>cancellation</strong>");
    expect(ragAnswerParts("Answer [1] and [42].", 1))
      .toEqual([{ text: "Answer " }, { citation: 1 }, { text: " and [42]." }]);
  });

  it("retrieves the latest bounded search snapshot without independently opening files", async () => {
    const signal = new AbortController().signal;
    const updates: unknown[] = [];
    const selected = await retrieveRagHits(async onUpdate => {
      onUpdate({ results: [code, task], idxAvailable: true, notices: [] });
      return { results: [task], idxAvailable: true, notices: [] };
    }, signal, result => updates.push(result));
    expect(selected).toEqual([code, task]);
    expect(updates).toHaveLength(1);
  });
});
