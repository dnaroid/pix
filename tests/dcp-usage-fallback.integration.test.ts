import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { openLazySessionManager } from "../src/app/session/lazy-session-manager.js";
import { assistant, runtime, user } from "./helpers/dcp-runtime.js";

function useSdkUsage(f: Awaited<ReturnType<typeof runtime>>) {
  f.ctx.model = { ...f.ctx.model, contextWindow: 64_000 };
  // Exercise the installed SDK's actual estimator, not a reproduction of it.
  f.ctx.getContextUsage = () => AgentSession.prototype.getContextUsage.call({
    sessionManager: f.ctx.sessionManager, _limitsModel: () => f.ctx.model,
  } as any);
  const project = f.project;
  // Match ExtensionRunner.emitContext: ordinary hooks cannot see system deltas.
  f.project = () => project(f.ctx.sessionManager.buildSessionContext().messages
    .filter((message: any) => message.role !== "system"));
}

for (const stopReason of ["error", "aborted"] as const) {
  test(`SDK ${stopReason} retry fallback cannot resurrect DCP-compressed token pressure`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "dcp-usage-fallback-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const manager = SessionManager.create(dir, dir);
    const live = await runtime(manager);
    await live.emit("session_start", { reason: "new" });
    manager.appendMessage({ role: "system", content: "System instructions. ".repeat(800), timestamp: 0 });
    manager.appendMessage(user("Inspect the archive", 1));
    const start = manager.appendMessage(assistant("ARCHIVED_DETAILS ".repeat(24_000), 2));
    manager.appendMessage(user("Continue with the result", 3));
    await live.project();
    await live.tools.get("compress").execute("closed-work", {
      topic: "Archive inspection",
      messages: [{ messageId: live.state.messageIdsByStableId.get(`id:${start}`), summary: "Archive inspected successfully." }],
    }, undefined, undefined, live.ctx);
    const measured = assistant("Completed", 4);
    measured.usage = { ...measured.usage, input: 10_000, totalTokens: 10_000 };
    manager.appendMessage(measured);
    useSdkUsage(live);
    assert.equal(live.ctx.getContextUsage().tokens, 10_000);
    await live.project();
    const failed = manager.appendMessage({ ...assistant("Interrupted", 5), stopReason });
    manager.appendContextEdit(failed, null);
    assert.ok(live.ctx.getContextUsage().tokens > 64_000, "SDK fallback counts the unsqueezed archive");
    const blocks = structuredClone(live.state.compressionBlocks);
    const projection = await live.project();
    await live.send(projection);
    const diagnostics = manager.getBranch().filter((entry: any) => entry.customType === "dcp-diagnostic" && entry.data.event === "request");
    const diagnostic = diagnostics[diagnostics.length - 1] as any;
    assert.ok(diagnostic.data.snapshot.routineProjectedTokens < 15_000);
    assert.equal(diagnostic.data.snapshot.routineUsageAdjustmentTokens, 0);
    assert.deepEqual(live.state.compressionBlocks, blocks);
    assert.ok(!JSON.stringify(projection.messages).includes("ARCHIVED_DETAILS"));
    assert.equal(live.state.progressRecovery, undefined);

    for (let i = 0; i < 6; i++) manager.appendCustomEntry("padding", { i });
    for (const lazy of [false, true]) {
      await t.test(lazy ? "lazy resume" : "SDK resume", async () => {
        const reopened = lazy
          ? await openLazySessionManager(manager.getSessionFile()!, { cwdOverride: dir, tailEntryCount: 3 })
          : SessionManager.open(manager.getSessionFile()!, dir, dir);
        const resumed = await runtime(reopened);
        useSdkUsage(resumed);
        await resumed.emit("session_start", { reason: "resume" });
        await resumed.emit("before_agent_start", { systemPrompt: "fixture" });
        const restored = await resumed.project();
        await resumed.send(restored);
        assert.deepEqual(resumed.state.compressionBlocks, blocks);
        assert.ok(!JSON.stringify(restored.messages).includes("ARCHIVED_DETAILS"));
        assert.equal(resumed.state.progressRecovery, undefined);
      });
    }

    await t.test("system-only overhead invisible to the context hook still blocks", async () => {
      manager.appendMessage({ role: "system", content: "", timestamp: 6,
        sections: { policy: "Required system policy ".repeat(20_000) } });
      await assert.rejects(live.project(), /provider send aborted/);
      manager.appendMessage({ role: "system", content: "", timestamp: 7, sections: { policy: null } });
    });

    await t.test("genuinely oversized projected current task still blocks", async () => {
      const bigTask = manager.appendMessage(user("Required current task ".repeat(20_000), 6));
      await assert.rejects(live.project(), /provider send aborted/);
      manager.appendContextEdit(bigTask, null);
    });

    await t.test("genuine post-edit native pressure still blocks", async () => {
      const huge = assistant("Actual measured usage", 6);
      huge.usage = { ...huge.usage, input: 100_000, totalTokens: 100_000 };
      manager.appendMessage(huge);
      await assert.rejects(live.project(), /provider send aborted/);
    });
  });
}
