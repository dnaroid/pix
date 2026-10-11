import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectLspBroker, type LspBrokerConnection } from "../src/lsp/broker-client";
import { lspBrokerEndpoint, lspProjectIdentity } from "../src/lsp/broker-identity";
import { receiveLspFrames, sendLspFrame } from "../src/lsp/broker-wire";

const describeBroker = process.platform === "win32" ? describe.skip : describe.serial;
describeBroker("LSP broker connection retirement", () => {
  async function fixture() {
    const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
    fs.mkdirSync(artifacts, { recursive: true });
    const project = fs.mkdtempSync(path.join(artifacts, "lsp-broker-client-tests-"));
    fs.mkdirSync(path.join(project, ".git"));
    const endpoint = lspBrokerEndpoint(lspProjectIdentity(project));
    const sockets = new Set<Socket>();
    let attaches = 0;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      receiveLspFrames(socket, (message) => {
        if (message.op === "attach") attaches++;
        sendLspFrame(socket, { id: message.id, result: true });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => { server.off("error", reject); resolve(); });
    });
    fs.chmodSync(endpoint, 0o600);
    return {
      project, endpoint, attaches: () => attaches,
      async close() {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  test("retries connect-phase resets before attaching, and destroys failed sockets", async () => {
    const f = await fixture();
    const createConnection = net.createConnection.bind(net);
    const failed: Socket[] = [];
    let attempts = 0;
    const connect = spyOn(net, "createConnection").mockImplementation((...args: Parameters<typeof net.createConnection>) => {
      attempts++;
      if (attempts > 3) return createConnection(...args);
      // Reproduce Linux rejecting the socket before its connect event, not an
      // RPC disconnect after connect (which the client already knows to retry).
      const socket = new net.Socket();
      failed.push(socket);
      queueMicrotask(() => socket.destroy(Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" })));
      return socket;
    });
    let connection: LspBrokerConnection | undefined;
    try {
      connection = await connectLspBroker(f.project);
      expect(attempts).toBe(4);
      expect(f.attaches()).toBe(1);
      expect(failed.every((socket) => socket.destroyed)).toBe(true);
      expect(await connection.rpc({ op: "inspect" })).toBe(true);
    } finally {
      connect.mockRestore();
      await connection?.close();
      await f.close();
    }
  });

  test("does not retry permanent connect errors", async () => {
    const f = await fixture();
    let attempts = 0;
    const connect = spyOn(net, "createConnection").mockImplementation(() => {
      attempts++;
      const socket = new net.Socket();
      queueMicrotask(() => socket.destroy(Object.assign(new Error("connect EACCES"), { code: "EACCES" })));
      return socket;
    });
    try {
      await expect(connectLspBroker(f.project)).rejects.toThrow("connect EACCES");
      expect(attempts).toBe(1);
      expect(f.attaches()).toBe(0);
    } finally {
      connect.mockRestore();
      await f.close();
    }
  });
});
