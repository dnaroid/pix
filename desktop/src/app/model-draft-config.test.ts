import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createModelDraftConfig, type ModelConfigOptions } from "./model-draft-config.svelte";

function draftOptions(responses: Array<Record<string, unknown>>) {
  let index = 0;
  const draftConfigCalls: Array<{ modelRef?: string; refreshModelUsage: boolean }> = [];
  const client = {
    draftConfig: async (_cwd: string, selection?: { modelRef: string }, refreshModelUsage = false) => {
      draftConfigCalls.push({ modelRef: selection?.modelRef, refreshModelUsage });
      return responses[Math.min(index++, responses.length - 1)];
    },
  };
  const options = {
    client: () => client as unknown as AcpClient,
    workspace: () => "/workspace",
    statusReady: () => true,
    draftSessionTabOpen: () => true,
    draftSessionTabActive: () => true,
    reportError: () => {},
  } as unknown as ModelConfigOptions;
  return { options, draftConfigCalls };
}

describe("model draft config credential retry", () => {
  it("retries a credential-pending draft quota refresh once per interval, then stops", async () => {
    vi.useFakeTimers();
    try {
      const { options, draftConfigCalls } = draftOptions([
        { configOptions: [], modelUsageRefresh: "unavailable", modelUsageCredentialPending: true },
        { configOptions: [], modelUsageRefresh: "ready", modelUsage: {
          modelKey: "pi-claude-code-provider/claude-opus-5-5",
          provider: "anthropic",
          updatedAt: 1,
          hourly: { remainingPercent: 70, resetAt: 2, windowSeconds: 18_000 },
        } },
      ]);
      const config = createModelDraftConfig(options);
      await config.refreshUsage("pi-claude-code-provider/claude-opus-5-5", "medium");
      expect(config.runtimeStatus?.modelUsageRefresh).toBe("unavailable");

      vi.advanceTimersByTime(59_999);
      expect(draftConfigCalls).toHaveLength(1);
      vi.advanceTimersByTime(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(draftConfigCalls).toHaveLength(2);
      expect(config.runtimeStatus?.modelUsage?.hourly?.remainingPercent).toBe(70);

      // Ready without the flag: no further retries.
      vi.advanceTimersByTime(120_000);
      expect(draftConfigCalls).toHaveLength(2);
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry unavailability without the credential-pending flag and skips after reset", async () => {
    vi.useFakeTimers();
    try {
      const { options, draftConfigCalls } = draftOptions([
        { configOptions: [], modelUsageRefresh: "unavailable" },
      ]);
      const config = createModelDraftConfig(options);
      await config.refreshUsage("pi-claude-code-provider/claude-opus-5-5", "medium");
      vi.advanceTimersByTime(120_000);
      expect(draftConfigCalls).toHaveLength(1);
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending retry when the staged selection changes", async () => {
    vi.useFakeTimers();
    try {
      const { options, draftConfigCalls } = draftOptions([
        { configOptions: [], modelUsageRefresh: "unavailable", modelUsageCredentialPending: true },
        { configOptions: [], modelUsageRefresh: "unavailable" },
      ]);
      const config = createModelDraftConfig(options);
      await config.refreshUsage("pi-claude-code-provider/claude-opus-5-5", "medium");
      // The user restages a different model: the retry timer stays armed but
      // must not re-query the superseded selection when it fires.
      await config.refreshUsage("openai-codex/gpt-5.5", "high");
      vi.advanceTimersByTime(120_000);
      expect(draftConfigCalls).toHaveLength(2);
      expect(draftConfigCalls[1]?.modelRef).toBe("openai-codex/gpt-5.5");
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });
});
