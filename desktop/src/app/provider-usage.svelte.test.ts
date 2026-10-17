import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpClient, ModelUsageStatus } from "../lib/acp-client";
import { providerUsageTargets } from "../lib/provider-usage-targets";
import { createProviderUsageStore } from "./provider-usage.svelte";

type Response = Awaited<ReturnType<AcpClient["draftConfig"]>>;
function catalogue(refs = ["openai-codex/gpt", "anthropic/claude", "zai/glm"]): Response {
  return {
    configOptions: [{ id: "model", name: "Model", type: "select", currentValue: refs[0] ?? "", options: refs.map((value) => ({ value, name: value })) }],
    modelUsageRefresh: "skipped", modelRoutingEnabled: false, modelRoutingDefault: false,
  };
}
function quota(modelKey: string): ModelUsageStatus {
  return {
    provider: modelKey.startsWith("zai/") ? "zhipu" : modelKey.startsWith("anthropic/") ? "anthropic" : "openai",
    modelKey, updatedAt: Date.now(), hourly: { remainingPercent: 50, resetAt: Date.now() + 3_600_000, windowSeconds: 18_000 },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function setup() {
  const draftConfig = vi.fn<AcpClient["draftConfig"]>().mockImplementation(async (_cwd, selection) => selection
    ? { ...catalogue(), modelUsageRefresh: "ready", modelUsage: quota(selection.modelRef) }
    : catalogue());
  let client: Pick<AcpClient, "draftConfig"> | null = { draftConfig };
  let workspace = "/a";
  const reportError = vi.fn();
  const store = createProviderUsageStore({ client: () => client, workspace: () => workspace, reportError });
  return { store, draftConfig, reportError,
    setWorkspace: (next: string) => { workspace = next; },
    setClient: (next: typeof client) => { client = next; },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("provider quota targets", () => {
  it("queries all supported credential routes without querying every account-wide model", () => {
    const refs = ["openai-codex/gpt", "openai-codex/gpt-mini", "openai/gpt", "anthropic/claude", "pi-claude-code-provider/opus", "zai/glm", "zhipuai-coding-plan/glm", "google-antigravity/gemini", "google-antigravity/claude", "unknown/model"];
    expect(providerUsageTargets(catalogue(refs).configOptions).map((t) => t.modelRef)).toEqual(expect.arrayContaining(refs.filter((ref) => ref !== "openai-codex/gpt-mini" && ref !== "unknown/model")));
    expect(providerUsageTargets(catalogue(refs).configOptions)).toHaveLength(8);
  });
});

describe("panel-owned provider quota polling", () => {
  it("loads OpenAI, Anthropic and Z.ai without sessions or model selection changes", async () => {
    const { store, draftConfig } = setup();
    await store.refresh();
    expect(store.entries.map((entry) => entry.provider).sort()).toEqual(["anthropic", "openai", "zhipu"]);
    expect(store.entries.every((entry) => entry.state === "ready" && entry.runtime?.modelUsage)).toBe(true);
    for (const modelRef of ["openai-codex/gpt", "anthropic/claude", "zai/glm"]) {
      expect(draftConfig).toHaveBeenCalledWith("/a", { modelRef }, true);
    }
    expect(store.busy).toBe(false);
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps unavailable providers visible and isolates errors from successful providers", async () => {
    const { store, draftConfig, reportError } = setup();
    draftConfig.mockImplementation(async (_cwd, selection) => {
      if (!selection) return catalogue();
      if (selection.modelRef.startsWith("anthropic/")) throw new Error("request failed");
      if (selection.modelRef.startsWith("zai/")) return { ...catalogue(), modelUsageRefresh: "unavailable" };
      return { ...catalogue(), modelUsageRefresh: "ready", modelUsage: quota(selection.modelRef) };
    });
    await store.refresh();
    expect(store.entries.find((e) => e.provider === "anthropic")?.state).toBe("failed");
    expect(store.entries.find((e) => e.provider === "zhipu")?.state).toBe("unavailable");
    expect(store.entries.find((e) => e.provider === "openai")?.state).toBe("ready");
    expect(reportError).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("retains cached quotas after failed refreshes and polls only while open", async () => {
    const { store, draftConfig, reportError } = setup();
    await store.refresh();
    draftConfig.mockImplementation(async (_cwd, selection) => selection ? { ...catalogue(), modelUsageRefresh: "failed" } : catalogue());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(store.entries.every((entry) => entry.state === "failed" && entry.runtime?.modelUsage?.stale)).toBe(true);
    expect(draftConfig).toHaveBeenCalledTimes(8);
    expect(reportError).toHaveBeenCalledTimes(3);
    draftConfig.mockRejectedValue(new Error("catalogue failed"));
    await store.refresh();
    expect(store.error).toBe(true);
    expect(store.entries.every((entry) => entry.runtime?.modelUsage?.stale)).toBe(true);
    store.dispose();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(draftConfig).toHaveBeenCalledTimes(9);
  });

  it("coalesces refreshes and drops late quota results after workspace changes/disposal", async () => {
    const { store, draftConfig, setWorkspace, reportError } = setup();
    const late = deferred<Response>();
    draftConfig.mockImplementation((_cwd, selection) => selection ? late.promise : Promise.resolve(catalogue()));
    const old = store.refresh();
    expect(store.refresh()).toBe(old);
    await flush();
    expect(store.entries).toHaveLength(3);
    setWorkspace("/b");
    draftConfig.mockResolvedValue(catalogue([]));
    await store.refresh();
    expect(store.entries).toHaveLength(0);
    late.resolve({ ...catalogue(), modelUsageRefresh: "ready", modelUsage: quota("anthropic/claude") });
    await old;
    expect(store.entries).toHaveLength(0);
    expect(reportError).not.toHaveBeenCalled();
    const pendingCatalogue = deferred<Response>();
    draftConfig.mockReturnValue(pendingCatalogue.promise);
    const closing = store.refresh();
    store.dispose();
    pendingCatalogue.resolve(catalogue());
    await closing;
    expect(store.entries).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops old connection catalogues, clears data on disconnect and reports catalogue failures", async () => {
    const { store, draftConfig, setClient, reportError } = setup();
    const late = deferred<Response>();
    draftConfig.mockReturnValue(late.promise);
    const old = store.refresh();
    setClient({ draftConfig: vi.fn().mockResolvedValue(catalogue([])) });
    await store.refresh();
    late.resolve(catalogue());
    await old;
    expect(draftConfig).toHaveBeenCalledTimes(1);
    setClient({ draftConfig: vi.fn().mockRejectedValue(new Error("catalogue failed")) });
    await store.refresh();
    expect(store.error).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    setClient(null);
    await store.refresh();
    expect(store.entries).toHaveLength(0);
    expect(store.busy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    store.dispose();
  });

  it("bounds query concurrency and stops launching queued queries on close", async () => {
    const { store, draftConfig } = setup();
    const late = deferred<Response>();
    const refs = Array.from({ length: 8 }, (_, i) => `google-antigravity/model-${i}`);
    draftConfig.mockImplementation((_cwd, selection) => selection ? late.promise : Promise.resolve(catalogue(refs)));
    const loading = store.refresh();
    await flush();
    expect(draftConfig).toHaveBeenCalledTimes(4); // catalogue + three workers
    store.dispose();
    late.resolve(catalogue());
    await loading;
    expect(draftConfig).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries locally pending Claude Code credentials at one minute", async () => {
    const { store, draftConfig } = setup();
    draftConfig.mockResolvedValue({ ...catalogue(["pi-claude-code-provider/opus"]), modelUsageRefresh: "unavailable", modelUsageCredentialPending: true });
    await store.refresh();
    expect(draftConfig).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(draftConfig).toHaveBeenCalledTimes(4);
    store.dispose();
  });
});
