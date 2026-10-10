import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import type { SearchQueryResponse } from "../../../acp/src/search/contract";
import { previewInlineSearch, queryInlineSearch } from "./inline-search";
import type { InlineSearchClient } from "./inline-search";

const status = { enabled: false, sessionTitlesEnabled: false, keyAvailable: false, indexing: false };
const session = (sessionId: string, title: string): SessionInfo => ({ sessionId, title, cwd: "/workspace", updatedAt: "2026-10-10T01:00:00Z" });

describe("inline reuse of universal search", () => {
  it("previews authored settings with global BM25 synonyms and partial Russian terms, without config values", () => {
    expect(previewInlineSearch("settings", "авто-пополн").some(hit => hit.fieldId === "autocomplete-model")).toBe(true);
    expect(previewInlineSearch("settings", "AGENTS").some(hit => hit.fieldId === "ignore-context-files")).toBe(true);
    expect(previewInlineSearch("settings", "unlistedcredentialvalueX7")).toEqual([]);
    expect(previewInlineSearch("settings", " ")).toEqual([]);
  });

  it("previews current saved session titles, deduplicates IDs and supports prefixes", () => {
    const sessions = [session("a", "Обновление SDK"), session("b", "Fixing Git"), session("a", "Обновление SDK")];
    expect(previewInlineSearch("sessions", "обно", sessions).map(hit => hit.sessionId)).toEqual(["a"]);
    expect(previewInlineSearch("sessions", "b", sessions).map(hit => hit.sessionId)).toEqual(["b"]);
    expect(previewInlineSearch("sessions", "git", sessions).map(hit => hit.sessionId)).toEqual(["b"]);
  });

  it("submits the same local ACP source and authored catalog as global search without IDX/Auto/RAG", async () => {
    const client: InlineSearchClient = { searchQuery: vi.fn(async request => ({ status,
      results: request.types[0] === "settings"
        ? [{ kind: "settings" as const, id: "settings:autocomplete-model", title: "Autocomplete model", snippet: "", score: 0.9, fieldId: "autocomplete-model", section: "desktop-assistant" }]
        : [{ kind: "sessions" as const, id: "sessions:1", sessionId: "1", title: "Unrelated title", snippet: "First: interview", boundaryMatch: true, score: 0.7 }],
    })) };
    const signal = new AbortController().signal;
    const settings = await queryInlineSearch("settings", client, "/workspace", "авто-пополнение", signal);
    expect(settings.results[0]).toMatchObject({ kind: "settings", fieldId: "autocomplete-model" });
    expect(client.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace", query: "авто-пополнение", types: ["settings"], settings: expect.arrayContaining([
      expect.objectContaining({ id: "autocomplete-model", synonyms: expect.arrayContaining(["автодополнение"]) }),
    ]) }), signal);
    const sessions = await queryInlineSearch("sessions", client, "/workspace", "interview", signal);
    expect(sessions.results[0]).toMatchObject({ kind: "sessions", sessionId: "1", boundaryMatch: true });
    expect(client.searchQuery).toHaveBeenLastCalledWith(expect.objectContaining({ types: ["sessions"], query: "interview" }), signal);
    expect(settings.idxAvailable).toBe(false);
    expect(sessions.notices).toEqual([]);
  });

  it("never publishes a stale completion after request abort", async () => {
    let finish!: (result: Awaited<ReturnType<InlineSearchClient["searchQuery"]>>) => void;
    const client: InlineSearchClient = { searchQuery: vi.fn(() => new Promise<SearchQueryResponse>(resolve => { finish = resolve; })) };
    const owner = new AbortController();
    const update = vi.fn();
    const pending = queryInlineSearch("sessions", client, "/workspace", "SDK", owner.signal, update);
    await vi.waitFor(() => expect(client.searchQuery).toHaveBeenCalledTimes(1));
    const previousUpdates = update.mock.calls.length;
    owner.abort();
    finish({ status, results: [{ kind: "sessions", id: "sessions:old", sessionId: "old", title: "SDK", snippet: "", score: 1 }] });
    const result = await pending;
    expect(result.results).toEqual([]);
    expect(update).toHaveBeenCalledTimes(previousUpdates);
  });
});
