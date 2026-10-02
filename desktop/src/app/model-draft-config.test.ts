import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { ModelConfigOptions } from "./model-config-options";
import { createModelDraftConfig } from "./model-draft-config.svelte";

const claudeModel = "pi-claude-code-provider/claude-opus-5-5";
const readyUsage = {
  configOptions: [], modelUsageRefresh: "ready", modelUsage: {
    modelKey: claudeModel, provider: "anthropic", updatedAt: 1,
    hourly: { remainingPercent: 70, resetAt: 2, windowSeconds: 18_000 },
  },
};

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
  it("retries pending credentials faster, then returns to the regular cadence", async () => {
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

      // Ready without the flag: no further fast retries.
      vi.advanceTimersByTime(120_000);
      expect(draftConfigCalls).toHaveLength(2);
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fast-retry unavailability without the credential-pending flag", async () => {
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
      await vi.advanceTimersByTimeAsync(600_000);
      expect(draftConfigCalls).toHaveLength(1);
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
      // Restaging cancels the old route's fast retry.
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

describe("draft quota refresh lifecycle", () => {
  it("recovers an initial failed query at the five-minute interval", async () => {
    vi.useFakeTimers();
    try {
      const { options, draftConfigCalls } = draftOptions([
        { configOptions: [], modelUsageRefresh: "failed" }, readyUsage,
      ]);
      const config = createModelDraftConfig(options);
      await config.refreshUsage(claudeModel, "medium");
      await vi.advanceTimersByTimeAsync(299_999);
      expect(draftConfigCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(draftConfigCalls).toHaveLength(2);
      expect(config.runtimeStatus?.modelUsage?.hourly?.remainingPercent).toBe(70);
      config.reset();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves quota on failure but clears explicit unavailability", async () => {
    vi.useFakeTimers();
    try {
      const { options } = draftOptions([
        readyUsage, { configOptions: [], modelUsageRefresh: "failed" },
        { configOptions: [], modelUsageRefresh: "unavailable" },
      ]);
      const config = createModelDraftConfig(options);
      await config.refreshUsage(claudeModel, "medium");
      await vi.advanceTimersByTimeAsync(300_000);
      expect(config.runtimeStatus?.modelUsageRefresh).toBe("failed");
      expect(config.runtimeStatus?.modelUsage?.hourly?.remainingPercent).toBe(70);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(config.runtimeStatus?.modelUsage).toBeUndefined();
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain the previous route's quota after a failed model change", async () => {
    vi.useFakeTimers();
    try {
      const { options } = draftOptions([readyUsage, { configOptions: [], modelUsageRefresh: "failed" }]);
      const config = createModelDraftConfig(options);
      await config.refreshUsage(claudeModel, "medium");
      await config.refreshUsage("openai-codex/gpt-5.5", "high", true);
      expect(config.runtimeStatus?.modelUsage).toBeUndefined();
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the old credential timer with the new selection's fast retry", async () => {
    vi.useFakeTimers();
    try {
      const { options, draftConfigCalls } = draftOptions([
        { configOptions: [], modelUsageRefresh: "unavailable", modelUsageCredentialPending: true },
      ]);
      const config = createModelDraftConfig(options);
      await config.refreshUsage(claudeModel, "medium");
      await vi.advanceTimersByTimeAsync(30_000);
      await config.refreshUsage(claudeModel, "high", true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(draftConfigCalls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(draftConfigCalls).toHaveLength(3);
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when the draft closes", async () => {
    vi.useFakeTimers();
    try {
      const { options, draftConfigCalls } = draftOptions([readyUsage]);
      let open = true;
      options.draftSessionTabOpen = () => open;
      const config = createModelDraftConfig(options);
      await config.refreshUsage(claudeModel, "medium");
      open = false;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(draftConfigCalls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset invalidates an in-flight result and prevents it rearming polling", async () => {
    vi.useFakeTimers();
    try {
      const { options } = draftOptions([]);
      let resolve!: (value: typeof readyUsage) => void;
      const response = new Promise<typeof readyUsage>((done) => { resolve = done; });
      const client = { draftConfig: () => response } as unknown as AcpClient;
      options.client = () => client;
      const config = createModelDraftConfig(options);
      const pending = config.refreshUsage(claudeModel, "medium");
      config.reset();
      resolve(readyUsage);
      await pending;
      expect(config.runtimeStatus).toBeUndefined();
      expect(config.modelUsageRefreshing).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a rejected transport request without clearing displayed quota", async () => {
    vi.useFakeTimers();
    try {
      const { options } = draftOptions([]);
      const request = vi.fn().mockResolvedValueOnce(readyUsage)
        .mockRejectedValueOnce(new Error("transport unavailable")).mockResolvedValue(readyUsage);
      const client = { draftConfig: request } as unknown as AcpClient;
      options.client = () => client;
      const config = createModelDraftConfig(options);
      await config.refreshUsage(claudeModel, "medium");
      await vi.advanceTimersByTimeAsync(300_000);
      expect(config.runtimeStatus?.modelUsage?.hourly?.remainingPercent).toBe(70);
      expect(config.modelUsageRefreshing).toBe(false);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(request).toHaveBeenCalledTimes(3);
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selecting Auto invalidates a pending response and its timer", async () => {
    vi.useFakeTimers();
    try {
      const { options } = draftOptions([]);
      let resolve!: (value: typeof readyUsage) => void;
      const response = new Promise<typeof readyUsage>((done) => { resolve = done; });
      const request = vi.fn().mockResolvedValueOnce({
        configOptions: [{
          id: "model", type: "select", name: "Model", currentValue: claudeModel,
          options: [{ value: claudeModel, name: "Claude" }],
        }], modelUsageRefresh: "skipped", modelRoutingEnabled: true, modelRoutingDefault: false,
      }).mockImplementation(() => response);
      const client = { draftConfig: request } as unknown as AcpClient;
      options.client = () => client;
      const config = createModelDraftConfig(options);
      await config.refresh();
      expect(config.modelUsageRefreshing).toBe(true);
      config.applySelection("pix:auto", "off");
      resolve(readyUsage);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(config.runtimeStatus).toBeUndefined();
      expect(config.modelUsageRefreshing).toBe(false);
      expect(request).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores superseded replies without cancelling the new selection's timer", async () => {
    vi.useFakeTimers();
    try {
      const { options } = draftOptions([]);
      let resolve!: (value: typeof readyUsage) => void;
      const response = new Promise<typeof readyUsage>((done) => { resolve = done; });
      const nextUsage = { ...readyUsage, modelUsage: { ...readyUsage.modelUsage, modelKey: "other/model" } };
      const request = vi.fn().mockImplementationOnce(() => response).mockResolvedValue(nextUsage);
      const client = { draftConfig: request } as unknown as AcpClient;
      options.client = () => client;
      const config = createModelDraftConfig(options);
      const previous = config.refreshUsage(claudeModel, "medium");
      await config.refreshUsage("other/model", "off", true);
      resolve(readyUsage);
      await previous;
      expect(config.runtimeStatus?.modelUsage?.modelKey).toBe("other/model");
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2]?.[1]?.modelRef).toBe("other/model");
      config.reset();
    } finally {
      vi.useRealTimers();
    }
  });
});
