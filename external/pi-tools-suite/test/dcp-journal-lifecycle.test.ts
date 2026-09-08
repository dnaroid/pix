import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../src/dcp/config.js";
import dcpModule from "../src/dcp/index.js";
import { DCP_JOURNAL_CUSTOM_TYPE } from "../src/dcp/journal.js";

type Handler = (event: any, ctx: any) => any;

function quietConfig() {
  const config = loadConfig({ homeDir: "/__dcp_journal_lifecycle_fixture__" });
  config.debug = false;
  config.compress.minContextPercent = 0.99;
  config.compress.maxContextPercent = 0.995;
  config.compress.autoCandidates.enabled = false;
  config.compress.messageMode.enabled = false;
  config.compress.autoCompress.enabled = false;
  config.strategies.emergencyCurrentTurnPruning.enabled = false;
  return config;
}

function makeRuntime(manager: SessionManager, config = quietConfig()) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry(customType: string, data: unknown) { manager.appendCustomEntry(customType, data); },
    sendMessage() {},
  } as any;
  const ctx = {
    hasUI: false,
    cwd: manager.getCwd(),
    model: { provider: "test", id: "model", contextWindow: 100_000, maxTokens: 2_000 },
    sessionManager: manager,
    ui: { notify() {} },
    getContextUsage: () => ({ tokens: 2_000, contextWindow: 100_000, percent: 2 }),
  } as any;
  return { pi, handlers, tools, ctx, config };
}

type RuntimeFixture = ReturnType<typeof makeRuntime>;

async function initialize(runtime: RuntimeFixture, reason: "new" | "resume" | "fork" | "startup" = "new") {
  await dcpModule(runtime.pi, { config: runtime.config });
  await runtime.handlers.get("session_start")?.[0]?.({ type: "session_start", reason }, runtime.ctx);
}

async function project(runtime: RuntimeFixture) {
  const raw = runtime.ctx.sessionManager.buildSessionContext().messages;
  return await runtime.handlers.get("context")?.[0]?.({ type: "context", messages: raw }, runtime.ctx) as { messages: any[] };
}

function text(role: "user" | "assistant", content: string, timestamp: number) {
  if (role === "user") return { role, content, timestamp };
  return {
    role,
    content: [{ type: "text", text: content }],
    api: "openai-responses",
    provider: "test",
    model: "model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp,
  };
}

function journalEntries(manager: SessionManager) {
  return manager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === DCP_JOURNAL_CUSTOM_TYPE) as any[];
}

describe("DCP journal lifecycle", () => {
  test("new session persists exact projection decisions across restart and fork without a sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dcp-journal-lifecycle-"));
    try {
      const manager = SessionManager.create(dir, dir, { id: "journal-new" });
      const first = makeRuntime(manager);
      await initialize(first, "new");

      const firstUserId = manager.appendMessage(text("user", "old request with completed work", 1) as any);
      const oldAssistantId = manager.appendMessage(text("assistant", "diagnostic details ".repeat(500), 2) as any);
      manager.appendMessage(text("user", "current request must remain exact", 3) as any);

      const beforeCompression = await project(first);
      expect(journalEntries(manager).length).toBeGreaterThanOrEqual(2); // init + stable ID publication
      const oldAssistant = beforeCompression.messages.find((message: any) =>
        message.role === "assistant" && JSON.stringify(message.content).includes("diagnostic details"));
      expect(oldAssistant).toBeDefined();

      const statefulUser = beforeCompression.messages[0];
      const firstCarrier = JSON.stringify(statefulUser.content);
      expect(firstCarrier).toContain("m001=this user message");
      const currentCarrier = JSON.stringify(beforeCompression.messages.at(-1)?.content);
      const assistantIdMatch = currentCarrier.match(/(m\d+)=preceding assistant message/);
      expect(assistantIdMatch?.[1]).toBeDefined();

      const compress = first.tools.get("compress");
      await compress.execute(
        "journal-compress-call",
        {
          topic: "Completed diagnostics",
          messages: [{ messageId: assistantIdMatch![1], summary: "Diagnostics completed; no active issue remains from that output." }],
        },
        undefined,
        undefined,
        first.ctx,
      );

      const compressed = await project(first);
      expect(JSON.stringify(compressed.messages)).toContain("Diagnostics completed");
      const sessionFile = manager.getSessionFile();
      expect(sessionFile).toBeTruthy();
      const persistedText = readFileSync(sessionFile!, "utf8");
      expect(persistedText).toContain(`\"customType\":\"${DCP_JOURNAL_CUSTOM_TYPE}\"`);
      expect(persistedText).not.toContain("dcp-state/");

      const reopenedManager = SessionManager.open(sessionFile!, dir, dir);
      const reopened = makeRuntime(reopenedManager);
      await initialize(reopened, "resume");
      const afterRestart = await project(reopened);
      expect(afterRestart.messages).toEqual(compressed.messages);

      const journalBeforeNoop = journalEntries(reopenedManager).length;
      const retry = await project(reopened);
      expect(retry.messages).toEqual(afterRestart.messages);
      expect(journalEntries(reopenedManager)).toHaveLength(journalBeforeNoop);

      const forkFile = reopenedManager.createBranchedSession(reopenedManager.getLeafId()!);
      expect(forkFile).toBeTruthy();
      const forkManager = SessionManager.open(forkFile!, dir, dir);
      const fork = makeRuntime(forkManager);
      await initialize(fork, "fork");
      const forkProjection = await project(fork);
      expect(forkProjection.messages).toEqual(afterRestart.messages);
      expect(journalEntries(forkManager).length).toBe(journalEntries(reopenedManager).length);

      // Raw source entries remain in the session archive for session-recovery.
      expect(forkManager.getEntries().some((entry: any) => entry.id === firstUserId)).toBe(true);
      expect(forkManager.getEntries().some((entry: any) => entry.id === oldAssistantId)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pre-journal persisted sessions are not adopted or converted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dcp-journal-clean-break-"));
    try {
      const manager = SessionManager.create(dir, dir, { id: "old-session" });
      manager.appendMessage(text("user", "existing conversation", 1) as any);
      manager.appendMessage(text("assistant", "existing answer", 2) as any);

      const existing = makeRuntime(manager);
      await initialize(existing, "resume");
      const projected = await project(existing);
      expect(projected.messages).toEqual(manager.buildSessionContext().messages);
      expect(journalEntries(manager)).toHaveLength(0);
      await expect(existing.tools.get("compress").execute(
        "old-session-compress",
        { topic: "unsupported", messages: [{ messageId: "m001", summary: "no" }] },
        undefined,
        undefined,
        existing.ctx,
      )).rejects.toThrow(/new session/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
