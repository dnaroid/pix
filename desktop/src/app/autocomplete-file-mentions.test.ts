import { describe, expect, it, vi } from "vitest";
import { createAutocompleteStore } from "./autocomplete.svelte";
import type { AcpClient } from "../lib/acp-client";

describe("workspace-owned file completion", () => {
  it("invalidates draft context when workspace changes and does not need LLM settings or a session", async () => {
    let workspace = "/one";
    const request = vi.fn().mockResolvedValue([{ path: "src/", directory: true }]);
    const store = createAutocompleteStore({
      client: () => ({ fileMentions: request }) as unknown as AcpClient,
      activeSessionId: () => null, settingsReady: () => false, promptReady: () => false,
      workspace: () => workspace,
    });
    const signal = new AbortController().signal;
    expect(store.fileMentionContextKey).toBe("/one");
    await store.fileMentions("sr", signal);
    expect(request).toHaveBeenLastCalledWith("/one", "sr", signal);
    workspace = "/two";
    expect(store.fileMentionContextKey).toBe("/two");
    await store.fileMentions("sr", signal);
    expect(request).toHaveBeenLastCalledWith("/two", "sr", signal);
  });
});
