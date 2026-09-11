import { describe, expect, it, vi } from "vitest";
import { AcpClient, type AcpExit, type AcpTransport, type AcpTransportHandlers } from "./acp-client";
import { PIX_SESSION_STATE_METHOD } from "./session-state";

class FakeTransport implements AcpTransport {
  handlers?: AcpTransportHandlers;
  readonly sent: string[] = [];

  async start(handlers: AcpTransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async send(line: string): Promise<void> {
    this.sent.push(line);
  }

  async stop(): Promise<void> {}

  message(value: unknown): void {
    this.handlers?.onLine(JSON.stringify(value));
  }

  exit(value: AcpExit): void {
    this.handlers?.onExit(value);
  }
}

function requestAt(transport: FakeTransport, index: number): Record<string, unknown> {
  return JSON.parse(transport.sent[index] ?? "null") as Record<string, unknown>;
}

async function startedClient(transport: FakeTransport, overrides: Record<string, unknown> = {}): Promise<AcpClient> {
  const client = new AcpClient(transport, {
    onSessionUpdate: vi.fn(),
    onElicitation: async () => ({ action: "cancel" }),
    ...overrides,
  });
  const starting = client.start();
  await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
  transport.message({ jsonrpc: "2.0", id: requestAt(transport, 0).id, result: { protocolVersion: 1, agentCapabilities: {} } });
  await starting;
  return client;
}

describe("ACP JSON-RPC client", () => {
  it("initializes before issuing typed session requests", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    const listing = client.listSessions("/workspace");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));

    expect(requestAt(transport, 0)).toMatchObject({ method: "initialize" });
    expect(requestAt(transport, 1)).toMatchObject({ method: "session/list", params: { cwd: "/workspace" } });
    transport.message({ jsonrpc: "2.0", id: requestAt(transport, 1).id, result: { sessions: [] } });
    await expect(listing).resolves.toEqual({ sessions: [] });
    await client.dispose();
  });

  it("requests Desktop new sessions with lazy runtime startup", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    const creating = client.newSession("/workspace");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));

    expect(requestAt(transport, 1)).toMatchObject({
      method: "session/new",
      params: {
        cwd: "/workspace",
        mcpServers: [],
        _meta: { "pix.lazyRuntime": true },
      },
    });
    transport.message({ jsonrpc: "2.0", id: requestAt(transport, 1).id, result: { sessionId: "new-1" } });
    await expect(creating).resolves.toEqual({ sessionId: "new-1" });
    await client.dispose();
  });

  it("routes Desktop enhance, import, and request-history helpers through private ACP methods", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);

    const enhancing = client.enhancePrompt("session-1", "make this clearer");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(requestAt(transport, 1)).toMatchObject({
      method: "pix/prompt/enhance",
      params: { sessionId: "session-1", draft: "make this clearer" },
    });
    transport.message({ jsonrpc: "2.0", id: requestAt(transport, 1).id, result: { prompt: "Clearer prompt" } });
    await expect(enhancing).resolves.toBe("Clearer prompt");

    const importing = client.importSession("session-1", "/tmp/import.jsonl");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(3));
    expect(requestAt(transport, 2)).toMatchObject({
      method: "pix/session/import",
      params: { sessionId: "session-1", path: "/tmp/import.jsonl" },
    });
    transport.message({ jsonrpc: "2.0", id: requestAt(transport, 2).id, result: { configOptions: [] } });
    await expect(importing).resolves.toEqual({ configOptions: [] });

    const history = client.requestHistory("session-1");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(4));
    expect(requestAt(transport, 3)).toMatchObject({
      method: "pix/request-history",
      params: { sessionId: "session-1" },
    });
    transport.message({ jsonrpc: "2.0", id: requestAt(transport, 3).id, result: { entries: ["one", "two"] } });
    await expect(history).resolves.toEqual(["one", "two"]);

    await client.dispose();
  });

  it("routes user-message branch lookup and actions through private ACP methods", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);

    const messages = client.branchUserMessages("session-1");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(requestAt(transport, 1)).toMatchObject({
      method: "pix/session/branch_user_messages",
      params: { sessionId: "session-1" },
    });
    transport.message({
      jsonrpc: "2.0",
      id: requestAt(transport, 1).id,
      result: { messages: [{ entryId: "entry-1", text: "same prompt" }] },
    });
    await expect(messages).resolves.toEqual([{ entryId: "entry-1", text: "same prompt" }]);

    const undo = client.userMessageAction("session-1", "entry-1", "undo");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(3));
    expect(requestAt(transport, 2)).toMatchObject({
      method: "pix/session/user_message_action",
      params: { sessionId: "session-1", entryId: "entry-1", action: "undo" },
    });
    transport.message({
      jsonrpc: "2.0",
      id: requestAt(transport, 2).id,
      result: { status: "warning", editorText: "same prompt", warning: "conflict" },
    });
    await expect(undo).resolves.toEqual({ status: "warning", editorText: "same prompt", warning: "conflict" });

    await client.dispose();
  });

  it("routes pause and continuation controls through the private ACP method", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);

    const pausing = client.agentControl("session-1", "pause");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(requestAt(transport, 1)).toMatchObject({
      method: "pix/session/agent_control",
      params: { sessionId: "session-1", action: "pause" },
    });
    transport.message({
      jsonrpc: "2.0",
      id: requestAt(transport, 1).id,
      result: { sessionId: "session-1", state: "pause-requested" },
    });
    await expect(pausing).resolves.toEqual({ sessionId: "session-1", state: "pause-requested" });

    const continuing = client.agentControl("session-1", "continue");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(3));
    expect(requestAt(transport, 2)).toMatchObject({
      method: "pix/session/agent_control",
      params: { sessionId: "session-1", action: "continue" },
    });
    transport.message({
      jsonrpc: "2.0",
      id: requestAt(transport, 2).id,
      result: { sessionId: "session-1", state: "idle" },
    });
    await expect(continuing).resolves.toEqual({ sessionId: "session-1", state: "idle" });

    await client.dispose();
  });

  it("requests and validates Desktop runtime status snapshots", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);

    const reading = client.runtimeStatus("session-1", true);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(requestAt(transport, 1)).toMatchObject({
      method: "pix/session/runtime_status",
      params: { sessionId: "session-1", refreshModelUsage: true },
    });
    const result = {
      sessionId: "session-1",
      context: { tokens: 128_000, contextWindow: 200_000, percent: 64 },
      dcpStats: "DCP Session Statistics:\nTokens saved (estimated): 12,000",
      modelUsageRefresh: "ready",
      modelUsage: {
        modelKey: "openai/gpt-5",
        provider: "openai",
        updatedAt: 1_757_590_400_000,
        accountEmail: "dev@example.com",
        hourly: { remainingPercent: 72, resetAt: 1_757_594_000_000, windowSeconds: 18_000, hasKnownWindowDuration: true },
        weekly: { remainingPercent: 44, resetAt: 1_758_195_200_000, windowSeconds: 604_800, hasKnownWindowDuration: true },
      },
    };
    transport.message({ jsonrpc: "2.0", id: requestAt(transport, 1).id, result });
    await expect(reading).resolves.toEqual(result);

    await client.dispose();
  });

  it("requests DCP statistics independently from periodic runtime status", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);

    const reading = client.dcpStats("session-1");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(requestAt(transport, 1)).toMatchObject({
      method: "pix/session/dcp_stats",
      params: { sessionId: "session-1" },
    });
    const result = {
      sessionId: "session-1",
      dcpStats: "DCP Session Statistics:\nTokens saved (estimated): 12,000",
    };
    transport.message({ jsonrpc: "2.0", id: requestAt(transport, 1).id, result });
    await expect(reading).resolves.toEqual(result);

    await client.dispose();
  });

  it("routes registry GUI actions through the private ACP registry method", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);

    const refreshing = client.registryAction("session-1", { action: "refresh" });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(requestAt(transport, 1)).toMatchObject({
      method: "pix/registry/action",
      params: { sessionId: "session-1", action: "refresh" },
    });
    transport.message({ jsonrpc: "2.0", id: requestAt(transport, 1).id, result: {} });
    await expect(refreshing).resolves.toBeUndefined();

    const updating = client.registryAction("session-1", { action: "update", type: "skill", name: "pdf" });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(3));
    expect(requestAt(transport, 2)).toMatchObject({
      method: "pix/registry/action",
      params: { sessionId: "session-1", action: "update", type: "skill", name: "pdf" },
    });
    transport.message({ jsonrpc: "2.0", id: requestAt(transport, 2).id, result: {} });
    await expect(updating).resolves.toBeUndefined();

    await client.dispose();
  });

  it("can request full session history explicitly for interactive jump", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    const history = client.sessionHistory("session-1", true);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(requestAt(transport, 1)).toMatchObject({
      method: "pix/session/history",
      params: { sessionId: "session-1", full: true },
    });
    transport.message({
      jsonrpc: "2.0",
      id: requestAt(transport, 1).id,
      result: { updates: [], deferredToolCallIds: [] },
    });
    await expect(history).resolves.toEqual({ updates: [], deferredToolCallIds: [] });
    await client.dispose();
  });

  it("handles streamed updates and form elicitation requests", async () => {
    const transport = new FakeTransport();
    const onSessionUpdate = vi.fn();
    const onElicitation = vi.fn(async () => ({ action: "accept" as const, content: { value: "yes" } }));
    const client = await startedClient(transport, { onSessionUpdate, onElicitation });

    transport.message({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } } },
    });
    transport.message({
      jsonrpc: "2.0",
      id: "dialog-1",
      method: "elicitation/create",
      params: { mode: "form", sessionId: "session-1", message: "Choose", requestedSchema: { type: "object" } },
    });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));

    expect(onSessionUpdate).toHaveBeenCalledOnce();
    expect(onElicitation).toHaveBeenCalledOnce();
    expect(requestAt(transport, 1)).toEqual({
      jsonrpc: "2.0",
      id: "dialog-1",
      result: { action: "accept", content: { value: "yes" } },
    });
    await client.dispose();
  });

  it("validates and dispatches private session-state notifications", async () => {
    const transport = new FakeTransport();
    const onSessionState = vi.fn();
    const client = await startedClient(transport, { onSessionState });

    transport.message({
      jsonrpc: "2.0",
      method: PIX_SESSION_STATE_METHOD,
      params: { sessionId: "session-1", channel: "pi-tools-suite:todo:state", data: { version: 1 } },
    });
    transport.message({
      jsonrpc: "2.0",
      method: PIX_SESSION_STATE_METHOD,
      params: { sessionId: "session-1", channel: "pi-tools-suite:async-subagents:live-state", data: { version: 1 } },
    });
    transport.message({
      jsonrpc: "2.0",
      method: PIX_SESSION_STATE_METHOD,
      params: { sessionId: "", channel: "pi-tools-suite:todo:state", data: {} },
    });

    expect(onSessionState).toHaveBeenCalledTimes(2);
    expect(onSessionState).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      channel: "pi-tools-suite:todo:state",
      data: { version: 1 },
    });
    expect(onSessionState).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      channel: "pi-tools-suite:async-subagents:live-state",
      data: { version: 1 },
    });
    await client.dispose();
  });

  it("rejects an active prompt when the adapter exits", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    const prompt = client.prompt("session-1", [{ type: "text", text: "hello" }]);
    transport.exit({ generation: 1, code: 1, success: false, requested: false, error: null });

    await expect(prompt).rejects.toThrow("pix-acp exited with code 1");
  });

  it("sends file-backed images as Pix metadata instead of embedding base64", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    const prompt = client.prompt(
      "session-1",
      [{
        type: "resource_link",
        uri: "file:///tmp/clipboard.png",
        name: "clipboard.png",
        mimeType: "image/png",
        size: 1024,
      }],
      [{
        uri: "file:///tmp/clipboard.png",
        mimeType: "image/png",
        size: 1024,
        name: "clipboard.png",
      }],
    );
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));

    const request = requestAt(transport, 1);
    expect(request).toMatchObject({
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        prompt: [{ type: "resource_link", uri: "file:///tmp/clipboard.png" }],
        _meta: {
          "pix.fileImages": [{ uri: "file:///tmp/clipboard.png", mimeType: "image/png", size: 1024 }],
        },
      },
    });
    expect(transport.sent[1]).not.toContain("base64");
    transport.message({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    await client.dispose();
  });

  it("allows a prompt to run longer than the default request timeout", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    vi.useFakeTimers();

    try {
      const prompt = client.prompt("session-1", [{ type: "text", text: "hello" }]);
      let settled = false;
      void prompt.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);

      transport.message({
        jsonrpc: "2.0",
        id: requestAt(transport, 1).id,
        result: { stopReason: "end_turn" },
      });
      await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    } finally {
      vi.useRealTimers();
      await client.dispose();
    }
  });

  it("requests a typed private autocomplete response", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    const completion = client.autocomplete("session-1", "implement");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));

    expect(requestAt(transport, 1)).toMatchObject({
      method: "pix/autocomplete",
      params: { sessionId: "session-1", draft: "implement" },
    });
    transport.message({
      jsonrpc: "2.0",
      id: requestAt(transport, 1).id,
      result: { completion: " the rest" },
    });

    await expect(completion).resolves.toBe(" the rest");
    await client.dispose();
  });

  it("loads private autocomplete scheduling settings", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    const settings = client.autocompleteSettings("session-1");
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));

    expect(requestAt(transport, 1)).toMatchObject({
      method: "pix/autocomplete/config",
      params: { sessionId: "session-1" },
    });
    transport.message({
      jsonrpc: "2.0",
      id: requestAt(transport, 1).id,
      result: { enabled: true, debounceMs: 425 },
    });

    await expect(settings).resolves.toEqual({ enabled: true, debounceMs: 425 });
    await client.dispose();
  });

  it("cancels an aborted autocomplete request over ACP", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    const controller = new AbortController();
    const completion = client.autocomplete("session-1", "implement", controller.signal);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(2));

    const requestId = requestAt(transport, 1).id;
    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(transport.sent).toHaveLength(3));
    expect(requestAt(transport, 2)).toEqual({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId },
    });

    transport.message({ jsonrpc: "2.0", id: requestId, result: { completion: " stale" } });
    await client.dispose();
  });
});
