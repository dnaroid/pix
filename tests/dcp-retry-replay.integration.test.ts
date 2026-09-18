import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openLazySessionManager } from "../src/app/session/lazy-session-manager.js";
import { estimateMessageTokens } from "../external/pi-tools-suite/src/dcp/pruner-metadata.js";
import { user, assistant, runtime } from "./helpers/dcp-runtime.js";

for (const stopReason of ["error", "aborted"] as const) {
  test(`DCP restart/resume/fork replays a block across a persisted ${stopReason} attempt`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "dcp-retry-replay-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const manager = SessionManager.create(dir, dir);
    const live = await runtime(manager);
    await live.emit("session_start", { reason: "new" });
    manager.appendMessage(user("Keep the public API unchanged", 1));
    const start = manager.appendMessage(assistant("RAW_BEFORE_RETRY\n".repeat(4500), 2));
    const failed = { ...assistant("", 3), stopReason, errorMessage: "WebSocket closed 1006",
      content: [{ type: "thinking", thinking: "Unfinished attempt", thinkingSignature: "fixture-signature" },
        { type: "toolCall", id: "unexecuted-partial-call", name: "read", arguments: {} }],
    };
    const failedId = manager.appendMessage(failed);
    const end = manager.appendMessage(assistant("RAW_AFTER_RETRY\n".repeat(4500), 4));
    manager.appendMessage(user("Continue verification", 5));

    // SDK retry removes the failed assistant from agent.state.messages, not
    // from JSONL. Model that live input, then reopen through the actual SDK.
    const liveMessages = manager.buildSessionContext().messages.filter((m: any) => m.stopReason !== stopReason);
    await live.project(liveMessages);
    const beforeCommit = manager.getLeafId()!;
    await live.tools.get("compress").execute("compress-closed-work", {
      topic: "Completed inspection",
      ranges: [{ startId: live.state.messageIdsByStableId.get(`id:${start}`),
        endId: live.state.messageIdsByStableId.get(`id:${end}`), summary: "Inspection completed; public API unchanged." }],
    }, undefined, undefined, live.ctx);
    const expected = await live.project(liveMessages);
    assert.equal(expected.messages.filter((m: any) => m._dcpOrigin === "block").length, 1);
    const blocks = structuredClone(live.state.compressionBlocks);
    const assignments = new Map(live.state.messageIdsByStableId);
    assert.ok(!blocks[0]!.mutationMembers!.some((member) => member.stableId === `id:${failedId}`));

    for (let i = 0; i < 8; i++) manager.appendCustomEntry("presentation-padding", { i });
    const parentFile = manager.getSessionFile()!;
    const parentBytes = readFileSync(parentFile, "utf8");
    const afterCommit = manager.getLeafId()!;

    for (const reason of ["startup", "resume", "fork"] as const) {
      await t.test(reason, async () => {
        const file = reason === "fork"
          ? SessionManager.open(parentFile, dir, dir).createBranchedSession(afterCommit)!
          : parentFile;
        const lazy = await openLazySessionManager(file, { cwdOverride: dir, tailEntryCount: 3 });
        assert.equal(lazy.getBranch().length, 3);
        const restoredMessages = lazy.buildSessionContext().messages;
        assert.ok(restoredMessages.some((m: any) => m.stopReason === stopReason));
        assert.ok(restoredMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0) > 32_000);
        const resumed = await runtime(lazy);
        resumed.ctx.model = { ...resumed.ctx.model, contextWindow: 32_000 };
        await resumed.emit("session_start", { reason });
        await resumed.emit("before_agent_start", { systemPrompt: "fixture" });
        const projection = await resumed.project();
        // A lost block would exceed capacity and abort before reaching send.
        assert.deepEqual(projection.messages, expected.messages);
        assert.deepEqual(resumed.state.compressionBlocks, blocks);
        assert.deepEqual(resumed.state.messageIdsByStableId, assignments);
        assert.equal(resumed.state.providerSeenToolIds.size, 0);
        assert.equal(resumed.state.consecutiveIgnoredNudges, 0);
        await resumed.send(projection);
        assert.ok(readFileSync(file, "utf8").includes(failedId));
        assert.ok(readFileSync(file, "utf8").includes("RAW_BEFORE_RETRY"));
      });
    }

    // Earlier forks do not gain authority from a later compression commit.
    const beforeFile = SessionManager.open(parentFile, dir, dir).createBranchedSession(beforeCommit)!;
    const before = await runtime(await openLazySessionManager(beforeFile, { cwdOverride: dir, tailEntryCount: 3 }));
    await before.emit("session_start", { reason: "fork" });
    const rawProjection = await before.project();
    assert.equal(before.state.compressionBlocks.length, 0);
    assert.match(JSON.stringify(rawProjection.messages), /RAW_BEFORE_RETRY/);
    assert.ok(!rawProjection.messages.some((m: any) => m.stopReason === stopReason));
    assert.ok(readFileSync(parentFile, "utf8").startsWith(parentBytes), "archive stays append-only");
  });
}
