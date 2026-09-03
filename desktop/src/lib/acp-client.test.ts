import { describe, expect, it, vi } from "vitest";
import { AcpClient, type AcpExit, type AcpTransport, type AcpTransportHandlers } from "./acp-client";

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

  it("rejects an active prompt when the adapter exits", async () => {
    const transport = new FakeTransport();
    const client = await startedClient(transport);
    const prompt = client.prompt("session-1", [{ type: "text", text: "hello" }]);
    transport.exit({ generation: 1, code: 1, success: false, requested: false, error: null });

    await expect(prompt).rejects.toThrow("pix-acp exited with code 1");
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
});
